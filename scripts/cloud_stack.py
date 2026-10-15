"""Local cloud stack for tests: the real control-plane Worker under `wrangler dev --local` (workerd, local D1, local
Queues, cron via /__scheduled) plus moto's S3 server standing in for private R2. Nothing here reaches Cloudflare."""
from __future__ import annotations

import hashlib
import os
import sys
import shutil
import socket
import sqlite3
import subprocess
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
CONTROL_PLANE = ROOT / "cloud" / "control-plane"
BUCKET = "menapoly-cue-media"
MiB = 1024 * 1024


def available() -> str | None:
    """Why the stack can't run here, or None."""
    if not (CONTROL_PLANE / "node_modules" / ".bin" / "wrangler").exists():
        return "cloud/control-plane dependencies not installed (cd cloud/control-plane && npm ci)"
    try:
        import moto  # noqa: F401
    except ImportError:
        return "moto not installed (pip install -r requirements-dev.txt)"
    if not shutil.which("npx"):
        return "Node.js not installed"
    return None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 90) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(url, timeout=2, trust_env=False).status_code < 500:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"{url} did not come up")


class Moto:
    def __init__(self, workdir: Path, new_session: bool = True):
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.log = (workdir / "moto.log").open("w")
        self.proc = subprocess.Popen([sys.executable, "-m", "moto.server", "-H", "127.0.0.1", "-p", str(self.port)],
                                     stdout=self.log, stderr=subprocess.STDOUT, start_new_session=new_session)
        wait_http(self.url + "/moto-api/")
        r = httpx.put(f"{self.url}/{BUCKET}", trust_env=False)
        assert r.status_code == 200, r.text

    def stop(self) -> None:
        _kill(self.proc)
        self.log.close()


class ControlPlane:
    def __init__(self, workdir: Path, s3_url: str | None, port: int = 0, new_session: bool = True, **vars: str):
        self.port, self.workdir = port or free_port(), workdir
        self.url = f"http://localhost:{self.port}"
        self.persist = workdir / "state"
        npx = shutil.which("npx")
        env = {**os.environ, "NO_PROXY": "*", "no_proxy": "*", "WRANGLER_SEND_METRICS": "false", "CI": "1"}
        subprocess.run([npx, "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", str(self.persist)],
                       cwd=CONTROL_PLANE, env=env, check=True, capture_output=True, timeout=120)
        settings = {"ENVIRONMENT": "development", "DEV_OWNER_EMAIL": "owner@example.test", "OWNER_EMAILS": "owner@example.test",
                    "EDITOR_EMAILS": "editor@example.test", "S3_BUCKET": BUCKET, "S3_REGION": "us-east-1",
                    "S3_ACCESS_KEY_ID": "local-test", "S3_SECRET_ACCESS_KEY": "local-test-secret"}
        if s3_url:
            settings["S3_ENDPOINT"] = s3_url
        settings.update(vars)
        args = [npx, "wrangler", "dev", "--local", "--test-scheduled", "--ip", "127.0.0.1", "--port", str(self.port),
                "--inspector-port", str(free_port()), "--persist-to", str(self.persist), "--show-interactive-dev-session=false"]
        for k, v in settings.items():
            if v is not None:
                args += ["--var", f"{k}:{v}"]
        self.log_path = workdir / "wrangler.log"
        self.log = self.log_path.open("w")
        # new_session=False keeps the children in the caller's process group, so a runner that kills the group
        # (e.g. Playwright's webServer) also stops them.
        self.proc = subprocess.Popen(args, cwd=CONTROL_PLANE, env=env, stdout=self.log, stderr=subprocess.STDOUT,
                                     start_new_session=new_session)
        try:
            wait_http(self.url + "/v1/health")
        except RuntimeError:
            self.stop()
            raise RuntimeError("wrangler dev did not start:\n" + self.log_path.read_text()[-3000:])
        self.http = httpx.Client(base_url=self.url, trust_env=False, timeout=60)

    # --- helpers -----------------------------------------------------------------------------------
    def api(self, method: str, path: str, json=None, user: str | None = None, headers: dict | None = None) -> httpx.Response:
        h = dict(headers or {})
        if user:
            h["x-dev-user"] = user
        return self.http.request(method, path, json=json, headers=h)

    def worker(self, method: str, path: str, token: str, json=None, lease: str | None = None) -> httpx.Response:
        h = {"authorization": f"Bearer {token}"}
        if lease:
            h["x-lease-token"] = lease
        return self.http.request(method, path, json=json or {}, headers=h)

    def scheduled(self) -> None:
        r = self.http.get("/__scheduled", params={"cron": "*/5 * * * *"})
        assert r.status_code == 200, r.text

    def db_path(self) -> Path:
        files = [p for p in (self.persist / "v3" / "d1").rglob("*.sqlite") if p.name != "metadata.sqlite"]
        assert len(files) == 1, files
        return files[0]

    def sql(self, query: str, params: tuple = ()) -> list[tuple]:
        """Direct access to the local D1 file: tests use it to simulate time passing (expired leases/links)."""
        with sqlite3.connect(self.db_path(), timeout=10) as con:
            rows = con.execute(query, params).fetchall()
            con.commit()
        return rows

    def stop(self) -> None:
        _kill(self.proc)
        self.log.close()


def _kill(proc: subprocess.Popen) -> None:
    """Stop a process and everything it started (npx, wrangler and its runtime)."""
    import psutil

    try:
        parent = psutil.Process(proc.pid)
        family = parent.children(recursive=True) + [parent]
    except psutil.NoSuchProcess:
        return
    for p in family:
        try:
            p.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(family, timeout=10)
    for p in alive:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass


def upload_file(cp: ControlPlane, project_id: str, path: Path | None = None, data: bytes | None = None,
                content_type: str = "video/mp4", name: str | None = None, part_size: int = 5 * MiB,
                stop_after_parts: int | None = None, user: str | None = None) -> dict:
    """Browser-equivalent upload: create session, PUT parts straight to storage via presigned URLs, complete."""
    data = data if data is not None else path.read_bytes()
    r = cp.api("POST", f"/v1/projects/{project_id}/uploads", user=user, json={
        "filename": name or path.name, "content_type": content_type, "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(), "part_size": part_size})
    assert r.status_code == 201, r.text
    session = r.json()
    put_parts(cp, session, data, range(1, session["part_count"] + 1)[:stop_after_parts], user=user)
    if stop_after_parts is not None:
        return session
    done = cp.api("POST", f"/v1/uploads/{session['id']}/complete", user=user)
    assert done.status_code == 200, done.text
    return {**session, **done.json()}


def put_parts(cp: ControlPlane, session: dict, data: bytes, parts, user: str | None = None) -> None:
    parts = list(parts)
    if not parts:
        return
    r = cp.api("POST", f"/v1/uploads/{session['id']}/parts", json={"parts": parts}, user=user)
    assert r.status_code == 200, r.text
    ps = session["part_size"]
    for item in r.json()["urls"]:
        n = item["part"]
        chunk = data[(n - 1) * ps:n * ps]
        res = httpx.put(item["url"], content=chunk, headers={"content-type": "application/octet-stream"}, trust_env=False, timeout=60)
        assert res.status_code == 200, res.text
