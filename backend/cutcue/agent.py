"""Menapoly Cue Mac worker agent: ``python -m cutcue.agent``.

Polls the cloud control plane outbound over HTTPS (no inbound ports, no router port forwarding), leases one job at
a time, downloads only that job's inputs through short-lived URLs, verifies their SHA-256, runs the existing Cut Cue
pipeline (FFmpeg analysis, Whisper transcription, podcast auto-edit, timeline render) in its own data directory,
uploads outputs through short-lived URLs, and reports the stage and measured progress. AI edits come back as
proposals that the owner approves in the cloud app; nothing is rendered from an unapproved edit.

Restart safety: the current lease is written to a state file. On start-up any lease left from a crash is released, so
the job goes back to the queue without waiting for the lease to expire. Completing a job is idempotent server-side, and
outputs use deterministic object keys, so a retried job never produces duplicate files.

Configuration (environment or .env):
  CUE_CLOUD_URL                 https://cue.example.com (http only for localhost)
  CUE_WORKER_TOKEN              cqw_... from the cloud app's Workers page (shown once)
  CUE_ACCESS_CLIENT_ID/SECRET   optional Cloudflare Access service token, if /v1/worker is behind Access
  CUE_AGENT_DATA_DIR            default ~/Library/Application Support/MenapolyCue/agent (macOS) or data/agent
  CUE_AGENT_POLL_SECONDS        default 15
  CUE_AGENT_MIN_FREE_MEM_GB     default 1.5 (don't take a job when less memory is available)
  CUE_AGENT_MIN_FREE_DISK_GB    default 5
  CUE_AGENT_NICE                default 10 (lower CPU priority so the Mac stays usable)
The transcriber, Whisper model, CPU threads and video encoder come from the usual CUTCUE_* settings.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
import os
import platform
import shutil
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import httpx
import psutil

from .config import load_settings
from .services import BadRequest, NotFound, Services
from .timeline import Timeline, TimelineError

log = logging.getLogger("cutcue.agent")
VERSION = "2026.10.0"
JOB_TYPES = ["transcribe", "auto_edit", "render"]
OUTPUT_TYPES = {".mp4": "video/mp4", ".srt": "application/x-subrip", ".wav": "audio/wav", ".json": "application/json",
                ".vtt": "text/vtt"}


class LeaseLost(Exception):
    """The control plane no longer considers this worker the job's holder (cancelled, expired or revoked)."""


class JobError(Exception):
    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


@dataclasses.dataclass
class AgentConfig:
    url: str
    token: str
    data_dir: Path
    access_client_id: str = ""
    access_client_secret: str = ""
    poll_seconds: float = 15.0
    min_free_mem_gb: float = 1.5
    min_free_disk_gb: float = 5.0
    nice: int = 10

    @classmethod
    def from_env(cls) -> "AgentConfig":
        load_settings()  # loads .env into the environment
        default_dir = (Path.home() / "Library/Application Support/MenapolyCue/agent" if sys.platform == "darwin"
                       else Path(__file__).resolve().parents[2] / "data" / "agent")
        return cls(url=os.environ.get("CUE_CLOUD_URL", "").rstrip("/"), token=os.environ.get("CUE_WORKER_TOKEN", ""),
                   data_dir=Path(os.environ.get("CUE_AGENT_DATA_DIR") or default_dir).expanduser(),
                   access_client_id=os.environ.get("CUE_ACCESS_CLIENT_ID", ""),
                   access_client_secret=os.environ.get("CUE_ACCESS_CLIENT_SECRET", ""),
                   poll_seconds=float(os.environ.get("CUE_AGENT_POLL_SECONDS") or 15),
                   min_free_mem_gb=float(os.environ.get("CUE_AGENT_MIN_FREE_MEM_GB") or 1.5),
                   min_free_disk_gb=float(os.environ.get("CUE_AGENT_MIN_FREE_DISK_GB") or 5),
                   nice=int(os.environ.get("CUE_AGENT_NICE") or 10))

    def problems(self) -> list[str]:
        out = []
        parsed = urlparse(self.url)
        local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
        if not self.url:
            out.append("CUE_CLOUD_URL is not set")
        elif parsed.scheme != "https" and not (parsed.scheme == "http" and local):
            out.append("CUE_CLOUD_URL must use https (plain http is only allowed for localhost testing)")
        if not self.token.startswith("cqw_"):
            out.append("CUE_WORKER_TOKEN is not set (register this Mac on the cloud app's Workers page)")
        return out


class CloudClient:
    def __init__(self, cfg: AgentConfig):
        headers = {"authorization": f"Bearer {cfg.token}", "user-agent": f"menapoly-cue-agent/{VERSION}"}
        if cfg.access_client_id and cfg.access_client_secret:
            headers["cf-access-client-id"] = cfg.access_client_id
            headers["cf-access-client-secret"] = cfg.access_client_secret
        self.http = httpx.Client(base_url=cfg.url, headers=headers, timeout=httpx.Timeout(30, connect=10),
                                 follow_redirects=False)
        self.storage = httpx.Client(timeout=httpx.Timeout(120, connect=15), follow_redirects=False)

    def post(self, path: str, body: dict | None = None, lease_token: str | None = None) -> tuple[int, Any]:
        headers = {"x-lease-token": lease_token} if lease_token else {}
        res = self.http.post(path, json=body or {}, headers=headers)
        if res.status_code in (401, 403):
            raise SystemExit(f"The control plane rejected this worker ({res.status_code}): {res.text[:200]}. "
                             "Check CUE_WORKER_TOKEN (it may have been revoked).")
        data = res.json() if res.content and res.headers.get("content-type", "").startswith("application/json") else None
        if res.status_code == 409 and isinstance(data, dict) and data.get("lease_lost"):
            raise LeaseLost(data.get("error", "lease lost"))
        if res.status_code >= 500:
            raise JobError(f"Control plane error {res.status_code}", retryable=True)
        return res.status_code, data


class Reporter:
    """Sends the current stage and measured progress; doubles as the lease keep-alive."""

    def __init__(self, client: CloudClient, job_id: str, token: str, every: float):
        self.client, self.job_id, self.token, self.every = client, job_id, token, every
        self.stage, self.progress = "starting", None
        self._sent: tuple | None = None
        self._last = 0.0
        self.lost = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def set(self, stage: str, progress: float | None = None) -> None:
        with self._lock:
            self.stage, self.progress = stage[:80], (None if progress is None else max(0.0, min(1.0, progress)))
        if (self.stage, self._rounded()) != self._sent and time.time() - self._last > 2:
            self.flush()

    def _rounded(self):
        return None if self.progress is None else round(self.progress, 2)

    def flush(self) -> None:
        if self.lost.is_set():
            raise LeaseLost("lease lost")
        with self._lock:
            stage, progress = self.stage, self.progress
        try:
            self.client.post(f"/v1/worker/jobs/{self.job_id}/progress", {"stage": stage, "progress": progress}, self.token)
            self._sent, self._last = (stage, self._rounded()), time.time()
        except LeaseLost:
            self.lost.set()
            raise
        except (httpx.HTTPError, JobError) as exc:  # a missed keep-alive is fine; the lease has slack
            log.warning("progress report failed: %s", exc)

    def _loop(self) -> None:
        while not self._stop.wait(1.0):
            if time.time() - self._last >= self.every:
                try:
                    self.flush()
                except LeaseLost:
                    return

    def stop(self) -> None:
        self._stop.set()


class Agent:
    def __init__(self, cfg: AgentConfig, services: Services | None = None, client: CloudClient | None = None):
        self.cfg = cfg
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = cfg.data_dir / "agent_state.json"
        self.downloads = cfg.data_dir / "downloads"
        self.downloads.mkdir(exist_ok=True)
        self.services = services or Services(dataclasses.replace(load_settings(), data_dir=cfg.data_dir / "cutcue"))
        self.settings = self.services.settings
        self.client = client or CloudClient(cfg)
        self.stop = threading.Event()
        self.state = self._load_state()
        self.current_local_project: str | None = None

    # --- state --------------------------------------------------------------------------------
    def _load_state(self) -> dict:
        try:
            state = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            state = {}
        state.setdefault("projects", {})
        state.setdefault("assets", {})
        state.setdefault("current", None)
        return state

    def _save_state(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=1))
        os.replace(tmp, self.state_path)

    # --- lifecycle ------------------------------------------------------------------------------
    def capabilities(self) -> list[str]:
        caps = ["ffmpeg", "render", "auto_edit"]
        if self.settings.transcriber != "none":
            caps.append(f"transcribe:{self.settings.transcriber}")
        return caps

    def recover(self) -> None:
        cur = self.state.get("current")
        if not cur:
            return
        log.info("releasing job %s left from a previous run", cur["job_id"])
        try:
            self.client.post(f"/v1/worker/jobs/{cur['job_id']}/release", {}, cur["lease_token"])
        except LeaseLost:
            pass  # already expired or reassigned: nothing to give back
        except (httpx.HTTPError, JobError) as exc:
            log.warning("could not release %s yet (%s); the lease will expire on its own", cur["job_id"], exc)
        self.state["current"] = None
        self._save_state()

    def heartbeat(self) -> None:
        self.client.post("/v1/worker/heartbeat", {"version": VERSION, "capabilities": self.capabilities()})

    def resources_ok(self) -> str | None:
        mem = psutil.virtual_memory().available / 1024**3
        if mem < self.cfg.min_free_mem_gb:
            return f"only {mem:.1f} GB memory available"
        disk = shutil.disk_usage(self.cfg.data_dir).free / 1024**3
        if disk < self.cfg.min_free_disk_gb:
            return f"only {disk:.1f} GB disk free"
        return None

    def run_once(self) -> bool:
        """Lease and process at most one job. True if a job was processed (succeeded, failed or released)."""
        busy = self.resources_ok()
        if busy:
            log.info("not taking work: %s", busy)
            return False
        status, lease = self.client.post("/v1/worker/lease", {"types": self.job_types()})
        if status == 204 or not lease:
            return False
        if status != 200:
            raise JobError(f"lease failed: {status} {lease}")
        self.process(lease)
        return True

    def job_types(self) -> list[str]:
        # Transcription is leased even when it's turned off here, so the job fails with the reason instead of waiting forever.
        return list(JOB_TYPES)

    def run_forever(self) -> None:
        self.recover()
        last_beat = 0.0
        while not self.stop.is_set():
            try:
                if time.time() - last_beat > 30:
                    self.heartbeat()
                    last_beat = time.time()
                if self.run_once():
                    continue
            except (httpx.HTTPError, JobError) as exc:
                log.warning("control plane unreachable or erroring: %s", exc)
            self.stop.wait(self.cfg.poll_seconds)

    # --- one job --------------------------------------------------------------------------------
    def process(self, lease: dict) -> None:
        job, token = lease["job"], lease["lease_token"]
        self.state["current"] = {"job_id": job["id"], "lease_token": token}
        self._save_state()
        reporter = Reporter(self.client, job["id"], token, every=max(10.0, lease.get("lease_seconds", 180) / 4))
        log.info("job %s (%s) attempt %s", job["id"], job["type"], job.get("attempt"))
        try:
            local_pid = self._local_project(job)
            self.current_local_project = local_pid
            handler: Callable = {"transcribe": self._transcribe, "auto_edit": self._auto_edit, "render": self._render}[job["type"]]
            outputs, extra = handler(job, lease, local_pid, reporter)
            reporter.set("uploading results")
            output_ids = [self._upload_output(job, token, path, reporter) for path in outputs]
            body = {"outputs": output_ids, **extra, "ai_usd": 0}  # the Mac pipeline makes no paid AI calls
            for attempt in range(5):
                try:
                    self.client.post(f"/v1/worker/jobs/{job['id']}/complete", body, token)
                    break
                except (httpx.HTTPError, JobError):
                    if attempt == 4:
                        raise
                    time.sleep(2 ** attempt)  # completing is idempotent, so retrying is safe
            log.info("job %s succeeded", job["id"])
        except LeaseLost:
            log.warning("job %s: lease lost (cancelled, expired or revoked); stopping", job["id"])
            self._cancel_local()
        except _Stopping:
            self._cancel_local()
            try:
                self.client.post(f"/v1/worker/jobs/{job['id']}/release", {}, token)
            except (LeaseLost, httpx.HTTPError, JobError):
                pass
        except Exception as exc:  # report every failure honestly; never pretend success
            retryable = exc.retryable if isinstance(exc, JobError) else not isinstance(exc, (BadRequest, NotFound, TimelineError))
            message = str(exc) or exc.__class__.__name__
            log.error("job %s failed: %s", job["id"], message)
            self._cancel_local()
            try:
                self.client.post(f"/v1/worker/jobs/{job['id']}/fail", {"error": message[:1900], "retryable": retryable}, token)
            except (LeaseLost, httpx.HTTPError, JobError) as rexc:
                log.warning("could not report failure: %s", rexc)
        finally:
            reporter.stop()
            self.current_local_project = None
            self.state["current"] = None
            self._save_state()

    def _check(self, reporter: Reporter) -> None:
        if self.stop.is_set():
            raise _Stopping()
        if reporter.lost.is_set():
            raise LeaseLost("lease lost")

    def _cancel_local(self) -> None:
        pid = self.current_local_project
        if not pid:
            return
        for j in self.services.db.all("SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued','running')", [pid]):
            try:
                self.services.cancel_job(pid, j["id"])
            except Exception:
                pass

    def _local_project(self, job: dict) -> str:
        pid = self.state["projects"].get(job["project_id"])
        if pid:
            try:
                self.services.get_project(pid)
                return pid
            except NotFound:
                pass
        pid = self.services.create_project(job.get("project_name") or job["project_id"])["id"]
        self.state["projects"][job["project_id"]] = pid
        self._save_state()
        return pid

    def _wait_local(self, local_pid: str, reporter: Reporter) -> None:
        """Wait for the local pipeline, relaying each local job's own message and measured progress."""
        while True:
            self._check(reporter)
            running = self.services.db.one(
                "SELECT message, progress, status FROM jobs WHERE project_id = ? AND status IN ('queued','running') "
                "ORDER BY status = 'running' DESC, created_at LIMIT 1", [local_pid])
            if not running:
                return
            reporter.set(running["message"] or "working",
                         running["progress"] if running["status"] == "running" else None)
            time.sleep(0.5)

    def _mirror(self, local_pid: str, inp: dict, reporter: Reporter) -> dict:
        """Bring one cloud input into the local project (download, verify SHA-256, ingest). Cached by cloud id."""
        known = self.state["assets"].get(inp["id"])
        if known:
            try:
                asset = self.services.get_asset(local_pid, known)
                if asset["status"] != "error":
                    return asset
            except NotFound:
                pass
        part = self.downloads / f"{inp['id']}.part"
        digest, got = hashlib.sha256(), 0
        with self.client.storage.stream("GET", inp["url"]) as res:
            if res.status_code != 200:
                raise JobError(f"Could not download {inp['name']} (storage said {res.status_code})")
            with part.open("wb") as fh:
                for chunk in res.iter_bytes(4 * 1024 * 1024):
                    self._check(reporter)
                    fh.write(chunk)
                    digest.update(chunk)
                    got += len(chunk)
                    reporter.set(f"downloading {inp['name']}", got / inp["size"] if inp["size"] else None)
        if got != inp["size"] or digest.hexdigest() != inp["sha256"]:
            part.unlink(missing_ok=True)
            raise JobError(f"{inp['name']} doesn't match the checksum recorded at upload; upload it again.", retryable=False)
        upload = self.services.init_upload(local_pid, inp["name"], got)
        os.replace(part, self.services._upload_part(upload))
        self.services.db.update("uploads", "id", upload["id"], {"received": got})
        asset = self.services.complete_upload(local_pid, upload["id"])
        self.state["assets"][inp["id"]] = asset["id"]
        self._save_state()
        return asset

    def _mirror_all(self, lease: dict, local_pid: str, reporter: Reporter) -> dict[str, str]:
        mapping = {inp["id"]: self._mirror(local_pid, inp, reporter)["id"] for inp in lease["inputs"]}
        self._wait_local(local_pid, reporter)
        for cloud_id, local_id in mapping.items():
            asset = self.services.get_asset(local_pid, local_id)
            if asset["status"] == "error":
                raise JobError(f"{asset['original_name']}: {asset.get('error') or 'could not be analysed'}", retryable=False)
        return mapping

    def _work_dir(self, job: dict) -> Path:
        d = self.cfg.data_dir / "outputs" / job["id"]
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _transcribe(self, job: dict, lease: dict, local_pid: str, reporter: Reporter):
        if self.settings.transcriber == "none":
            raise JobError("Transcription is turned off on this Mac (CUTCUE_TRANSCRIBER=none).", retryable=False)
        mapping = self._mirror_all(lease, local_pid, reporter)
        cloud_id, local_id = next(iter(mapping.items()))
        segments = self.services.transcript(local_id)
        if not segments:
            failed = self.services.db.one("SELECT error FROM jobs WHERE project_id = ? AND type = 'transcribe' AND status = 'failed' "
                                          "ORDER BY updated_at DESC LIMIT 1", [local_pid])
            raise JobError((failed or {}).get("error") or "No speech was found to transcribe.", retryable=bool(failed))
        out = self._work_dir(job) / "transcript.json"
        out.write_text(json.dumps({"asset_id": cloud_id, "engine": self.settings.transcriber, "segments": segments}))
        return [out], {"result": {"segments": len(segments), "engine": self.settings.transcriber,
                                  "duration": self.services.get_asset(local_pid, local_id).get("duration")}}

    def _auto_edit(self, job: dict, lease: dict, local_pid: str, reporter: Reporter):
        mapping = self._mirror_all(lease, local_pid, reporter)
        cloud_id, local_id = next(iter(mapping.items()))
        reporter.set("planning the edit")
        hook = self.services.best_hook(local_pid, local_id) if job["params"].get("hook") else None
        # Same validated path as the local editor: Services.create_proposal checks every clip against the media.
        proposal = self.services.auto_edit_proposal(local_pid, local_id, job["params"].get("options"), hook=hook,
                                                    created_by="cloud-worker")
        seq = proposal["plan"]["sequences"][0]
        timeline = dict(seq["timeline"])
        back = {v: k for k, v in mapping.items()}
        timeline["clips"] = [{**c, "asset_id": back[c["asset_id"]]} for c in timeline["clips"]]
        if (timeline.get("audio") or {}).get("music_asset_id"):
            timeline["audio"] = {**timeline["audio"], "music_asset_id": back.get(timeline["audio"]["music_asset_id"])}
        timeline["name"] = seq["name"]
        return [], {"timeline": timeline, "label": proposal["title"],
                    "result": {"rationale": proposal["rationale"], "duration": seq["duration"], "clips": seq["clip_count"]}}

    def _render(self, job: dict, lease: dict, local_pid: str, reporter: Reporter):
        mapping = self._mirror_all(lease, local_pid, reporter)
        params = job["params"]
        tl = dict(params["timeline"])
        try:
            tl["clips"] = [{**c, "asset_id": mapping[c["asset_id"]]} for c in tl["clips"]]
        except KeyError as exc:
            raise JobError(f"The approved edit uses a file that isn't part of this job ({exc})", retryable=False)
        audio = dict(tl.get("audio") or {})
        if audio.get("music_asset_id"):
            audio["music_asset_id"] = mapping.get(audio["music_asset_id"])
        tl["audio"] = audio
        timeline = Timeline(**{k: v for k, v in tl.items() if k != "name"})
        seq = self.services.create_sequence(local_pid, tl.get("name") or "Cloud edit")
        version = self.services.save_version(local_pid, seq["id"], timeline, f"Approved in cloud ({params['version_id']})", "cloud")
        preset = params.get("preset") or "youtube"
        render = (self.services.request_render(local_pid, version["id"], "preview") if preset == "preview"
                  else self.services.request_render(local_pid, version["id"], preset=preset))
        self._wait_local(local_pid, reporter)
        render = self.services.get_render(local_pid, render["id"])
        if render["status"] != "succeeded":
            raise JobError(render.get("error") or f"Render {render['status']}")
        outputs = []
        for kind in ("mp4", "srt", "wav"):
            try:
                path = self.services.render_file(local_pid, render["id"], kind)
            except NotFound:
                continue
            nice = self._work_dir(job) / f"{(tl.get('name') or 'edit')[:60].strip() or 'edit'}-{preset}{path.suffix}"
            shutil.copyfile(path, nice)
            outputs.append(nice)
        return outputs, {"result": {"preset": preset, "duration": render.get("duration"),
                                    "encoder": (render.get("info") or {}).get("encoder")}}

    def _upload_output(self, job: dict, token: str, path: Path, reporter: Reporter) -> str:
        ctype = OUTPUT_TYPES.get(path.suffix.lower())
        if not ctype:
            raise JobError(f"Unexpected output type {path.suffix}", retryable=False)
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
                digest.update(block)
        size = path.stat().st_size
        _, grant = self.client.post(f"/v1/worker/jobs/{job['id']}/outputs",
                                    {"name": path.name, "content_type": ctype, "size": size, "sha256": digest.hexdigest()}, token)
        if not grant or "url" not in grant:
            raise JobError(f"Could not get an upload URL for {path.name}: {grant}")
        reporter.set(f"uploading {path.name}")

        def body():
            sent = 0
            with path.open("rb") as fh:
                for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
                    sent += len(block)
                    reporter.set(f"uploading {path.name}", sent / size)
                    yield block

        res = self.client.storage.put(grant["url"], content=body(),
                                      headers={"content-type": ctype, "content-length": str(size)})
        if res.status_code not in (200, 201):
            raise JobError(f"Storage refused {path.name} ({res.status_code})")
        return grant["asset_id"]


class _Stopping(Exception):
    pass


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m cutcue.agent", description="Menapoly Cue Mac worker agent")
    parser.add_argument("--once", action="store_true", help="process at most one job, then exit")
    parser.add_argument("--check", action="store_true", help="check the configuration and connection, then exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = AgentConfig.from_env()
    problems = cfg.problems()
    if problems:
        sys.exit("Menapoly Cue agent is not configured:\n  - " + "\n  - ".join(problems))
    try:
        os.nice(cfg.nice)
    except OSError:
        pass
    agent = Agent(cfg)
    if args.check:
        agent.heartbeat()
        print(f"OK: connected to {urlparse(cfg.url).hostname} as a registered worker "
              f"({platform.system()} {platform.machine()}, transcriber={agent.settings.transcriber}).")
        return

    def _stop(signum, _frame):
        log.info("signal %s: finishing up (the current job is released, not lost)", signum)
        agent.stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    if args.once:
        agent.recover()
        agent.heartbeat()
        agent.run_once()
        return
    agent.run_forever()


if __name__ == "__main__":
    main()
