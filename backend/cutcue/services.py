"""Application services: projects, uploads/ingest, analysis, transcripts, timelines,
proposals, renders. Shared by the HTTP API and the AI assistant tools."""
from __future__ import annotations

import hashlib
import os
import re
import shutil
from pathlib import Path

from .config import Settings
from .db import Database, dumps, loads, new_id, now
from .documents import extract_text, parse_captions
from .jobs import CloudWorker, JobContext, JobManager
from . import media
from .render import render_timeline
from .timeline import Clip, Timeline, TimelineError, clamp_to_duration, remove_pauses, timeline_duration, validate_timeline
from . import transcribe as tx

EXTENSIONS = {
    "video": {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts"},
    "audio": {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".aiff", ".aif"},
    "image": {".jpg", ".jpeg", ".png"},
    "document": {".pdf", ".docx", ".txt", ".md"},
    "subtitle": {".srt", ".vtt"},
}
MAX_DOCUMENT_BYTES = 50 * 1024**2
ID_RE = re.compile(r"^[a-z]{3}_[0-9a-f]{16}$")


class NotFound(LookupError):
    pass


class BadRequest(ValueError):
    pass


def kind_for(filename: str) -> tuple[str, str]:
    ext = Path(filename).suffix.lower()
    for kind, exts in EXTENSIONS.items():
        if ext in exts:
            return kind, ext
    raise BadRequest(f"Unsupported file type '{ext or filename}'")


def check_id(value: str, prefix: str) -> str:
    if not ID_RE.match(value or "") or not value.startswith(prefix + "_"):
        raise NotFound(f"Invalid {prefix} id")
    return value


class Services:
    def __init__(self, settings: Settings, db: Database | None = None, start_workers: bool = True):
        self.settings = settings
        self.data_dir = settings.data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db = db or Database(self.data_dir / "cutcue.sqlite3")
        self.jobs = JobManager(self.db, CloudWorker(settings.cloud_worker_url, settings.cloud_worker_token))
        self.jobs.register("analyze", self._job_analyze)
        self.jobs.register("proxy", self._job_proxy)
        self.jobs.register("transcribe", self._job_transcribe)
        self.jobs.register("render", self._job_render)
        self.jobs.listeners.append(self._on_job_done)
        if start_workers:
            self.jobs.start()

    # --- paths -----------------------------------------------------------------------
    def project_dir(self, project_id: str) -> Path:
        path = self.data_dir / "projects" / check_id(project_id, "prj")
        return path

    def asset_path(self, asset: dict) -> Path:
        return self.project_dir(asset["project_id"]) / "assets" / asset["stored_name"]

    def derived_dir(self, asset: dict) -> Path:
        path = self.project_dir(asset["project_id"]) / "derived" / asset["id"]
        path.mkdir(parents=True, exist_ok=True)
        return path

    def renders_dir(self, project_id: str) -> Path:
        path = self.project_dir(project_id) / "renders"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # --- projects ----------------------------------------------------------------------
    def create_project(self, name: str) -> dict:
        name = (name or "").strip()[:120]
        if not name:
            raise BadRequest("Project name is required")
        project = {"id": new_id("prj"), "name": name, "created_at": now(), "processing_mode": "local",
                   "cloud_approved": 0, "budget_usd": self.settings.project_budget_usd, "spent_usd": 0.0}
        self.db.insert("projects", project)
        for sub in ("assets", "derived", "renders", "uploads"):
            (self.project_dir(project["id"]) / sub).mkdir(parents=True, exist_ok=True)
        return project

    def list_projects(self) -> list[dict]:
        return self.db.all("""SELECT p.*, (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) AS asset_count
                              FROM projects p ORDER BY created_at DESC""")

    def get_project(self, project_id: str) -> dict:
        project = self.db.one("SELECT * FROM projects WHERE id = ?", [check_id(project_id, "prj")])
        if not project:
            raise NotFound("Project not found")
        return project

    def update_project(self, project_id: str, *, name: str | None = None, processing_mode: str | None = None,
                       cloud_approved: bool | None = None, budget_usd: float | None = None) -> dict:
        project = self.get_project(project_id)
        values: dict = {}
        if name is not None:
            values["name"] = name.strip()[:120] or project["name"]
        if processing_mode is not None:
            if processing_mode not in ("local", "cloud"):
                raise BadRequest("processing_mode must be local or cloud")
            if processing_mode == "cloud" and not self.settings.cloud_configured:
                raise BadRequest("Cloud processing is not configured (set CUTCUE_CLOUD_WORKER_URL)")
            values["processing_mode"] = processing_mode
        if cloud_approved is not None:
            values["cloud_approved"] = int(bool(cloud_approved))
        if budget_usd is not None:
            if budget_usd < 0 or budget_usd > 1000:
                raise BadRequest("Budget must be between 0 and 1000 USD")
            values["budget_usd"] = budget_usd
        if values:
            self.db.update("projects", "id", project_id, values)
        return self.get_project(project_id)

    def delete_project(self, project_id: str) -> None:
        self.get_project(project_id)
        self.db.execute("DELETE FROM projects WHERE id = ?", [project_id])
        shutil.rmtree(self.project_dir(project_id), ignore_errors=True)

    def add_spend(self, project_id: str, usd: float) -> None:
        self.db.execute("UPDATE projects SET spent_usd = spent_usd + ? WHERE id = ?", [usd, project_id])

    # --- uploads (resumable, chunked) ---------------------------------------------------
    def init_upload(self, project_id: str, filename: str, size: int) -> dict:
        self.get_project(project_id)
        filename = Path(filename or "").name[:255]
        kind, _ = kind_for(filename)
        if size <= 0:
            raise BadRequest("Empty file")
        limit = MAX_DOCUMENT_BYTES if kind in ("document", "subtitle") else self.settings.max_upload_bytes
        if size > limit:
            raise BadRequest(f"File too large ({size} bytes > {limit})")
        upload = {"id": new_id("upl"), "project_id": project_id, "filename": filename, "size": size,
                  "received": 0, "status": "open", "created_at": now()}
        self.db.insert("uploads", upload)
        self._upload_part(upload).touch()
        return upload

    def _upload_part(self, upload: dict) -> Path:
        return self.project_dir(upload["project_id"]) / "uploads" / f"{upload['id']}.part"

    def get_upload(self, project_id: str, upload_id: str) -> dict:
        upload = self.db.one("SELECT * FROM uploads WHERE id = ? AND project_id = ?",
                             [check_id(upload_id, "upl"), project_id])
        if not upload:
            raise NotFound("Upload not found")
        return upload

    def write_chunk(self, project_id: str, upload_id: str, offset: int, data: bytes) -> dict:
        upload = self.get_upload(project_id, upload_id)
        if upload["status"] != "open":
            raise BadRequest("Upload is not open")
        if offset != upload["received"]:
            raise BadRequest(f"Offset mismatch: server has {upload['received']} bytes")
        if offset + len(data) > upload["size"]:
            raise BadRequest("Chunk exceeds declared size")
        with self._upload_part(upload).open("r+b") as fh:
            fh.seek(offset)
            fh.write(data)
        received = offset + len(data)
        self.db.update("uploads", "id", upload_id, {"received": received})
        upload["received"] = received
        return upload

    def complete_upload(self, project_id: str, upload_id: str) -> dict:
        upload = self.get_upload(project_id, upload_id)
        if upload["received"] != upload["size"]:
            raise BadRequest(f"Upload incomplete: {upload['received']}/{upload['size']} bytes")
        part = self._upload_part(upload)
        kind, ext = kind_for(upload["filename"])
        sha = hashlib.sha256()
        with part.open("rb") as fh:
            for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
                sha.update(block)
        asset_id = new_id("ast")
        stored_name = f"{asset_id}{ext}"
        dest = self.project_dir(project_id) / "assets" / stored_name
        asset = {"id": asset_id, "project_id": project_id, "kind": kind, "original_name": upload["filename"],
                 "stored_name": stored_name, "size": upload["size"], "sha256": sha.hexdigest(),
                 "status": "processing", "created_at": now()}
        try:
            self._validate_content(part, kind, ext, asset)
        except (BadRequest, ValueError) as exc:
            part.unlink(missing_ok=True)
            self.db.update("uploads", "id", upload_id, {"status": "rejected"})
            raise BadRequest(f"{upload['filename']}: {exc}") from exc
        os.replace(part, dest)
        self.db.update("uploads", "id", upload_id, {"status": "complete"})
        self.db.insert("assets", asset)
        project = self.get_project(project_id)
        if kind in ("video", "audio", "image"):
            self.jobs.enqueue(project, "analyze", {"asset_id": asset_id}, "Waiting to analyze")
        elif kind == "document":
            self._ingest_document(asset)
        elif kind == "subtitle":
            self._ingest_subtitle(asset)
        return self.get_asset(project_id, asset_id)

    def _validate_content(self, path: Path, kind: str, ext: str, asset: dict) -> None:
        head = path.open("rb").read(8)
        if kind in ("video", "audio", "image"):
            info = media.probe(path)  # raises ValueError for non-media
            if kind == "video" and not info["has_video"]:
                kind = asset["kind"] = "audio" if info["has_audio"] else kind
            if asset["kind"] in ("video", "audio") and not (info["has_video"] or info["has_audio"]):
                raise BadRequest("No audio or video streams found")
            if asset["kind"] in ("video", "audio") and not info["duration"]:
                raise BadRequest("Could not determine duration")
            asset.update({"duration": info["duration"], "has_video": int(info["has_video"]),
                          "has_audio": int(info["has_audio"]), "width": info["width"], "height": info["height"],
                          "fps": info["fps"], "probe_json": dumps({k: v for k, v in info.items() if k != "raw"})})
        elif ext == ".pdf" and not head.startswith(b"%PDF"):
            raise BadRequest("Not a PDF file")
        elif ext == ".docx" and not head.startswith(b"PK"):
            raise BadRequest("Not a DOCX file")
        elif ext in (".txt", ".md", ".srt", ".vtt"):
            try:
                path.read_bytes().decode("utf-8")
            except UnicodeDecodeError as exc:
                raise BadRequest("Text files must be UTF-8") from exc

    def _ingest_document(self, asset: dict) -> None:
        try:
            text = extract_text(self.asset_path(asset), Path(asset["stored_name"]).suffix)
            self._set_analysis(asset["id"], "text", {"text": text, "chars": len(text)})
            self.db.update("assets", "id", asset["id"], {"status": "ready"})
        except Exception as exc:
            self.db.update("assets", "id", asset["id"], {"status": "error", "error": f"Could not read document: {exc}"})

    def _ingest_subtitle(self, asset: dict) -> None:
        try:
            cues = parse_captions(self.asset_path(asset).read_text(encoding="utf-8"))
            self._set_analysis(asset["id"], "captions", {"cues": cues})
            self.db.update("assets", "id", asset["id"], {"status": "ready"})
            # Attach to a same-named media file that has no transcript yet.
            stem = Path(asset["original_name"]).stem.lower()
            for target in self.list_assets(asset["project_id"]):
                if target["kind"] in ("video", "audio") and Path(target["original_name"]).stem.lower() == stem \
                        and not self.transcript(target["id"]):
                    self.attach_captions(asset["project_id"], target["id"], asset["id"])
        except Exception as exc:
            self.db.update("assets", "id", asset["id"], {"status": "error", "error": f"Could not parse captions: {exc}"})

    def attach_captions(self, project_id: str, media_asset_id: str, subtitle_asset_id: str) -> int:
        target = self.get_asset(project_id, media_asset_id)
        sub = self.get_asset(project_id, subtitle_asset_id)
        if target["kind"] not in ("video", "audio") or sub["kind"] != "subtitle":
            raise BadRequest("Attach a subtitle asset to a video or audio asset")
        cues = (self.analysis(subtitle_asset_id, "captions") or {}).get("cues", [])
        cues = [c for c in cues if c["start"] < (target["duration"] or 0)]
        self._store_segments(target, cues, "imported-captions")
        return len(cues)

    # --- assets ----------------------------------------------------------------------------
    def list_assets(self, project_id: str) -> list[dict]:
        self.get_project(project_id)
        rows = self.db.all("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at", [project_id])
        return [self._public_asset(r) for r in rows]

    def get_asset(self, project_id: str, asset_id: str) -> dict:
        row = self.db.one("SELECT * FROM assets WHERE id = ? AND project_id = ?", [check_id(asset_id, "ast"), project_id])
        if not row:
            raise NotFound("Asset not found")
        return self._public_asset(row)

    def _public_asset(self, row: dict) -> dict:
        row = dict(row)
        row["probe"] = loads(row.pop("probe_json", None), {})
        row["has_transcript"] = bool(self.db.one("SELECT 1 FROM transcript_segments WHERE asset_id = ? LIMIT 1", [row["id"]]))
        return row

    def project_assets_map(self, project_id: str) -> dict[str, dict]:
        return {a["id"]: a for a in self.db.all("SELECT * FROM assets WHERE project_id = ?", [project_id])}

    def delete_asset(self, project_id: str, asset_id: str) -> None:
        asset = self.get_asset(project_id, asset_id)
        self.db.execute("DELETE FROM assets WHERE id = ?", [asset_id])
        self.asset_path(asset).unlink(missing_ok=True)
        shutil.rmtree(self.project_dir(project_id) / "derived" / asset_id, ignore_errors=True)

    def playable_path(self, asset: dict) -> Path:
        if asset.get("proxy_name"):
            proxy = self.derived_dir(asset) / asset["proxy_name"]
            if proxy.is_file():
                return proxy
        return self.asset_path(asset)

    def _set_analysis(self, asset_id: str, kind: str, data: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO analyses (asset_id, kind, data_json, created_at) VALUES (?, ?, ?, ?)",
                        [asset_id, kind, dumps(data), now()])

    def analysis(self, asset_id: str, kind: str) -> dict | None:
        row = self.db.one("SELECT data_json FROM analyses WHERE asset_id = ? AND kind = ?", [asset_id, kind])
        return loads(row["data_json"]) if row else None

    # --- jobs: analysis / transcription ------------------------------------------------------
    def _job_asset(self, ctx: JobContext) -> dict:
        row = self.db.one("SELECT * FROM assets WHERE id = ? AND project_id = ?", [ctx.payload["asset_id"], ctx.project_id])
        if not row:
            raise NotFound("Asset was deleted")
        return row

    def _job_analyze(self, ctx: JobContext) -> dict:
        asset = self._job_asset(ctx)
        source, derived, duration = self.asset_path(asset), self.derived_dir(asset), asset["duration"]
        result: dict = {}
        if asset["kind"] == "image" or asset["has_video"]:
            ctx.progress(0.02, "Thumbnail")
            media.make_thumbnail(source, derived / "thumb.jpg", duration)
            self.db.update("assets", "id", asset["id"], {"thumb_name": "thumb.jpg"})
        if asset["kind"] == "image":
            self.db.update("assets", "id", asset["id"], {"status": "ready"})
            return result
        if asset["has_audio"]:
            ctx.progress(0.05, "Detecting pauses")
            silences = media.detect_silences(source, duration, cancel=ctx.cancel,
                                             progress=lambda f: ctx.progress(0.05 + 0.45 * f))
            self._set_analysis(asset["id"], "silences", {"silences": silences, "noise_db": -35, "min_duration": 0.6})
            result["silences"] = len(silences)
        if asset["has_video"]:
            ctx.progress(0.5, "Detecting scenes")
            scenes = media.detect_scenes(source, duration, cancel=ctx.cancel,
                                         progress=lambda f: ctx.progress(0.5 + 0.5 * f))
            self._set_analysis(asset["id"], "scenes", {"cuts": scenes})
            result["scene_cuts"] = len(scenes)
        self.db.update("assets", "id", asset["id"], {"status": "ready"})
        project = self.get_project(ctx.project_id)
        info = loads(asset["probe_json"], {})
        if asset["has_video"] and media.needs_proxy(info):
            self.jobs.enqueue(project, "proxy", {"asset_id": asset["id"]}, "Waiting to build preview proxy")
        if asset["has_audio"] and self.settings.transcriber != "none" and not self.transcript(asset["id"]):
            self.jobs.enqueue(project, "transcribe", {"asset_id": asset["id"]}, "Waiting to transcribe")
        return result

    def _job_proxy(self, ctx: JobContext) -> dict:
        asset = self._job_asset(ctx)
        dest = self.derived_dir(asset) / "proxy.mp4"
        media.make_proxy(self.asset_path(asset), dest, asset["duration"],
                         progress=lambda f: ctx.progress(f, "Building browser proxy"), cancel=ctx.cancel)
        self.db.update("assets", "id", asset["id"], {"proxy_name": "proxy.mp4"})
        return {"proxy": True}

    def _job_transcribe(self, ctx: JobContext) -> dict:
        asset = self._job_asset(ctx)
        engine = self.settings.transcriber
        if engine == "fixture":
            segments = tx.transcribe_fixture(asset["sha256"])
        elif engine == "faster-whisper":
            wav = self.derived_dir(asset) / "audio16k.wav"
            ctx.progress(0.01, "Extracting audio")
            media.extract_audio_wav(self.asset_path(asset), wav, cancel=ctx.cancel, duration=asset["duration"],
                                    progress=lambda f: ctx.progress(0.05 * f))
            try:
                ctx.progress(0.05, f"Transcribing with Whisper '{self.settings.whisper_model}' (CPU)")
                segments = tx.transcribe_faster_whisper(
                    wav, asset["duration"], model=self.settings.whisper_model,
                    compute_type=self.settings.whisper_compute_type, cpu_threads=self.settings.cpu_threads,
                    language=self.settings.whisper_language, cancel=ctx.cancel,
                    progress=lambda f: ctx.progress(0.05 + 0.95 * f, "Transcribing"))
            finally:
                wav.unlink(missing_ok=True)
        else:
            raise tx.TranscriptionUnavailable("Transcription is disabled (CUTCUE_TRANSCRIBER=none)")
        self._store_segments(asset, segments, engine)
        return {"segments": len(segments)}

    def _store_segments(self, asset: dict, segments: list[dict], source: str) -> None:
        duration = asset.get("duration") or 0
        self.db.execute("DELETE FROM transcript_segments WHERE asset_id = ?", [asset["id"]])
        rows = []
        for i, seg in enumerate(segments):
            start, end = float(seg["start"]), min(float(seg["end"]), duration) if duration else float(seg["end"])
            if end <= start:
                continue
            rows.append([asset["project_id"], asset["id"], i, start, end, seg["text"].strip(),
                         dumps(seg.get("words") or []), source])
        self.db.executemany("""INSERT INTO transcript_segments (project_id, asset_id, idx, start, end, text, words_json, source)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", rows)

    # --- transcripts ---------------------------------------------------------------------------
    def transcript(self, asset_id: str, start: float | None = None, end: float | None = None) -> list[dict]:
        sql = "SELECT idx, start, end, text, words_json, source FROM transcript_segments WHERE asset_id = ?"
        params: list = [asset_id]
        if start is not None:
            sql += " AND end > ?"
            params.append(start)
        if end is not None:
            sql += " AND start < ?"
            params.append(end)
        rows = self.db.all(sql + " ORDER BY start", params)
        for r in rows:
            r["words"] = loads(r.pop("words_json"), [])
        return rows

    def segments_by_asset(self, asset_ids: set[str]) -> dict[str, list[dict]]:
        return {aid: self.transcript(aid) for aid in asset_ids}

    def search(self, project_id: str, query: str, limit: int = 20) -> list[dict]:
        self.get_project(project_id)
        terms = [t for t in re.findall(r"[\w']+", query.lower()) if len(t) > 1]
        if not terms:
            return []
        fts = " OR ".join(f'"{t}"' for t in terms)
        rows = self.db.all("""SELECT s.asset_id, s.start, s.end, s.text, a.original_name
                              FROM segments_fts f JOIN transcript_segments s ON s.id = f.rowid
                              JOIN assets a ON a.id = s.asset_id
                              WHERE segments_fts MATCH ? AND s.project_id = ?
                              ORDER BY bm25(segments_fts) LIMIT ?""", [fts, project_id, limit])
        return rows

    def documents(self, project_id: str) -> list[dict]:
        docs = []
        for a in self.db.all("SELECT * FROM assets WHERE project_id = ? AND kind = 'document' AND status = 'ready'", [project_id]):
            text = (self.analysis(a["id"], "text") or {}).get("text", "")
            docs.append({"asset_id": a["id"], "name": a["original_name"], "text": text})
        return docs

    # --- sequences & versions -------------------------------------------------------------------
    def list_sequences(self, project_id: str) -> list[dict]:
        self.get_project(project_id)
        seqs = self.db.all("SELECT * FROM sequences WHERE project_id = ? ORDER BY created_at", [project_id])
        for s in seqs:
            s["versions"] = self.db.all("""SELECT id, number, label, origin, parent_id, created_at FROM timeline_versions
                                           WHERE sequence_id = ? ORDER BY number""", [s["id"]])
            current = self.get_version(project_id, s["current_version_id"]) if s["current_version_id"] else None
            s["timeline"] = current["timeline"] if current else None
            s["duration"] = timeline_duration(Timeline(**current["timeline"])) if current else 0
        return seqs

    def get_sequence(self, project_id: str, sequence_id: str) -> dict:
        seq = self.db.one("SELECT * FROM sequences WHERE id = ? AND project_id = ?", [check_id(sequence_id, "seq"), project_id])
        if not seq:
            raise NotFound("Sequence not found")
        return seq

    def get_version(self, project_id: str, version_id: str) -> dict:
        row = self.db.one("SELECT * FROM timeline_versions WHERE id = ? AND project_id = ?",
                          [check_id(version_id, "ver"), project_id])
        if not row:
            raise NotFound("Version not found")
        row["timeline"] = loads(row.pop("timeline_json"))
        return row

    def checked_timeline(self, project_id: str, timeline: Timeline) -> Timeline:
        assets = self.project_assets_map(project_id)
        timeline = clamp_to_duration(timeline, assets)
        validate_timeline(timeline, assets)
        return timeline

    def create_sequence(self, project_id: str, name: str) -> dict:
        self.get_project(project_id)
        seq = {"id": new_id("seq"), "project_id": project_id, "name": (name or "Sequence").strip()[:120],
               "current_version_id": None, "created_at": now()}
        self.db.insert("sequences", seq)
        return seq

    def save_version(self, project_id: str, sequence_id: str, timeline: Timeline, label: str, origin: str) -> dict:
        seq = self.get_sequence(project_id, sequence_id)
        timeline = self.checked_timeline(project_id, timeline)
        number = (self.db.one("SELECT MAX(number) AS n FROM timeline_versions WHERE sequence_id = ?", [sequence_id])["n"] or 0) + 1
        version = {"id": new_id("ver"), "project_id": project_id, "sequence_id": sequence_id, "number": number,
                   "label": (label or f"Version {number}")[:200], "origin": origin, "parent_id": seq["current_version_id"],
                   "timeline_json": dumps(timeline.model_dump()), "created_at": now()}
        self.db.insert("timeline_versions", version)
        self.db.update("sequences", "id", sequence_id, {"current_version_id": version["id"]})
        return self.get_version(project_id, version["id"])

    def restore_version(self, project_id: str, version_id: str) -> dict:
        old = self.get_version(project_id, version_id)
        return self.save_version(project_id, old["sequence_id"], Timeline(**old["timeline"]),
                                 f"Restored v{old['number']}: {old['label']}", "restore")

    def delete_sequence(self, project_id: str, sequence_id: str) -> None:
        self.get_sequence(project_id, sequence_id)
        self.db.execute("DELETE FROM sequences WHERE id = ?", [sequence_id])

    # --- proposals (AI or local planner) -> require explicit approval ------------------------------
    def create_proposal(self, project_id: str, title: str, rationale: str, sequences: list[dict], created_by: str) -> dict:
        """Validate and expand a plan. Raises TimelineError/BadRequest with fixable messages."""
        assets = self.project_assets_map(project_id)
        expanded: list[dict] = []
        problems: list[str] = []
        if not sequences:
            raise BadRequest("Plan has no sequences")
        for n, spec in enumerate(sequences, start=1):
            try:
                seq_id = spec.get("sequence_id") or None
                if seq_id:
                    self.get_sequence(project_id, seq_id)
                clips = [Clip(**c) for c in spec.get("clips", [])]
                pauses = spec.get("remove_pauses") or {}
                if pauses.get("enabled"):
                    silences = {aid: (self.analysis(aid, "silences") or {}).get("silences", []) for aid in {c.asset_id for c in clips}}
                    clips = remove_pauses(clips, silences, min_pause=float(pauses.get("min_pause", 0.7)),
                                          keep_padding=float(pauses.get("keep_padding", 0.15)))
                timeline = Timeline(aspect=spec.get("aspect", "16:9"), clips=clips,
                                    burn_captions=bool(spec.get("burn_captions", False)),
                                    normalize_audio=bool(spec.get("normalize_audio", True)))
                timeline = clamp_to_duration(timeline, assets)
                validate_timeline(timeline, assets)
                expanded.append({"sequence_id": seq_id, "name": (spec.get("name") or f"Sequence {n}")[:120],
                                 "timeline": timeline.model_dump(), "duration": timeline_duration(timeline),
                                 "clip_count": len(timeline.clips)})
            except TimelineError as exc:
                problems += [f"sequence {n}: {p}" for p in exc.problems]
            except (NotFound, ValueError, TypeError) as exc:
                problems.append(f"sequence {n}: {exc}")
        if problems:
            raise TimelineError(problems)
        proposal = {"id": new_id("prp"), "project_id": project_id, "title": (title or "Edit proposal")[:200],
                    "rationale": (rationale or "")[:4000], "plan_json": dumps({"sequences": expanded}),
                    "status": "pending", "created_by": created_by, "created_at": now()}
        self.db.insert("proposals", proposal)
        return self.get_proposal(project_id, proposal["id"])

    def get_proposal(self, project_id: str, proposal_id: str) -> dict:
        row = self.db.one("SELECT * FROM proposals WHERE id = ? AND project_id = ?", [check_id(proposal_id, "prp"), project_id])
        if not row:
            raise NotFound("Proposal not found")
        row["plan"] = loads(row.pop("plan_json"))
        row["result"] = loads(row.pop("result_json"), None)
        return row

    def list_proposals(self, project_id: str) -> list[dict]:
        ids = self.db.all("SELECT id FROM proposals WHERE project_id = ? ORDER BY created_at", [project_id])
        return [self.get_proposal(project_id, r["id"]) for r in ids]

    def approve_proposal(self, project_id: str, proposal_id: str, render_preview: bool = True) -> dict:
        proposal = self.get_proposal(project_id, proposal_id)
        if proposal["status"] != "pending":
            raise BadRequest(f"Proposal is already {proposal['status']}")
        created = []
        for spec in proposal["plan"]["sequences"]:
            seq_id = spec["sequence_id"] or self.create_sequence(project_id, spec["name"])["id"]
            version = self.save_version(project_id, seq_id, Timeline(**spec["timeline"]),
                                        proposal["title"], proposal["created_by"])
            entry = {"sequence_id": seq_id, "version_id": version["id"]}
            if render_preview:
                entry["render_id"] = self.request_render(project_id, version["id"], "preview")["id"]
            created.append(entry)
        result = {"created": created}
        self.db.update("proposals", "id", proposal_id, {"status": "approved", "result_json": dumps(result)})
        return self.get_proposal(project_id, proposal_id)

    def reject_proposal(self, project_id: str, proposal_id: str) -> dict:
        proposal = self.get_proposal(project_id, proposal_id)
        if proposal["status"] != "pending":
            raise BadRequest(f"Proposal is already {proposal['status']}")
        self.db.update("proposals", "id", proposal_id, {"status": "rejected"})
        return self.get_proposal(project_id, proposal_id)

    # --- renders ----------------------------------------------------------------------------------
    def request_render(self, project_id: str, version_id: str, quality: str = "preview", want_wav: bool = False) -> dict:
        if quality not in ("preview", "final"):
            raise BadRequest("quality must be preview or final")
        version = self.get_version(project_id, version_id)
        self.checked_timeline(project_id, Timeline(**version["timeline"]))  # assets may have changed
        render = {"id": new_id("rnd"), "project_id": project_id, "sequence_id": version["sequence_id"],
                  "version_id": version_id, "quality": quality, "status": "queued", "created_at": now()}
        self.db.insert("renders", render)
        job = self.jobs.enqueue(self.get_project(project_id), "render",
                                {"render_id": render["id"], "want_wav": want_wav}, f"Waiting to render ({quality})")
        self.db.update("renders", "id", render["id"], {"job_id": job["id"],
                                                       "status": "failed" if job["status"] == "failed" else "queued"})
        return self.get_render(project_id, render["id"])

    def get_render(self, project_id: str, render_id: str) -> dict:
        row = self.db.one("""SELECT r.*, j.status AS job_status, j.progress, j.message, j.error FROM renders r
                             LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = ? AND r.project_id = ?""",
                          [check_id(render_id, "rnd"), project_id])
        if not row:
            raise NotFound("Render not found")
        return row

    def list_renders(self, project_id: str) -> list[dict]:
        return self.db.all("""SELECT r.*, j.status AS job_status, j.progress, j.message, j.error, v.number AS version_number,
                                     s.name AS sequence_name
                              FROM renders r LEFT JOIN jobs j ON j.id = r.job_id
                              LEFT JOIN timeline_versions v ON v.id = r.version_id
                              LEFT JOIN sequences s ON s.id = r.sequence_id
                              WHERE r.project_id = ? ORDER BY r.created_at DESC""", [project_id])

    def render_file(self, project_id: str, render_id: str, kind: str) -> Path:
        render = self.get_render(project_id, render_id)
        name = {"mp4": render["output_name"], "srt": render["srt_name"], "wav": render["wav_name"]}.get(kind)
        if not name:
            raise NotFound("File not available for this render")
        path = self.renders_dir(project_id) / name
        if not path.is_file():
            raise NotFound("Render file missing")
        return path

    def _job_render(self, ctx: JobContext) -> dict:
        render = self.db.one("SELECT * FROM renders WHERE id = ? AND project_id = ?", [ctx.payload["render_id"], ctx.project_id])
        if not render:
            raise NotFound("Render was deleted")
        self.db.update("renders", "id", render["id"], {"status": "running"})
        version = self.get_version(ctx.project_id, render["version_id"])
        timeline = self.checked_timeline(ctx.project_id, Timeline(**version["timeline"]))
        assets = self.project_assets_map(ctx.project_id)
        used = {c.asset_id for c in timeline.clips}
        encoder = media.pick_video_encoder(self.settings.video_encoder) if render["quality"] == "final" else "libx264"
        try:
            result = render_timeline(
                timeline, assets, {aid: self.asset_path(assets[aid]) for aid in used}, self.segments_by_asset(used),
                self.renders_dir(ctx.project_id), render["id"], quality=render["quality"], encoder=encoder,
                want_wav=bool(ctx.payload.get("want_wav")), progress=lambda f, m: ctx.progress(f, m),
                cancel=ctx.cancel, timeout=self.settings.render_timeout_s)
        except Exception:
            self.db.update("renders", "id", render["id"], {"status": "failed"})
            raise
        actual = media.probe(result.output)["duration"]
        self.db.update("renders", "id", render["id"], {
            "status": "succeeded", "output_name": result.output.name, "srt_name": result.srt.name,
            "wav_name": f"{render['id']}.wav" if ctx.payload.get("want_wav") else None, "duration": actual})
        return {"output": result.output.name, "duration": actual, "expected_duration": result.duration,
                "captions": result.cues, "encoder": encoder}

    def _on_job_done(self, job: dict) -> None:
        if job["type"] == "render" and job["status"] in ("cancelled", "failed"):
            payload = loads(job["payload_json"], {})
            self.db.execute("UPDATE renders SET status = ? WHERE id = ? AND status != 'succeeded'",
                            [job["status"], payload.get("render_id")])
        if job["type"] == "analyze" and job["status"] == "failed":
            payload = loads(job["payload_json"], {})
            self.db.execute("UPDATE assets SET status = 'error', error = ? WHERE id = ?", [job["error"], payload.get("asset_id")])

    def list_jobs(self, project_id: str, limit: int = 50) -> list[dict]:
        rows = self.db.all("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", [project_id, limit])
        for r in rows:
            r["payload"] = loads(r.pop("payload_json"), {})
            r["result"] = loads(r.pop("result_json"), None)
        return rows

    def retry_job(self, project_id: str, job_id: str) -> dict:
        job = self.db.one("SELECT * FROM jobs WHERE id = ? AND project_id = ?", [check_id(job_id, "job"), project_id])
        if not job:
            raise NotFound("Job not found")
        if job["type"] == "render":
            payload = loads(job["payload_json"], {})
            self.db.execute("UPDATE renders SET status = 'queued' WHERE id = ?", [payload.get("render_id")])
        return self.jobs.retry(job_id)

    def cancel_job(self, project_id: str, job_id: str) -> None:
        job = self.db.one("SELECT * FROM jobs WHERE id = ? AND project_id = ?", [check_id(job_id, "job"), project_id])
        if not job:
            raise NotFound("Job not found")
        self.jobs.cancel(job_id)
