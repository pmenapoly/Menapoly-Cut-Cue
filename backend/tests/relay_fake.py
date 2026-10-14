"""In-process emulation of the MenapolyRelay endpoints the connector uses, with failure injection.

It mirrors app/api/os/route.ts (GET bundle, add_project) and app/api/uploads/route.ts (POST/PUT/PATCH/DELETE)
closely enough for idempotency tests. The real Relay is exercised separately in test_relay.py when
CUE_RELAY_TEST_URL points at a running Relay dev server.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from urllib.parse import parse_qs

import httpx


class FakeRelay:
    def __init__(self, workspace_id: str = "ws-1", member: str = "connector@menapoly.test", role: str = "editor"):
        self.workspace_id = workspace_id
        self.members = {member: role}
        self.projects: dict[str, dict] = {}
        self.versions: list[dict] = []
        self.sessions: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.fail_after_patch_commit = 0   # commit the version, then lose the response N times
        self.fail_part_once: set[int] = set()
        self.status_override: int | None = None
        self.add_project_returns_id = True

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _who(self, request: httpx.Request) -> str | None:
        if request.headers.get("CF-Access-Client-Id") == "client-id" and request.headers.get("CF-Access-Client-Secret") == "secret":
            return "connector@menapoly.test"
        return request.headers.get("oai-authenticated-user-email")

    def handle(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.calls.append((method, path))
        if self.status_override:
            return httpx.Response(self.status_override, json={"error": "forced"})
        user = self._who(request)
        if not user:
            return httpx.Response(401, json={"error": "Sign in required"})
        role = self.members.get(user)
        query = parse_qs(request.url.query.decode())
        if path == "/api/os" and method == "GET":
            if not role or query.get("workspace_id", [""])[0] != self.workspace_id:
                return httpx.Response(200, json={"workspace": None, "projects": [], "versions": []})
            return httpx.Response(200, json={"workspace": {"id": self.workspace_id}, "projects": list(self.projects.values()),
                                             "versions": self.versions})
        if path == "/api/os" and method == "POST":
            body = json.loads(request.content)
            if body.get("workspaceId") != self.workspace_id or not role:
                return httpx.Response(403, json={"error": "Workspace access denied"})
            if body["action"] == "add_project":
                if role not in ("owner", "admin", "bsm", "manager", "editor"):
                    return httpx.Response(403, json={"error": "Editor access required"})
                pid = str(uuid.uuid4())
                self.projects[pid] = {"id": pid, "name": body["name"], "description": body.get("description", "")}
                return httpx.Response(200, json={"ok": True, **({"projectId": pid} if self.add_project_returns_id else {})})
            return httpx.Response(400, json={"error": "Unknown action"})
        if path == "/api/uploads":
            if method == "POST":
                body = json.loads(request.content)
                if role not in ("owner", "admin", "bsm", "manager", "editor"):
                    return httpx.Response(403, json={"error": "Upload access denied"})
                if body["projectId"] not in self.projects:
                    return httpx.Response(404, json={"error": "Project not found"})
                sid = str(uuid.uuid4())
                self.sessions[sid] = {"body": body, "parts": {}, "status": "uploading", "user": user}
                return httpx.Response(200, json={"ok": True, "id": sid})
            sid = query.get("id", [""])[0] if method in ("PUT", "DELETE") else json.loads(request.content).get("id")
            session = self.sessions.get(sid)
            if not session or session["status"] != "uploading" or session["user"] != user:
                return httpx.Response(404, json={"error": "Upload session not found"})
            if method == "PUT":
                part = int(query["part"][0])
                if part in self.fail_part_once:
                    self.fail_part_once.discard(part)
                    raise httpx.ConnectError("simulated network drop")
                session["parts"][part] = request.content
                return httpx.Response(200, json={"ok": True, "partNumber": part, "etag": hashlib.md5(request.content).hexdigest()})
            if method == "DELETE":
                session["status"] = "aborted"
                return httpx.Response(200, json={"ok": True})
            if method == "PATCH":
                parts = json.loads(request.content)["parts"]
                data = b"".join(session["parts"][p["partNumber"]] for p in sorted(parts, key=lambda p: p["partNumber"]))
                if len(data) != session["body"]["size"]:
                    return httpx.Response(409, json={"error": "Uploaded file size did not match"})
                session["status"] = "complete"
                vid = str(uuid.uuid4())
                number = 1 + sum(1 for v in self.versions if v["project_id"] == session["body"]["projectId"])
                self.versions.append({"id": vid, "project_id": session["body"]["projectId"], "number": number,
                                      "file_name": session["body"]["fileName"], "size": len(data),
                                      "sha256": hashlib.sha256(data).hexdigest()})
                if self.fail_after_patch_commit:
                    self.fail_after_patch_commit -= 1
                    raise httpx.ReadTimeout("simulated lost response after commit")
                return httpx.Response(200, json={"ok": True, "assetId": str(uuid.uuid4()), "versionId": vid})
        return httpx.Response(404, json={"error": "not found"})
