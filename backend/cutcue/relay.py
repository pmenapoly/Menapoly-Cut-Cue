"""Relay connector: publish an approved Cut Cue render to the Cloudflare Menapoly Cue (MenapolyRelay) client portal.

Safety properties (each is tested in tests/test_relay.py, including against the real Relay app running locally):
- Runs only from an approved ``publish_to_relay`` action (``Cue.approve_action``); nothing here is called by AI or
  on a timer.
- One publication per (relay URL, workspace, render): a UNIQUE row plus an atomic claim, so concurrent or repeated
  approvals cannot upload twice.
- Deterministic remote file name ``cutcue-<render_id>-<sha256[:12]>.mp4``. Before every upload the remote project's
  versions are checked for that name, so a retry after a lost response reconciles instead of duplicating.
- Remote projects are matched by a ``cue-project:<id>`` marker in their description and linked once; a linked project
  that disappeared remotely is reported, never silently recreated.
- Only additive remote operations: create project, create version upload, abort *our own* unfinished upload session.
  Nothing remote is updated, overwritten or deleted.
- The render file is streamed from disk in 8 MB parts; no extra local copy is made.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from .db import new_id, now
from .services import BadRequest, NotFound, Services

log = logging.getLogger("cutcue.relay")

PART_SIZE = 8 * 1024 * 1024       # Relay accepts parts up to 16 MB; R2 needs >= 5 MB except the last part
STALE_CLAIM_S = 15 * 60           # an "uploading" claim older than this is considered abandoned
MARKER = "cue-project:"


class RelayError(RuntimeError):
    pass


@dataclass
class RelayConfig:
    url: str = ""
    workspace_id: str = ""
    client_id: str = ""
    client_secret: str = ""
    dev_identity: str = ""

    @property
    def is_local(self) -> bool:
        return (urlparse(self.url).hostname or "") in ("localhost", "127.0.0.1", "::1")

    @property
    def auth_mode(self) -> str | None:
        if self.client_id and self.client_secret:
            return "access-service-token"
        if self.dev_identity and self.is_local:
            return "local-dev-identity"
        return None

    @property
    def configured(self) -> bool:
        parsed = urlparse(self.url)
        secure = parsed.scheme == "https" or (parsed.scheme == "http" and self.is_local)
        return bool(self.url and self.workspace_id and self.auth_mode and secure)

    def problem(self) -> str | None:
        if not self.url or not self.workspace_id:
            return "Set CUE_RELAY_URL and CUE_RELAY_WORKSPACE_ID to connect the client portal."
        parsed = urlparse(self.url)
        if not (parsed.scheme == "https" or (parsed.scheme == "http" and self.is_local)):
            return "CUE_RELAY_URL must use https (http is only allowed for localhost testing)."
        if self.dev_identity and not self.is_local and not (self.client_id and self.client_secret):
            return "CUE_RELAY_DEV_IDENTITY only works with a localhost Relay. Use an Access service token."
        if not self.auth_mode:
            return "Set CUE_RELAY_ACCESS_CLIENT_ID and CUE_RELAY_ACCESS_CLIENT_SECRET (Cloudflare Access service token)."
        return None


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


class RelayConnector:
    def __init__(self, services: Services, config: RelayConfig, transport: httpx.BaseTransport | None = None):
        self.s = services
        self.db = services.db
        self.config = config
        self._transport = transport

    # --- status ----------------------------------------------------------------------------------------
    def status(self) -> dict:
        c = self.config
        return {"configured": c.configured, "problem": None if c.configured else c.problem(),
                "url": c.url or None, "workspace_id": c.workspace_id or None, "auth": c.auth_mode,
                "publications": self.publications(limit=20)}

    def publications(self, project_id: str | None = None, limit: int = 50) -> list[dict]:
        where, params = ("WHERE p.project_id = ?", [project_id]) if project_id else ("", [])
        return self.db.all(f"""SELECT p.*, x.name AS project_name FROM relay_publications p JOIN projects x ON x.id = p.project_id
                               {where} ORDER BY p.updated_at DESC LIMIT ?""", [*params, limit])

    # --- transport ---------------------------------------------------------------------------------------
    def _client(self) -> httpx.Client:
        c = self.config
        headers = {"Accept": "application/json", "User-Agent": "MenapolyCutCue-Relay/1"}
        if c.auth_mode == "access-service-token":
            headers["CF-Access-Client-Id"] = c.client_id
            headers["CF-Access-Client-Secret"] = c.client_secret
        elif c.auth_mode == "local-dev-identity":
            headers["oai-authenticated-user-email"] = c.dev_identity
        return httpx.Client(base_url=c.url, headers=headers, transport=self._transport, follow_redirects=False,
                            timeout=httpx.Timeout(300.0, connect=15.0))

    @staticmethod
    def _json(res: httpx.Response, what: str) -> dict:
        if res.status_code in (301, 302, 303, 307, 308):
            raise RelayError(f"{what}: Relay redirected to sign-in. Check the Access service token and that its Client ID "
                             "is listed in Relay's CF_ACCESS_SERVICE_TOKENS.")
        try:
            data = res.json()
        except ValueError:
            data = {}
        if res.status_code == 401:
            raise RelayError(f"{what}: Relay did not accept the connector's identity (401).")
        if res.status_code == 403:
            raise RelayError(f"{what}: the connector account lacks permission in that workspace (403): {data.get('error', '')}")
        if res.status_code >= 400:
            raise RelayError(f"{what} failed ({res.status_code}): {data.get('error', res.text[:200])}")
        return data

    def _bundle(self, http: httpx.Client) -> dict:
        data = self._json(http.get("/api/os", params={"workspace_id": self.config.workspace_id}), "Reading the workspace")
        ws = data.get("workspace") or {}
        if ws.get("id") != self.config.workspace_id:
            raise RelayError("The connector account is not a member of CUE_RELAY_WORKSPACE_ID. Invite it with the Editor role.")
        return data

    # --- projects ----------------------------------------------------------------------------------------
    def _remote_project(self, http: httpx.Client, project: dict) -> tuple[str, dict]:
        c = self.config
        marker = f"{MARKER}{project['id']}"
        bundle = self._bundle(http)
        remote = {p["id"]: p for p in bundle.get("projects", [])}
        link = self.db.one("SELECT * FROM relay_projects WHERE project_id = ?", [project["id"]])
        if link:
            if link["relay_url"] != c.url or link["workspace_id"] != c.workspace_id:
                raise RelayError("This project is linked to a different Relay workspace. Refusing to publish elsewhere.")
            if link["remote_project_id"] not in remote:
                raise RelayError("The linked client-portal project no longer exists in Relay. It was not recreated; "
                                 "unlink it in Settings if you want a new one.")
            return link["remote_project_id"], bundle
        found = [p for p in remote.values() if marker in str(p.get("description") or "")]
        if len(found) > 1:
            raise RelayError("More than one client-portal project carries this project's marker. Resolve it in Relay first.")
        if found:
            remote_id = found[0]["id"]
        else:
            created = self._json(http.post("/api/os", json={
                "action": "add_project", "workspaceId": c.workspace_id, "name": project["name"][:120], "projectType": "Video",
                "description": f"Published from Menapoly Cut Cue. {marker}"}), "Creating the client-portal project")
            remote_id = created.get("projectId")
            if not remote_id:  # older Relay without projectId in the response: find it by marker
                bundle = self._bundle(http)
                found = [p for p in bundle.get("projects", []) if marker in str(p.get("description") or "")]
                if len(found) != 1:
                    raise RelayError("Created the client-portal project but could not identify it. Nothing was uploaded.")
                remote_id = found[0]["id"]
            bundle = self._bundle(http)
        self.db.execute("""INSERT OR IGNORE INTO relay_projects (project_id, relay_url, workspace_id, remote_project_id, created_at)
                           VALUES (?, ?, ?, ?, ?)""", [project["id"], c.url, c.workspace_id, remote_id, now()])
        return remote_id, bundle

    def unlink_project(self, project_id: str) -> None:
        self.db.execute("DELETE FROM relay_projects WHERE project_id = ?", [project_id])

    # --- publishing ----------------------------------------------------------------------------------------
    def validate(self, project_id: str, render_id: str | None) -> dict:
        if not self.config.configured:
            raise BadRequest(self.config.problem() or "The client portal isn't connected.")
        if render_id:
            render = self.s.get_render(project_id, render_id)
        else:
            render = self.db.one("""SELECT * FROM renders WHERE project_id = ? AND status = 'succeeded'
                                    ORDER BY (quality = 'final') DESC, created_at DESC LIMIT 1""", [project_id])
            if not render:
                raise BadRequest("There is no finished render to publish yet.")
        if render["status"] != "succeeded" or not render.get("output_name"):
            raise BadRequest("That render hasn't finished, so it can't be published.")
        done = self.db.one("""SELECT * FROM relay_publications WHERE relay_url = ? AND workspace_id = ? AND render_id = ?
                              AND status = 'published'""", [self.config.url, self.config.workspace_id, render["id"]])
        if done:
            raise BadRequest("This render is already published to the client portal.")
        return render

    def publish(self, project_id: str, render_id: str) -> dict:
        c = self.config
        if not c.configured:
            raise RelayError(c.problem() or "The client portal isn't connected.")
        project = self.s.get_project(project_id)
        render = self.s.get_render(project_id, render_id)
        if render["status"] != "succeeded":
            raise RelayError("That render hasn't finished.")
        path = self.s.render_file(project_id, render_id, "mp4")
        sha = file_sha256(path)
        file_name = f"cutcue-{render_id}-{sha[:12]}.mp4"
        self.db.execute("""INSERT OR IGNORE INTO relay_publications (id, project_id, render_id, relay_url, workspace_id, sha256,
                           file_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)""",
                        [new_id("pub"), project_id, render_id, c.url, c.workspace_id, sha, file_name, now(), now()])
        pub = self.db.one("SELECT * FROM relay_publications WHERE relay_url = ? AND workspace_id = ? AND render_id = ?",
                          [c.url, c.workspace_id, render_id])
        if pub["status"] == "published":
            return {**pub, "already_published": True}
        if pub["sha256"] != sha:
            raise RelayError("The render file changed since it was first published. Refusing to publish different bytes "
                             "under the same render.")
        claimed = self.db.execute("""UPDATE relay_publications SET status = 'uploading', attempts = attempts + 1, error = NULL,
                                     updated_at = ? WHERE id = ? AND (status IN ('pending', 'failed')
                                     OR (status = 'uploading' AND updated_at < ?))""", [now(), pub["id"], now() - STALE_CLAIM_S])
        if claimed.rowcount != 1:
            raise RelayError("This render is already being published. Wait for that attempt to finish.")
        try:
            with self._client() as http:
                remote_pid, bundle = self._remote_project(http, project)
                self.db.update("relay_publications", "id", pub["id"], {"remote_project_id": remote_pid, "updated_at": now()})
                existing = [v for v in bundle.get("versions", [])
                            if v.get("project_id") == remote_pid and v.get("file_name") == file_name]
                if existing:  # an earlier attempt already got through: reconcile, never upload again
                    return self._done(pub["id"], existing[0]["id"], reconciled=True)
                if pub.get("remote_upload_id"):  # abandon our own unfinished session from a failed attempt
                    try:
                        http.delete("/api/uploads", params={"id": pub["remote_upload_id"]})
                    except httpx.HTTPError:
                        pass
                size = path.stat().st_size
                session = self._json(http.post("/api/uploads", json={
                    "workspaceId": c.workspace_id, "projectId": remote_pid, "kind": "version", "fileName": file_name,
                    "contentType": "video/mp4", "size": size}), "Starting the upload")
                upload_id = session["id"]
                self.db.update("relay_publications", "id", pub["id"], {"remote_upload_id": upload_id, "updated_at": now()})
                parts = []
                with path.open("rb") as fh:
                    number = 0
                    while chunk := fh.read(PART_SIZE):
                        number += 1
                        parts.append(self._put_part(http, upload_id, number, chunk))
                        self.db.update("relay_publications", "id", pub["id"], {"updated_at": now()})
                done = self._json(http.patch("/api/uploads", json={"id": upload_id, "parts": parts}), "Finishing the upload")
                version_id = done.get("versionId")
                if not version_id:
                    raise RelayError("Relay accepted the file but did not create a review version.")
                return self._done(pub["id"], version_id)
        except (RelayError, httpx.HTTPError, OSError) as exc:
            message = str(exc) if isinstance(exc, RelayError) else f"Network problem talking to Relay: {exc}"
            self.db.update("relay_publications", "id", pub["id"], {"status": "failed", "error": message[:500], "updated_at": now()})
            raise RelayError(message) from exc

    def _put_part(self, http: httpx.Client, upload_id: str, number: int, chunk: bytes) -> dict:
        last: Exception | None = None
        for _ in range(3):  # re-sending the same part number replaces it on Relay's side: safe to retry
            try:
                data = self._json(http.put("/api/uploads", params={"id": upload_id, "part": number}, content=chunk,
                                           headers={"Content-Type": "application/octet-stream"}), f"Uploading part {number}")
                return {"partNumber": data["partNumber"], "etag": data["etag"]}
            except httpx.TransportError as exc:
                last = exc
        raise RelayError(f"Uploading part {number} kept failing: {last}")

    def _done(self, pub_id: str, version_id: str, reconciled: bool = False) -> dict:
        self.db.update("relay_publications", "id", pub_id, {"status": "published", "remote_version_id": version_id,
                                                            "published_at": now(), "updated_at": now(), "error": None})
        row = self.db.one("SELECT * FROM relay_publications WHERE id = ?", [pub_id])
        return {**row, "already_published": False, "reconciled": reconciled}


__all__ = ["RelayConfig", "RelayConnector", "RelayError", "NotFound"]
