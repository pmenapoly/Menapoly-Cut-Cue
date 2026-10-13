"""Background jobs: persistent queue, local worker threads, optional cloud worker, router.

Jobs are rows in SQLite so status survives restarts. Two local lanes keep an Intel Mac
responsive: ``heavy`` (transcription, renders, proxies; one at a time) and ``light``
(probing, thumbnails, silence/scene analysis).
"""
from __future__ import annotations

import logging
import queue
import threading
import traceback
from dataclasses import dataclass
from typing import Callable

from .db import Database, dumps, loads, new_id, now
from .media import Cancelled, CancelToken

log = logging.getLogger("cutcue.jobs")

HEAVY_TYPES = {"transcribe", "render", "proxy"}


@dataclass
class JobContext:
    job_id: str
    project_id: str
    payload: dict
    cancel: CancelToken
    _set_progress: Callable[[float, str | None], None]

    def progress(self, fraction: float, message: str | None = None) -> None:
        self._set_progress(fraction, message)


Handler = Callable[[JobContext], dict | None]


class CloudWorkerUnavailable(RuntimeError):
    pass


class LocalWorker:
    name = "local"

    def __init__(self, manager: "JobManager"):
        self.manager = manager
        self.queues = {"heavy": queue.Queue(), "light": queue.Queue()}
        self.threads: list[threading.Thread] = []

    def start(self) -> None:
        for lane, q in self.queues.items():
            t = threading.Thread(target=self._loop, args=(q,), name=f"cutcue-{lane}", daemon=True)
            t.start()
            self.threads.append(t)

    def submit(self, job: dict) -> None:
        self.queues["heavy" if job["type"] in HEAVY_TYPES else "light"].put(job["id"])

    def _loop(self, q: queue.Queue) -> None:
        while True:
            job_id = q.get()
            if job_id is None:
                return
            try:
                self.manager.run(job_id)
            except Exception:  # pragma: no cover - run() already records failures
                log.exception("job loop error")


class CloudWorker:
    """Optional remote worker behind the same job protocol (see docs/cloud-worker.md).

    Disabled unless CUTCUE_CLOUD_WORKER_URL is set AND the project owner explicitly
    approved cloud processing for that project. No footage leaves the machine otherwise.
    No remote worker is shipped yet: submissions are refused with a clear error.
    """

    name = "cloud"

    def __init__(self, url: str, token: str):
        self.url, self.token = url, token

    @property
    def configured(self) -> bool:
        return bool(self.url)

    def submit(self, job: dict) -> None:
        raise CloudWorkerUnavailable(
            "Cloud worker contract is defined but no remote worker is deployed; job kept local-only.")


class JobManager:
    def __init__(self, db: Database, cloud: CloudWorker):
        self.db = db
        self.handlers: dict[str, Handler] = {}
        self.local = LocalWorker(self)
        self.cloud = cloud
        self._tokens: dict[str, CancelToken] = {}
        self._lock = threading.Lock()
        self.listeners: list[Callable[[dict], None]] = []

    def register(self, job_type: str, handler: Handler) -> None:
        self.handlers[job_type] = handler

    def start(self) -> None:
        # Anything "running" when the server stopped was interrupted.
        for job in self.db.all("SELECT id FROM jobs WHERE status IN ('running', 'queued')"):
            self.db.update("jobs", "id", job["id"], {"status": "failed", "error": "Interrupted by server restart; retry to run again",
                                                     "updated_at": now()})
        self.local.start()

    # --- routing -------------------------------------------------------------------
    def route(self, project: dict, job_type: str) -> str:
        """JobRouter: local unless the project opted in to cloud AND cloud is configured."""
        if project["processing_mode"] == "cloud" and project["cloud_approved"] and self.cloud.configured \
                and job_type in HEAVY_TYPES:
            return "cloud"
        return "local"

    def enqueue(self, project: dict, job_type: str, payload: dict, message: str = "Queued") -> dict:
        if job_type not in self.handlers:
            raise ValueError(f"Unknown job type {job_type}")
        worker = self.route(project, job_type)
        job = {"id": new_id("job"), "project_id": project["id"], "type": job_type, "status": "queued",
               "progress": 0.0, "message": message, "payload_json": dumps(payload), "worker": worker,
               "created_at": now(), "updated_at": now()}
        self.db.insert("jobs", job)
        if worker == "cloud":
            try:
                self.cloud.submit(job)
            except CloudWorkerUnavailable as exc:
                self.db.update("jobs", "id", job["id"], {"status": "failed", "error": str(exc), "updated_at": now()})
                job["status"] = "failed"
                return job
        else:
            self.local.submit(job)
        return job

    def retry(self, job_id: str) -> dict:
        job = self.db.one("SELECT * FROM jobs WHERE id = ?", [job_id])
        if not job or job["status"] not in ("failed", "cancelled"):
            raise ValueError("Only failed or cancelled jobs can be retried")
        self.db.update("jobs", "id", job_id, {"status": "queued", "error": None, "progress": 0.0,
                                              "message": "Queued (retry)", "updated_at": now()})
        job = self.db.one("SELECT * FROM jobs WHERE id = ?", [job_id])
        self.local.submit(job)
        return job

    def cancel(self, job_id: str) -> None:
        job = self.db.one("SELECT * FROM jobs WHERE id = ?", [job_id])
        if not job or job["status"] not in ("queued", "running"):
            raise ValueError("Job is not active")
        if job["status"] == "queued":
            self.db.update("jobs", "id", job_id, {"status": "cancelled", "message": "Cancelled", "updated_at": now()})
            final = self.db.one("SELECT * FROM jobs WHERE id = ?", [job_id])
            for listener in self.listeners:
                listener(final)
        with self._lock:
            token = self._tokens.get(job_id)
        if token:
            token.cancel()

    # --- execution -----------------------------------------------------------------
    def run(self, job_id: str) -> None:
        job = self.db.one("SELECT * FROM jobs WHERE id = ?", [job_id])
        if not job or job["status"] != "queued":
            return
        token = CancelToken()
        with self._lock:
            self._tokens[job_id] = token
        self.db.update("jobs", "id", job_id, {"status": "running", "attempts": job["attempts"] + 1,
                                              "message": "Starting", "started_at": now(), "finished_at": None,
                                              "updated_at": now()})
        last = {"p": -1.0}

        def set_progress(fraction: float, message: str | None) -> None:
            if abs(fraction - last["p"]) < 0.005 and message is None:
                return
            last["p"] = fraction
            values = {"progress": round(max(0.0, min(1.0, fraction)), 4), "updated_at": now()}
            if message:
                values["message"] = message
            self.db.update("jobs", "id", job_id, values)

        ctx = JobContext(job_id, job["project_id"], loads(job["payload_json"], {}), token, set_progress)
        try:
            result = self.handlers[job["type"]](ctx) or {}
            self.db.update("jobs", "id", job_id, {"status": "succeeded", "progress": 1.0, "message": "Done",
                                                  "result_json": dumps(result), "finished_at": now(),
                                                  "updated_at": now()})
        except Cancelled:
            self.db.update("jobs", "id", job_id, {"status": "cancelled", "message": "Cancelled", "finished_at": now(),
                                                  "updated_at": now()})
        except Exception as exc:
            log.warning("job %s (%s) failed: %s", job_id, job["type"], exc)
            log.debug(traceback.format_exc())
            self.db.update("jobs", "id", job_id, {"status": "failed", "error": str(exc)[:2000],
                                                  "message": "Failed", "finished_at": now(),
                                                  "updated_at": now()})
        finally:
            with self._lock:
                self._tokens.pop(job_id, None)
            final = self.db.one("SELECT * FROM jobs WHERE id = ?", [job_id])
            for listener in self.listeners:
                try:
                    listener(final)
                except Exception:
                    log.exception("job listener failed")

    def wait_idle(self, timeout: float = 600) -> bool:
        """Test helper: block until no queued/running jobs remain."""
        import time

        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.db.one("SELECT id FROM jobs WHERE status IN ('queued','running') LIMIT 1"):
                return True
            time.sleep(0.2)
        return False
