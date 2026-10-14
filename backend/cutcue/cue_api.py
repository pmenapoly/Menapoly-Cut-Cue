"""HTTP routes for the Menapoly Cue 2.0 layer, the public review/upload/webhook endpoints, and the
versioned Cut Cue integration contract (``/api/v1``). Registered by ``main.create_app``.

Auth model (single owner):
- ``/api/cue/*`` and ``/api/v1/*`` sit behind the same owner session as the rest of ``/api/*``.
- ``/api/public/*`` is reachable without the owner session but every route is scoped by an unguessable,
  hashed, revocable, expiring token (review and upload links) or by a provider signature (Cue Text webhook),
  and is rate-limited per client address.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from urllib.parse import parse_qsl

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import __version__
from .ask import AskCue
from .cue import ACTION_POLICY, RISK_TEXT, STAGE_LABELS, STAGES, Cue
from .services import BadRequest, NotFound, Services
from .text import CueText, parse_twilio, verify_twilio

CONTRACT_VERSION = "1.0"
MAX_CHUNK = 64 * 1024 * 1024


class RateLimiter:
    """Small in-memory sliding window, per (bucket, client address)."""

    def __init__(self):
        self._hits: dict[tuple[str, str], deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, request: Request, bucket: str, limit: int, window: float = 60.0) -> None:
        key = (bucket, request.client.host if request.client else "?")
        t = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] < t - window:
                hits.popleft()
            if len(hits) >= limit:
                raise HTTPException(429, "Too many requests. Wait a minute and try again.")
            hits.append(t)


class CueProjectIn(BaseModel):
    name: str
    client: str = ""


class ProjectMetaIn(BaseModel):
    client_id: str | None = None
    client_name: str | None = None
    clear_client: bool = False
    stage: str | None = None
    archived: bool | None = None


class ClientIn(BaseModel):
    name: str
    contact: str = ""
    notes: str = ""


class AskIn(BaseModel):
    message: str


class ActionIn(BaseModel):
    kind: str
    project_id: str | None = None
    args: dict = {}
    reason: str = ""


class ReviewLinkIn(BaseModel):
    render_id: str | None = None
    label: str = ""
    allow_download: bool = False
    days: int = 30


class ReviewEventIn(BaseModel):
    kind: str
    author: str
    body: str = ""
    at_seconds: float | None = None


class ResolveIn(BaseModel):
    resolved: bool = True


class LibraryIn(BaseModel):
    kind: str
    name: str
    data: dict = {}


class UploadIn(BaseModel):
    filename: str
    size: int = Field(gt=0)


class SenderIn(BaseModel):
    phone: str
    name: str
    consent: bool = False
    consent_note: str = ""


class SimulateIn(BaseModel):
    from_number: str
    body: str = ""
    media: list[dict] = []
    message_id: str | None = None


class AssetRefIn(BaseModel):
    """v1 asset registration by reference: tell Cut Cue about media that already went through an upload."""
    upload_id: str


class JobIn(BaseModel):
    type: str
    args: dict = {}


def register(app: FastAPI, svc: Services, cue: Cue, ask: AskCue, text: CueText) -> None:
    limiter = RateLimiter()
    app.state.cue, app.state.ask, app.state.text = cue, ask, text

    async def read_chunk(request: Request) -> bytes:
        data = bytearray()
        async for part in request.stream():
            data.extend(part)
            if len(data) > MAX_CHUNK:
                raise HTTPException(413, "Chunk too large")
        return bytes(data)

    # --- shell data ------------------------------------------------------------------------------------
    @app.get("/api/cue/home")
    def home():
        return cue.home()

    @app.get("/api/cue/meta")
    def meta():
        return {"stages": [{"id": s, "label": STAGE_LABELS[s]} for s in STAGES],
                "actions": {k: {**v, "risk_text": RISK_TEXT[v["risk"]]} for k, v in ACTION_POLICY.items()},
                "ask_mode": ask.mode, "ask_budget_usd": ask.budget, "ask_spent_usd": round(ask.spent(), 4),
                "text": text.status(), "public_url": svc.settings.public_url or None}

    @app.get("/api/cue/search")
    def search(q: str = ""):
        return cue.search(q[:200]) if q.strip() else {"projects": [], "moments": [], "media": []}

    # --- projects & clients --------------------------------------------------------------------------
    @app.get("/api/cue/projects")
    def projects(q: str = "", client_id: str = "", stage: str = "", archived: bool = False):
        return cue.project_cards(query=q[:120], client_id=client_id, stage=stage, archived=archived)

    @app.post("/api/cue/projects", status_code=201)
    def create_project(body: CueProjectIn):
        project = svc.create_project(body.name)
        if body.client.strip():
            cue.update_project_meta(project["id"], client_id=cue.create_client(body.client)["id"])
        return cue.project_card(project["id"])

    @app.get("/api/cue/projects/{pid}")
    def project_overview(pid: str):
        return cue.project_overview(pid)

    @app.patch("/api/cue/projects/{pid}")
    def project_meta(pid: str, body: ProjectMetaIn):
        client_id = body.client_id
        if body.client_name and body.client_name.strip():
            client_id = cue.create_client(body.client_name)["id"]
        return cue.update_project_meta(pid, client_id=client_id, clear_client=body.clear_client, stage=body.stage,
                                       archived=body.archived)

    @app.get("/api/cue/clients")
    def clients():
        return cue.list_clients()

    @app.post("/api/cue/clients", status_code=201)
    def create_client(body: ClientIn):
        return cue.create_client(body.name, body.contact, body.notes)

    # --- notifications -------------------------------------------------------------------------------
    @app.get("/api/cue/notifications")
    def notifications(limit: int = 30, before: float | None = None, unread: bool = False):
        return cue.notifications(limit, before, unread)

    @app.post("/api/cue/notifications/read")
    def mark_all_read():
        return {"updated": cue.mark_read()}

    @app.post("/api/cue/notifications/{nid}/read")
    def mark_read(nid: str):
        return {"updated": cue.mark_read(nid)}

    # --- actions (approval-gated) -----------------------------------------------------------------------
    @app.get("/api/cue/actions")
    def actions(status: str | None = None, project_id: str | None = None):
        return cue.list_actions(status=status, project_id=project_id)

    @app.post("/api/cue/actions", status_code=201)
    def propose(body: ActionIn):
        return cue.propose_action(body.kind, body.args, project_id=body.project_id, created_by="user", reason=body.reason)

    @app.post("/api/cue/actions/{aid}/approve")
    def approve(aid: str):
        return cue.approve_action(aid)

    @app.post("/api/cue/actions/{aid}/reject")
    def reject(aid: str):
        return cue.reject_action(aid)

    # --- Ask Cue ------------------------------------------------------------------------------------
    @app.get("/api/cue/ask")
    def ask_history():
        return {"mode": ask.mode, "messages": ask.history(), "budget_usd": ask.budget, "spent_usd": round(ask.spent(), 4)}

    @app.post("/api/cue/ask")
    def ask_message(body: AskIn):
        result = ask.ask(body.message)
        result["actions"] = [cue.get_action(a) for a in result.get("action_ids", [])]
        return result

    @app.delete("/api/cue/ask", status_code=204)
    def ask_clear():
        ask.clear()

    # --- review links (owner side) ------------------------------------------------------------------------
    @app.get("/api/cue/projects/{pid}/review-links")
    def review_links(pid: str):
        svc.get_project(pid)
        return cue.list_review_links(pid)

    @app.post("/api/cue/projects/{pid}/review-links", status_code=201)
    def create_review_link(pid: str, body: ReviewLinkIn):
        return cue.create_review_link(pid, body.render_id, body.label, body.allow_download, body.days)

    @app.post("/api/cue/projects/{pid}/review-links/{lid}/revoke")
    def revoke_review_link(pid: str, lid: str):
        return cue.revoke_review_link(pid, lid)

    @app.post("/api/cue/projects/{pid}/feedback/{eid}")
    def resolve_feedback(pid: str, eid: str, body: ResolveIn):
        return cue.resolve_feedback(pid, eid, body.resolved)

    @app.post("/api/cue/projects/{pid}/upload-links", status_code=201)
    def create_upload_link(pid: str):
        return cue.create_upload_link(pid)

    # --- library ---------------------------------------------------------------------------------------
    @app.get("/api/cue/library")
    def library(kind: str = "", q: str = ""):
        return cue.library(kind=kind, query=q[:120])

    @app.post("/api/cue/library", status_code=201)
    def library_add(body: LibraryIn):
        return cue.save_library_item(body.kind, body.name, body.data)

    @app.put("/api/cue/library/{item_id}")
    def library_update(item_id: str, body: LibraryIn):
        return cue.save_library_item(body.kind, body.name, body.data, item_id)

    @app.delete("/api/cue/library/{item_id}", status_code=204)
    def library_delete(item_id: str):
        cue.delete_library_item(item_id)

    # --- Cue Text (owner side) ------------------------------------------------------------------------------
    @app.get("/api/cue/text")
    def text_status():
        return {**text.status(), "senders": text.senders(), "messages": text.messages(50)}

    @app.post("/api/cue/text/senders", status_code=201)
    def text_add_sender(body: SenderIn):
        return text.add_sender(body.phone, body.name, body.consent, body.consent_note)

    @app.delete("/api/cue/text/senders/{sid}", status_code=204)
    def text_remove_sender(sid: str):
        text.remove_sender(sid)

    @app.post("/api/cue/text/simulate", status_code=201)
    def text_simulate(body: SimulateIn):
        """Owner-only test console: runs the real intake pipeline with provider 'simulator'. Sends nothing."""
        import secrets

        return text.receive("simulator", body.message_id or f"SIM{secrets.token_hex(8)}", body.from_number,
                            text.config.number or "+10000000000", body.body, body.media)

    @app.post("/api/cue/text/messages/{mid}/retry")
    def text_retry(mid: str):
        return text.reprocess(mid)

    # --- public: client review ---------------------------------------------------------------------------
    @app.get("/api/public/review/{token}")
    def public_review(token: str, request: Request):
        limiter.check(request, "review-view", 120)
        return cue.review_view(token)

    @app.get("/api/public/review/{token}/media")
    def public_review_media(token: str, request: Request):
        limiter.check(request, "review-media", 600)
        path, _ = cue.review_file(token, "mp4")
        return FileResponse(path, media_type="video/mp4")

    @app.get("/api/public/review/{token}/download")
    def public_review_download(token: str, request: Request):
        limiter.check(request, "review-media", 600)
        path, link = cue.review_file(token, "mp4")
        if not link["allow_download"]:
            raise HTTPException(403, "Downloads are turned off for this link.")
        return FileResponse(path, media_type="video/mp4", filename=f"{link['label'] or 'review'}.mp4")

    @app.get("/api/public/review/{token}/captions")
    def public_review_captions(token: str, request: Request):
        limiter.check(request, "review-media", 600)
        path, _ = cue.review_file(token, "srt")
        return FileResponse(path, media_type="application/x-subrip")

    @app.post("/api/public/review/{token}/events", status_code=201)
    def public_review_event(token: str, body: ReviewEventIn, request: Request):
        limiter.check(request, "review-post", 20)
        row = cue.post_review_event(token, body.kind, body.author, body.body, body.at_seconds)
        return {k: row[k] for k in ("id", "kind", "author", "body", "at_seconds", "created_at")}

    # --- public: upload links (mobile / text fallback) ------------------------------------------------------
    @app.get("/api/public/upload/{token}")
    def public_upload_info(token: str, request: Request):
        limiter.check(request, "upload", 120)
        return cue.upload_link_info(token)

    @app.post("/api/public/upload/{token}", status_code=201)
    def public_upload_init(token: str, body: UploadIn, request: Request):
        limiter.check(request, "upload", 120)
        link = cue.use_upload_link(token)
        up = svc.init_upload(link["project_id"], body.filename, body.size)
        return {"id": up["id"], "received": up.get("received", 0)}

    @app.get("/api/public/upload/{token}/{uid}")
    def public_upload_status(token: str, uid: str, request: Request):
        limiter.check(request, "upload", 600)
        link = cue.upload_link(token)
        return {"received": svc.get_upload(link["project_id"], uid)["received"]}

    @app.put("/api/public/upload/{token}/{uid}")
    async def public_upload_chunk(token: str, uid: str, offset: int, request: Request):
        limiter.check(request, "upload-chunk", 2000)
        link = await run_in_threadpool(cue.upload_link, token)
        data = await read_chunk(request)
        up = await run_in_threadpool(svc.write_chunk, link["project_id"], uid, offset, data)
        return {"received": up["received"]}

    @app.post("/api/public/upload/{token}/{uid}/complete")
    def public_upload_complete(token: str, uid: str, request: Request):
        limiter.check(request, "upload", 120)
        link = cue.upload_link(token)
        asset = svc.complete_upload(link["project_id"], uid)
        cue.notify("upload_link", f"New file uploaded: {asset['original_name']}", body=svc.get_project(link["project_id"])["name"],
                   project_id=link["project_id"], href=f"/projects/?id={link['project_id']}", source_key=f"upload:{asset['id']}")
        return {"name": asset["original_name"], "status": asset["status"]}

    # --- public: Cue Text webhook ------------------------------------------------------------------------
    @app.post("/api/public/text/{provider}")
    async def text_webhook(provider: str, request: Request):
        limiter.check(request, "text-webhook", 120)
        if provider != "twilio" or text.config.provider != "twilio" or not text.config.inbound_ready:
            raise HTTPException(503, "Cue Text is not configured")
        if not request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded"):
            raise HTTPException(415, "Expected a form-encoded webhook")
        raw = await request.body()
        if len(raw) > 64 * 1024:
            raise HTTPException(413, "Webhook body too large")
        params = dict(parse_qsl(raw.decode("utf-8", "replace"), keep_blank_values=True))
        if not verify_twilio(text.config.auth_token, text.config.webhook_url, params,
                             request.headers.get("X-Twilio-Signature", "")):
            raise HTTPException(403, "Signature check failed")
        msg = parse_twilio(params)
        await run_in_threadpool(text.receive, "twilio", msg["provider_id"], msg["from"], msg["to"], msg["body"], msg["media"])
        # Empty TwiML: acknowledge without replying (Cue never sends from this webhook).
        return PlainTextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', media_type="application/xml")

    # --- v1 integration contract (docs/cue2/api-contract-v1.md) --------------------------------------------
    def asset_v1(a: dict) -> dict:
        return {"id": a["id"], "project_id": a["project_id"], "kind": a["kind"], "name": a["original_name"], "status": a["status"],
                "sha256": a.get("sha256"), "size": a["size"], "duration": a["duration"], "has_transcript": a.get("has_transcript"),
                "error": a.get("error")}

    def job_v1(j: dict) -> dict:
        return {"id": j["id"], "project_id": j["project_id"], "type": j["type"], "status": j["status"],
                "stage": j.get("message"), "error": j.get("error"), "created_at": j["created_at"],
                "started_at": j.get("started_at"), "finished_at": j.get("finished_at")}

    def render_v1(r: dict) -> dict:
        return {"id": r["id"], "project_id": r["project_id"], "version_id": r["version_id"], "status": r["status"],
                "quality": r["quality"], "preset": r.get("preset"), "duration": r["duration"],
                "files": {k: f"/api/projects/{r['project_id']}/renders/{r['id']}/{k}" for k, col in
                          (("mp4", "output_name"), ("srt", "srt_name"), ("wav", "wav_name")) if r.get(col)}}

    @app.get("/api/v1/contract")
    def contract():
        return {"contract": CONTRACT_VERSION, "app": "Menapoly Cut Cue", "app_version": __version__,
                "resources": ["projects", "assets", "jobs", "proposals", "versions", "renders", "review_links"],
                "job_types": ["auto_edit", "clip_factory", "render"],
                "guarantees": ["Edits are proposals until approved", "Job status never reports invented progress",
                               "Assets are identified by id and sha256; identical uploads are not copied again"]}

    @app.get("/api/v1/projects/{pid}")
    def v1_project(pid: str):
        c = cue.project_card(pid)
        return {"id": c["id"], "name": c["name"], "client": c["client_name"], "stage": c["stage"], "status": c["status"]["key"],
                "created_at": c["created_at"], "archived": bool(c["archived_at"])}

    @app.get("/api/v1/projects/{pid}/assets")
    def v1_assets(pid: str):
        return [asset_v1(a) for a in svc.list_assets(pid)]

    @app.post("/api/v1/projects/{pid}/assets", status_code=201)
    def v1_register(pid: str, body: AssetRefIn):
        """Register a completed upload. If identical bytes already exist in the project, that asset is returned
        instead of storing a second copy."""
        up = svc.get_upload(pid, body.upload_id)
        return asset_v1(svc.complete_upload(pid, up["id"]))

    @app.get("/api/v1/projects/{pid}/jobs")
    def v1_jobs(pid: str):
        svc.get_project(pid)
        return [job_v1(j) for j in svc.list_jobs(pid)]

    @app.get("/api/v1/projects/{pid}/jobs/{jid}")
    def v1_job(pid: str, jid: str):
        job = next((j for j in svc.list_jobs(pid, 500) if j["id"] == jid), None)
        if not job:
            raise NotFound("Job not found")
        return job_v1(job)

    @app.post("/api/v1/projects/{pid}/jobs", status_code=201)
    def v1_create_job(pid: str, body: JobIn):
        """Create work. Edit jobs return a *proposal* (nothing changes until approved); render jobs need an
        existing saved version."""
        a = body.args or {}
        if body.type == "auto_edit":
            asset = svc._primary_media(pid, a.get("asset_id"))
            p = svc.auto_edit_proposal(pid, asset["id"], a.get("options"), created_by="api-v1")
            return {"type": "proposal", "proposal_id": p["id"], "status": p["status"]}
        if body.type == "clip_factory":
            p = svc.clip_factory_proposal(pid, a.get("asset_id"), a.get("count"), created_by="api-v1")
            return {"type": "proposal", "proposal_id": p["id"], "status": p["status"]}
        if body.type == "render":
            if not a.get("version_id"):
                raise BadRequest("args.version_id is required")
            r = svc.request_render(pid, a["version_id"], a.get("quality", "preview"), bool(a.get("wav")), a.get("preset"))
            return {"type": "render", "render_id": r["id"], "job_id": r["job_id"], "status": r["status"]}
        raise BadRequest("type must be auto_edit, clip_factory or render")

    @app.get("/api/v1/projects/{pid}/proposals")
    def v1_proposals(pid: str):
        svc.get_project(pid)
        return [{"id": p["id"], "title": p["title"], "status": p["status"], "created_by": p["created_by"], "created_at": p["created_at"],
                 "sequences": [{"name": s["name"], "duration": s["duration"], "clips": s["clip_count"]} for s in p["plan"]["sequences"]],
                 "result": p["result"]} for p in svc.list_proposals(pid)]

    @app.get("/api/v1/projects/{pid}/versions")
    def v1_versions(pid: str):
        return [{"sequence_id": s["id"], "name": s["name"], "current_version_id": s["current_version_id"],
                 "versions": s["versions"]} for s in svc.list_sequences(pid)]

    @app.get("/api/v1/projects/{pid}/versions/{vid}")
    def v1_version(pid: str, vid: str):
        v = svc.get_version(pid, vid)
        return {"id": v["id"], "sequence_id": v["sequence_id"], "number": v["number"], "timeline": v["timeline"]}

    @app.get("/api/v1/projects/{pid}/renders")
    def v1_renders(pid: str):
        svc.get_project(pid)
        return [render_v1(r) for r in svc.list_renders(pid)]

    @app.get("/api/v1/projects/{pid}/review-links")
    def v1_review_links(pid: str):
        svc.get_project(pid)
        return cue.list_review_links(pid)
