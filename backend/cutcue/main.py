"""Menapoly Cut Cue HTTP API (FastAPI)."""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from collections import Counter
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import __version__, media
from .assistant import Assistant, timeline_stats
from .config import ROOT, Settings, settings as default_settings
from .services import BadRequest, NotFound, Services
from .timeline import Timeline, TimelineError

log = logging.getLogger("cutcue")
MAX_CHUNK = 64 * 1024 * 1024
COOKIE = "cutcue_session"


class ProjectIn(BaseModel):
    name: str


class ProjectPatch(BaseModel):
    name: str | None = None
    processing_mode: str | None = None
    cloud_approved: bool | None = None
    budget_usd: float | None = None


class UploadIn(BaseModel):
    filename: str
    size: int = Field(gt=0)


class SequenceIn(BaseModel):
    name: str
    timeline: Timeline | None = None


class VersionIn(BaseModel):
    timeline: Timeline
    label: str = "Manual edit"


class RenderIn(BaseModel):
    version_id: str
    quality: str = "preview"
    wav: bool = False


class ChatIn(BaseModel):
    message: str


class LoginIn(BaseModel):
    password: str


class AttachIn(BaseModel):
    subtitle_asset_id: str


class AudioAssetIn(BaseModel):
    audio_asset_id: str


class SpeakersPatch(BaseModel):
    labels: dict[str, dict]


class DiarizeIn(BaseModel):
    num_speakers: int | None = None


class BriefPatch(BaseModel):
    fields: dict
    replace: bool = False


class AutoEditIn(BaseModel):
    asset_id: str
    options: dict = {}
    name: str = "Podcast auto-edit"


def create_app(settings: Settings | None = None, services: Services | None = None,
               assistant: Assistant | None = None) -> FastAPI:
    settings = settings or default_settings
    svc = services or Services(settings)
    bot = assistant or Assistant(svc)
    secret = settings.secret_key or secrets.token_hex(32)
    session_token = hmac.new(secret.encode(), b"cutcue-owner", hashlib.sha256).hexdigest()

    app = FastAPI(title="Menapoly Cut Cue", version=__version__,
                  description="Private conversational AI video editor (single user).")
    app.state.services, app.state.assistant = svc, bot
    if settings.allowed_origins:
        app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_credentials=True,
                           allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(NotFound)
    async def _nf(_: Request, exc: NotFound):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(BadRequest)
    async def _br(_: Request, exc: BadRequest):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(TimelineError)
    async def _te(_: Request, exc: TimelineError):
        return JSONResponse({"detail": "Timeline validation failed", "problems": exc.problems}, status_code=422)

    @app.middleware("http")
    async def auth(request: Request, call_next):
        path = request.url.path
        if settings.password and path.startswith("/api/") and path not in ("/api/health", "/api/auth/login", "/api/auth/status"):
            if not hmac.compare_digest(request.cookies.get(COOKIE, ""), session_token):
                return JSONResponse({"detail": "Not signed in"}, status_code=401)
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    def project(pid: str) -> dict:
        return svc.get_project(pid)

    # --- system ------------------------------------------------------------------------------
    @app.get("/api/health")
    def health():
        return {
            "app": "Menapoly Cut Cue", "version": __version__,
            "ffmpeg": media.tool_available("ffmpeg"), "ffprobe": media.tool_available("ffprobe"),
            "assistant_mode": bot.mode, "claude_model": settings.claude_model if bot.mode == "claude" else None,
            "transcriber": settings.transcriber, "whisper_model": settings.whisper_model,
            "cloud_configured": settings.cloud_configured, "auth_required": bool(settings.password),
        }

    @app.get("/api/auth/status")
    def auth_status(request: Request):
        ok = not settings.password or hmac.compare_digest(request.cookies.get(COOKIE, ""), session_token)
        return {"signed_in": ok, "auth_required": bool(settings.password)}

    @app.post("/api/auth/login")
    def login(body: LoginIn, response: Response):
        if not settings.password or not hmac.compare_digest(body.password, settings.password):
            raise HTTPException(401, "Wrong password")
        response.set_cookie(COOKIE, session_token, httponly=True, samesite="strict", max_age=30 * 86400)
        return {"signed_in": True}

    @app.post("/api/auth/logout")
    def logout(response: Response):
        response.delete_cookie(COOKIE)
        return {"signed_in": False}

    # --- projects -------------------------------------------------------------------------------
    @app.get("/api/projects")
    def list_projects():
        return svc.list_projects()

    @app.post("/api/projects", status_code=201)
    def create_project(body: ProjectIn):
        return svc.create_project(body.name)

    @app.get("/api/projects/{pid}")
    def get_project(pid: str):
        return svc.get_project(pid)

    @app.patch("/api/projects/{pid}")
    def patch_project(pid: str, body: ProjectPatch):
        return svc.update_project(pid, **body.model_dump(exclude_none=True))

    @app.delete("/api/projects/{pid}", status_code=204)
    def delete_project(pid: str):
        svc.delete_project(pid)

    # --- uploads ---------------------------------------------------------------------------------
    @app.post("/api/projects/{pid}/uploads", status_code=201)
    def init_upload(pid: str, body: UploadIn):
        return svc.init_upload(pid, body.filename, body.size)

    @app.get("/api/projects/{pid}/uploads/{uid}")
    def upload_status(pid: str, uid: str):
        return svc.get_upload(pid, uid)

    @app.put("/api/projects/{pid}/uploads/{uid}")
    async def upload_chunk(pid: str, uid: str, offset: int, request: Request):
        data = bytearray()
        async for part in request.stream():
            data.extend(part)
            if len(data) > MAX_CHUNK:
                raise HTTPException(413, "Chunk too large")
        return await run_in_threadpool(svc.write_chunk, pid, uid, offset, bytes(data))

    @app.post("/api/projects/{pid}/uploads/{uid}/complete")
    def complete_upload(pid: str, uid: str):
        return svc.complete_upload(pid, uid)

    # --- assets ----------------------------------------------------------------------------------
    @app.get("/api/projects/{pid}/assets")
    def list_assets(pid: str):
        return svc.list_assets(pid)

    @app.get("/api/projects/{pid}/assets/{aid}")
    def get_asset(pid: str, aid: str):
        asset = svc.get_asset(pid, aid)
        asset["silences"] = (svc.analysis(aid, "silences") or {}).get("silences", [])
        asset["scenes"] = (svc.analysis(aid, "scenes") or {}).get("cuts", [])
        if asset["kind"] == "document":
            asset["text"] = (svc.analysis(aid, "text") or {}).get("text", "")
        return asset

    @app.delete("/api/projects/{pid}/assets/{aid}", status_code=204)
    def delete_asset(pid: str, aid: str):
        svc.delete_asset(pid, aid)

    @app.get("/api/projects/{pid}/assets/{aid}/media")
    def asset_media(pid: str, aid: str):
        asset = svc.get_asset(pid, aid)
        if asset["kind"] not in ("video", "audio", "image"):
            raise NotFound("Not a media asset")
        return FileResponse(svc.playable_path(asset))

    @app.get("/api/projects/{pid}/assets/{aid}/thumbnail")
    def asset_thumb(pid: str, aid: str):
        asset = svc.get_asset(pid, aid)
        if not asset.get("thumb_name"):
            raise NotFound("No thumbnail")
        return FileResponse(svc.derived_dir(asset) / asset["thumb_name"], media_type="image/jpeg")

    @app.get("/api/projects/{pid}/assets/{aid}/transcript")
    def asset_transcript(pid: str, aid: str, start: float | None = None, end: float | None = None):
        svc.get_asset(pid, aid)
        return svc.transcript(aid, start, end)

    @app.post("/api/projects/{pid}/assets/{aid}/captions")
    def attach_captions(pid: str, aid: str, body: AttachIn):
        return {"segments": svc.attach_captions(pid, aid, body.subtitle_asset_id)}

    @app.get("/api/projects/{pid}/assets/{aid}/audio.wav")
    def export_source_wav(pid: str, aid: str):
        path = svc.export_source_wav(pid, aid)
        name = Path(svc.get_asset(pid, aid)["original_name"]).stem + "-audio.wav"
        return FileResponse(path, media_type="audio/wav", filename=name)

    @app.post("/api/projects/{pid}/assets/{aid}/processed-audio")
    def attach_processed_audio(pid: str, aid: str, body: AudioAssetIn):
        return svc.attach_processed_audio(pid, aid, body.audio_asset_id)

    @app.delete("/api/projects/{pid}/assets/{aid}/processed-audio", status_code=204)
    def detach_processed_audio(pid: str, aid: str):
        svc.detach_processed_audio(pid, aid)

    @app.get("/api/projects/{pid}/assets/{aid}/speakers")
    def get_speakers(pid: str, aid: str):
        return svc.speakers(pid, aid)

    @app.patch("/api/projects/{pid}/assets/{aid}/speakers")
    def patch_speakers(pid: str, aid: str, body: SpeakersPatch):
        return svc.update_speakers(pid, aid, body.labels)

    @app.post("/api/projects/{pid}/assets/{aid}/diarize", status_code=201)
    def diarize(pid: str, aid: str, body: DiarizeIn):
        return svc.rediarize(pid, aid, body.num_speakers)

    @app.get("/api/projects/{pid}/brief")
    def get_brief(pid: str):
        return svc.project_brief(pid)

    @app.patch("/api/projects/{pid}/brief")
    def patch_brief(pid: str, body: BriefPatch):
        return svc.update_brief(pid, body.fields, "manual", body.replace)

    @app.get("/api/projects/{pid}/versions/{vid}/compliance")
    def compliance(pid: str, vid: str):
        return svc.version_compliance(pid, vid)

    @app.post("/api/projects/{pid}/auto-edit", status_code=201)
    def auto_edit(pid: str, body: AutoEditIn):
        return svc.auto_edit_proposal(pid, body.asset_id, body.options, name=body.name[:120] or "Podcast auto-edit")

    @app.get("/api/projects/{pid}/search")
    def search(pid: str, q: str, limit: int = 30):
        return svc.search(pid, q, min(limit, 100))

    # --- sequences / versions ------------------------------------------------------------------------
    @app.get("/api/projects/{pid}/sequences")
    def sequences(pid: str):
        return svc.list_sequences(pid)

    @app.post("/api/projects/{pid}/sequences", status_code=201)
    def create_sequence(pid: str, body: SequenceIn):
        if body.timeline:
            svc.checked_timeline(pid, body.timeline)
        seq = svc.create_sequence(pid, body.name)
        if body.timeline:
            svc.save_version(pid, seq["id"], body.timeline, "Created manually", "manual")
        return svc.get_sequence(pid, seq["id"])

    @app.delete("/api/projects/{pid}/sequences/{sid}", status_code=204)
    def delete_sequence(pid: str, sid: str):
        svc.delete_sequence(pid, sid)

    @app.post("/api/projects/{pid}/sequences/{sid}/versions", status_code=201)
    def save_version(pid: str, sid: str, body: VersionIn):
        return svc.save_version(pid, sid, body.timeline, body.label, "manual")

    @app.get("/api/projects/{pid}/versions/{vid}")
    def get_version(pid: str, vid: str):
        version = svc.get_version(pid, vid)
        version["stats"] = timeline_stats(version["timeline"])
        return version

    @app.post("/api/projects/{pid}/versions/{vid}/restore", status_code=201)
    def restore_version(pid: str, vid: str):
        return svc.restore_version(pid, vid)

    @app.get("/api/projects/{pid}/compare")
    def compare(pid: str, a: str, b: str):
        va, vb = svc.get_version(pid, a), svc.get_version(pid, b)
        key = lambda c: (c["asset_id"], round(c["start"], 2), round(c["end"], 2))
        ca, cb = Counter(map(key, va["timeline"]["clips"])), Counter(map(key, vb["timeline"]["clips"]))
        as_list = lambda counter: [dict(zip(("asset_id", "start", "end"), k)) for k in sorted(counter.elements())]
        return {"a": {"id": a, "number": va["number"], **timeline_stats(va["timeline"])},
                "b": {"id": b, "number": vb["number"], **timeline_stats(vb["timeline"])},
                "only_in_a": as_list(ca - cb), "only_in_b": as_list(cb - ca),
                "shared_clips": sum((ca & cb).values())}

    # --- proposals -----------------------------------------------------------------------------------
    @app.get("/api/projects/{pid}/proposals")
    def proposals(pid: str):
        return svc.list_proposals(pid)

    @app.post("/api/projects/{pid}/proposals/{prid}/approve")
    def approve(pid: str, prid: str):
        return svc.approve_proposal(pid, prid)

    @app.post("/api/projects/{pid}/proposals/{prid}/reject")
    def reject(pid: str, prid: str):
        return svc.reject_proposal(pid, prid)

    # --- chat ----------------------------------------------------------------------------------------
    @app.get("/api/projects/{pid}/chat")
    def chat_history(pid: str):
        project(pid)
        return {"mode": bot.mode, "messages": bot.history(pid)}

    @app.post("/api/projects/{pid}/chat")
    def chat(pid: str, body: ChatIn):
        return bot.chat(pid, body.message)

    @app.delete("/api/projects/{pid}/chat", status_code=204)
    def clear_chat(pid: str):
        project(pid)
        bot.clear(pid)

    # --- renders & jobs --------------------------------------------------------------------------------
    @app.post("/api/projects/{pid}/renders", status_code=201)
    def render(pid: str, body: RenderIn):
        return svc.request_render(pid, body.version_id, body.quality, body.wav)

    @app.post("/api/projects/{pid}/renders/{rid}/reimport", status_code=201)
    def reimport(pid: str, rid: str, body: AudioAssetIn):
        return svc.reimport_render_audio(pid, rid, body.audio_asset_id)

    @app.get("/api/projects/{pid}/renders")
    def renders(pid: str):
        return svc.list_renders(pid)

    @app.get("/api/projects/{pid}/renders/{rid}/{kind}")
    def render_file(pid: str, rid: str, kind: str, download: bool = False):
        if kind not in ("mp4", "srt", "wav"):
            raise NotFound("Unknown file kind")
        path = svc.render_file(pid, rid, kind)
        render = svc.get_render(pid, rid)
        name = f"cutcue-{render['quality']}-{rid}.{kind}"
        media_type = {"mp4": "video/mp4", "srt": "application/x-subrip", "wav": "audio/wav"}[kind]
        return FileResponse(path, media_type=media_type, filename=name if download else None)

    @app.get("/api/projects/{pid}/jobs")
    def jobs(pid: str):
        project(pid)
        return svc.list_jobs(pid)

    @app.post("/api/projects/{pid}/jobs/{jid}/retry")
    def retry(pid: str, jid: str):
        try:
            return svc.retry_job(pid, jid)
        except ValueError as exc:
            raise BadRequest(str(exc)) from exc

    @app.post("/api/projects/{pid}/jobs/{jid}/cancel")
    def cancel(pid: str, jid: str):
        try:
            svc.cancel_job(pid, jid)
        except ValueError as exc:
            raise BadRequest(str(exc)) from exc
        return {"ok": True}

    # --- validation (scripts/validate.py): Chrome reports real playback results here ----------------------
    app.state.playback_reports = []

    @app.post("/api/validation/playback")
    def playback_report(body: dict):
        app.state.playback_reports.append(body)
        del app.state.playback_reports[:-50]
        return {"ok": True}

    @app.get("/api/validation/playback")
    def playback_reports():
        return app.state.playback_reports

    # --- built frontend (make start) ----------------------------------------------------------------------
    static_dir = ROOT / "frontend" / "out"
    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")

    return app
