// Owner/editor API (Cloudflare Access) and the public, token-scoped review API. Versioned under /v1.
import { Person, requireOwner } from "./auth";
import * as s3 from "./s3";
import { audit, body, emit, Env, HttpError, idempotent, jobEvent, json, newId, now, randomToken, rateLimit, safeName,
         sha256Hex, str } from "./util";

const MiB = 1024 * 1024;
const TYPES: Record<string, { media: string; maxBytes: (env: Env) => number }> = {};
const add = (media: string, max: (env: Env) => number, ...types: string[]) => types.forEach((t) => (TYPES[t] = { media, maxBytes: max }));
const videoMax = (env: Env) => Number(env.MAX_VIDEO_GB || 20) * 1024 * MiB;
add("video", videoMax, "video/mp4", "video/quicktime", "video/x-m4v", "video/webm");
add("audio", (env) => Math.min(videoMax(env), 4 * 1024 * MiB), "audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg",
    "audio/mp4", "audio/x-m4a", "audio/aac", "audio/flac", "audio/ogg", "audio/aiff", "audio/x-aiff");
add("image", () => 200 * MiB, "image/jpeg", "image/png", "image/heic", "image/heif");
add("document", () => 50 * MiB, "application/pdf", "text/plain", "text/markdown",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
add("document", () => 10 * MiB, "application/x-subrip", "text/vtt");
const EXT: Record<string, string[]> = {
  "video/mp4": ["mp4"], "video/quicktime": ["mov"], "video/x-m4v": ["m4v"], "video/webm": ["webm"],
  "audio/wav": ["wav"], "audio/x-wav": ["wav"], "audio/wave": ["wav"], "audio/mpeg": ["mp3"], "audio/mp4": ["m4a"],
  "audio/x-m4a": ["m4a"], "audio/aac": ["aac"], "audio/flac": ["flac"], "audio/ogg": ["ogg"], "audio/aiff": ["aif", "aiff"],
  "audio/x-aiff": ["aif", "aiff"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/heic": ["heic"],
  "image/heif": ["heif"], "application/pdf": ["pdf"], "text/plain": ["txt"], "text/markdown": ["md"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"], "application/x-subrip": ["srt"],
  "text/vtt": ["vtt"],
};
const MIN_PART = 5 * MiB, MAX_PART = 100 * MiB;
const STAGES = ["proposed", "approved", "rejected"];

async function project(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND archived_at IS NULL").bind(id).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "Project not found");
  return row;
}

// --- projects ------------------------------------------------------------------------------------------
export async function listProjects(env: Env) {
  const { results } = await env.DB.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id AND a.kind = 'source' AND a.status = 'ready') AS source_count,
      (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id AND j.status IN ('queued','leased','running')) AS active_jobs,
      (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id AND a.kind = 'output' AND a.status = 'ready') AS output_count
      FROM projects p WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 200`).all();
  return json(results);
}

export async function createProject(request: Request, env: Env, me: Person) {
  const b = await body(request);
  return idempotent(env, `${me.email}:create_project`, request.headers.get("idempotency-key"), async () => {
    const p = { id: newId("prj"), name: str(b.name, "name", { max: 120 }), client: str(b.client, "client", { max: 120, required: false }) || null };
    const t = now();
    await env.DB.prepare("INSERT INTO projects (id, name, client, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(p.id, p.name, p.client, me.email, t, t).run();
    await audit(env, me.email, "project.create", p.id, { name: p.name });
    return json({ ...p, budget_usd: 5, created_at: t }, 201);
  });
}

export async function getProject(env: Env, id: string) {
  const p = await project(env, id);
  const [assets, jobs, versions, links, spent] = await Promise.all([
    env.DB.prepare("SELECT id, kind, media_type, name, content_type, size, sha256, status, source_job_id, created_at, verified_at FROM assets WHERE project_id = ? AND status != 'failed' ORDER BY created_at").bind(id).all(),
    env.DB.prepare("SELECT id, type, target, status, stage, progress, error, attempts, max_attempts, created_at, updated_at, started_at, finished_at, params_json, result_json FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50").bind(id).all(),
    env.DB.prepare("SELECT id, number, status, label, source_job_id, created_by, created_at, decided_at FROM timeline_versions WHERE project_id = ? ORDER BY number DESC").bind(id).all(),
    env.DB.prepare("SELECT id, asset_id, label, created_at, expires_at, revoked_at, allow_download FROM review_links WHERE project_id = ? ORDER BY created_at DESC").bind(id).all(),
    env.DB.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM cost_ledger WHERE project_id = ?").bind(id).first<{ usd: number }>(),
  ]);
  const feedback = await env.DB.prepare("SELECT id, link_id, kind, author, body, at_seconds, created_at FROM review_events WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").bind(id).all();
  return json({ project: { ...p, spent_usd: spent?.usd ?? 0 }, assets: assets.results,
    jobs: jobs.results.map(jobView), versions: versions.results, review_links: links.results.map((l) => ({ ...l, active: !l.revoked_at && Number(l.expires_at) > now() })),
    feedback: feedback.results });
}

export async function setBudget(request: Request, env: Env, me: Person, id: string) {
  requireOwner(me);
  await project(env, id);
  const usd = Number((await body(request)).budget_usd);
  if (!Number.isFinite(usd) || usd < 0 || usd > 1000) throw new HttpError(400, "budget_usd must be between 0 and 1000");
  await env.DB.prepare("UPDATE projects SET budget_usd = ?, updated_at = ? WHERE id = ?").bind(usd, now(), id).run();
  await audit(env, me.email, "project.budget", id, { usd });
  return json({ ok: true, budget_usd: usd });
}

// --- uploads (direct to storage, resumable) -------------------------------------------------------------
export async function createUpload(request: Request, env: Env, me: Person, projectId: string) {
  await project(env, projectId);
  await rateLimit(env, `upload:${me.email}`, 60);
  const b = await body(request);
  const filename = safeName(str(b.filename, "filename", { max: 255 }));
  const contentType = str(b.content_type, "content_type", { max: 100 }).toLowerCase();
  const size = Number(b.size), sha256 = String(b.sha256 || "").toLowerCase();
  const kind = TYPES[contentType];
  if (!kind) throw new HttpError(415, `File type ${contentType} is not accepted.`);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!EXT[contentType]?.includes(ext)) throw new HttpError(415, `The file name (.${ext}) doesn't match its type (${contentType}).`);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, "size must be a positive integer");
  if (size > kind.maxBytes(env)) throw new HttpError(413, `File is larger than the ${Math.round(kind.maxBytes(env) / MiB)} MB limit for ${kind.media}.`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, "sha256 (hex) of the file is required");
  let partSize = Number(b.part_size || 8 * MiB);
  if (!Number.isSafeInteger(partSize) || partSize < MIN_PART || partSize > MAX_PART) throw new HttpError(400, "part_size must be 5-100 MiB");
  if (Math.ceil(size / partSize) > 10000) partSize = Math.ceil(size / 10000);
  const partCount = Math.max(1, Math.ceil(size / partSize));
  return idempotent(env, `${me.email}:upload:${projectId}`, request.headers.get("idempotency-key"), async () => {
    const assetId = newId("ast"), sessionId = newId("ups");
    const key = `projects/${projectId}/sources/${assetId}/${filename}`;
    const uploadId = await s3.createMultipart(env, key, contentType);
    const t = now(), expires = t + Number(env.UPLOAD_SESSION_HOURS || 24) * 3600;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO assets (id, project_id, kind, media_type, name, content_type, size, sha256, object_key, status, created_by, created_at)
                      VALUES (?, ?, 'source', ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`)
        .bind(assetId, projectId, kind.media, filename, contentType, size, sha256, key, me.email, t),
      env.DB.prepare(`INSERT INTO upload_sessions (id, project_id, asset_id, object_key, s3_upload_id, filename, content_type, size, part_size,
                      part_count, sha256, status, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
        .bind(sessionId, projectId, assetId, key, uploadId, filename, contentType, size, partSize, partCount, sha256, me.email, t, expires),
    ]);
    await audit(env, me.email, "upload.create", sessionId, { projectId, assetId, filename, size, contentType });
    return json({ id: sessionId, asset_id: assetId, part_size: partSize, part_count: partCount, expires_at: expires }, 201);
  });
}

async function session(env: Env, id: string, me: Person) {
  const s = await env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!s) throw new HttpError(404, "Upload not found");
  if (s.created_by !== me.email && me.role !== "owner") throw new HttpError(403, "Not your upload");
  return s;
}

export async function uploadStatus(env: Env, me: Person, id: string) {
  const s = await session(env, id, me);
  let done: number[] = [];
  if (s.status === "open") done = ((await s3.listParts(env, s.object_key, s.s3_upload_id)) ?? []).map((p) => p.number);
  return json({ id: s.id, asset_id: s.asset_id, status: s.status, size: s.size, part_size: s.part_size, part_count: s.part_count,
                parts_done: done, expires_at: s.expires_at });
}

export async function partUrls(request: Request, env: Env, me: Person, id: string) {
  const s = await session(env, id, me);
  if (s.status !== "open" || s.expires_at < now()) throw new HttpError(409, `This upload is ${s.status === "open" ? "expired" : s.status}.`);
  const parts = ((await body(request)).parts as unknown[] || []).map(Number);
  if (!parts.length || parts.length > 50 || parts.some((n) => !Number.isInteger(n) || n < 1 || n > s.part_count))
    throw new HttpError(400, `parts must be 1-50 part numbers between 1 and ${s.part_count}`);
  const urls = await Promise.all(parts.map(async (n) => ({ part: n, url: await s3.presignPart(env, s.object_key, s.s3_upload_id, n),
    size: n === s.part_count ? s.size - (s.part_count - 1) * s.part_size : s.part_size })));
  return json({ urls, expires_in: s3.PART_URL_TTL });
}

export async function completeUpload(env: Env, me: Person, id: string) {
  const s = await session(env, id, me);
  if (s.status === "completed") return json({ ok: true, asset_id: s.asset_id, already: true });
  if (s.status !== "open") throw new HttpError(409, `This upload is ${s.status}.`);
  const parts = (await s3.listParts(env, s.object_key, s.s3_upload_id)) ?? [];
  const missing = [];
  for (let n = 1; n <= s.part_count; n++) if (!parts.find((p) => p.number === n)) missing.push(n);
  if (missing.length) throw new HttpError(409, "Some parts haven't arrived yet.", { missing_parts: missing.slice(0, 100) });
  const wrong = parts.filter((p) => p.number <= s.part_count &&
    p.size !== (p.number === s.part_count ? s.size - (s.part_count - 1) * s.part_size : s.part_size));
  if (wrong.length) throw new HttpError(409, "A part has the wrong size; upload it again.", { bad_parts: wrong.map((p) => p.number) });
  await s3.completeMultipart(env, s.object_key, s.s3_upload_id, parts.filter((p) => p.number <= s.part_count));
  const stored = await s3.head(env, s.object_key);
  if (!stored || stored.size !== s.size) throw new HttpError(409, "The stored file size doesn't match. Upload it again.");
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE upload_sessions SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'open'").bind(t, id),
    env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?").bind(s.asset_id),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(t, s.project_id),
  ]);
  await audit(env, me.email, "upload.complete", id, { asset: s.asset_id, size: s.size });
  await emit(env, { type: "upload_complete", project_id: s.project_id, asset_id: s.asset_id, name: s.filename });
  return json({ ok: true, asset_id: s.asset_id });
}

export async function abortUpload(env: Env, me: Person, id: string) {
  const s = await session(env, id, me);
  if (s.status === "open") {
    await s3.abortMultipart(env, s.object_key, s.s3_upload_id);
    await env.DB.batch([
      env.DB.prepare("UPDATE upload_sessions SET status = 'aborted' WHERE id = ?").bind(id),
      env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = ? AND status = 'uploading'").bind(s.asset_id),
    ]);
    await audit(env, me.email, "upload.abort", id);
  }
  return json({ ok: true });
}

export async function assetUrl(env: Env, me: Person, id: string, download: boolean) {
  const a = await env.DB.prepare("SELECT a.* FROM assets a JOIN projects p ON p.id = a.project_id WHERE a.id = ? AND a.status = 'ready'")
    .bind(id).first<Record<string, any>>();
  if (!a) throw new HttpError(404, "File not found");
  await audit(env, me.email, download ? "asset.download" : "asset.view", id);
  return json({ url: await s3.presignGet(env, a.object_key, download ? a.name : undefined), expires_in: s3.GET_URL_TTL });
}

// --- jobs ---------------------------------------------------------------------------------------------------
export function jobView(j: Record<string, any>) {
  const { params_json, result_json, lease_token_hash, ...rest } = j;
  return { ...rest, params: params_json ? JSON.parse(params_json) : {}, result: result_json ? JSON.parse(result_json) : null };
}

export async function createJob(request: Request, env: Env, me: Person, projectId: string) {
  const p = await project(env, projectId);
  await rateLimit(env, `jobs:${me.email}`, 60);
  const b = await body(request);
  const type = String(b.type);
  if (!["transcribe", "auto_edit", "render"].includes(type)) throw new HttpError(400, "type must be transcribe, auto_edit or render");
  const target = b.target === "cloud" ? "cloud" : "mac";
  const params: Record<string, unknown> = {};
  let inputs: string[] = [];
  if (type === "render") {
    const v = await env.DB.prepare("SELECT * FROM timeline_versions WHERE id = ? AND project_id = ?").bind(String(b.version_id || ""), projectId).first<Record<string, any>>();
    if (!v) throw new HttpError(404, "Timeline version not found");
    if (v.status !== "approved") throw new HttpError(409, "Only an approved edit can be rendered. Approve it first.");
    const preset = String(b.preset || "youtube");
    if (!["youtube", "podcast", "tiktok", "reels", "linkedin", "preview"].includes(preset)) throw new HttpError(400, "Unknown preset");
    params.version_id = v.id; params.preset = preset; params.timeline = JSON.parse(v.timeline_json);
    inputs = [...new Set((params.timeline as { clips: { asset_id: string }[] }).clips.map((c) => c.asset_id))];
  } else {
    inputs = [String(b.asset_id || "")];
    if (b.hook !== undefined) params.hook = Boolean(b.hook);
  }
  const { results: found } = await env.DB.prepare(`SELECT id, media_type FROM assets WHERE project_id = ? AND kind = 'source' AND status = 'ready'
                                                   AND id IN (${inputs.map(() => "?").join(",") || "''"})`).bind(projectId, ...inputs).all<{ id: string; media_type: string }>();
  if (found.length !== inputs.length) throw new HttpError(400, "Every input must be a finished upload in this project");
  if (type !== "render" && !["video", "audio"].includes(found[0].media_type)) throw new HttpError(400, "Choose a video or audio file");
  const key = request.headers.get("idempotency-key") || (b.idempotency_key ? String(b.idempotency_key) : null);
  return idempotent(env, `${me.email}:job:${projectId}`, key, async () => {
    const id = newId("job"), t = now();
    let status = "queued";
    if (target === "cloud") {
      if (env.CLOUD_RENDERING !== "enabled") throw new HttpError(409, "Cloud processing is turned off. Jobs run on your Mac.");
      status = "awaiting_authorization"; // a paid cloud job never starts without an explicit authorization
    }
    await env.DB.prepare(`INSERT INTO jobs (id, project_id, type, target, status, params_json, input_asset_ids_json, idempotency_key, created_by, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, projectId, type, target, status, JSON.stringify(params), JSON.stringify(inputs), key, me.email, t, t).run();
    await jobEvent(env, id, "created", { by: me.email, target });
    await audit(env, me.email, "job.create", id, { type, target, project: p.id });
    return json({ id, status, type, target }, 201);
  });
}

export async function getJob(env: Env, id: string) {
  const j = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!j) throw new HttpError(404, "Job not found");
  const { results } = await env.DB.prepare("SELECT at, kind, detail_json FROM job_events WHERE job_id = ? ORDER BY id").bind(id).all();
  const workersOnline = await env.DB.prepare("SELECT COUNT(*) AS n FROM workers WHERE revoked_at IS NULL AND last_seen_at > ?").bind(now() - 120).first<{ n: number }>();
  return json({ ...jobView(j), events: results.map((e: any) => ({ at: e.at, kind: e.kind, detail: JSON.parse(e.detail_json) })),
                worker_online: (workersOnline?.n ?? 0) > 0 });
}

export async function cancelJob(env: Env, me: Person, id: string) {
  const r = await env.DB.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ?, finished_at = ?, lease_token_hash = NULL WHERE id = ? AND status IN ('queued','leased','running','awaiting_authorization')")
    .bind(now(), now(), id).run();
  if (!r.meta.changes) throw new HttpError(409, "This job can't be cancelled now");
  await jobEvent(env, id, "cancelled", { by: me.email });
  await audit(env, me.email, "job.cancel", id);
  return json({ ok: true });
}

export async function retryJob(env: Env, me: Person, id: string) {
  const r = await env.DB.prepare("UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, stage = NULL, progress = NULL, updated_at = ? WHERE id = ? AND status IN ('failed','dead','cancelled') AND target = 'mac'")
    .bind(now(), id).run();
  if (!r.meta.changes) throw new HttpError(409, "Only failed, dead-lettered or cancelled Mac jobs can be retried");
  await jobEvent(env, id, "retried", { by: me.email });
  await audit(env, me.email, "job.retry", id);
  return json({ ok: true });
}

export async function authorizeJob(request: Request, env: Env, me: Person, id: string) {
  requireOwner(me);
  const b = await body(request);
  const maxUsd = Number(b.max_usd);
  if (!(maxUsd > 0 && maxUsd <= 100)) throw new HttpError(400, "max_usd must be between 0 and 100");
  if (b.confirm !== "I authorize this paid cloud job") throw new HttpError(400, "Confirmation text required");
  if (env.CLOUD_RENDERING !== "enabled") throw new HttpError(409, "Cloud processing is turned off");
  const j = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND status = 'awaiting_authorization'").bind(id).first<Record<string, any>>();
  if (!j) throw new HttpError(409, "This job isn't waiting for authorization");
  const authId = newId("aut");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO authorizations (id, project_id, job_id, kind, max_usd, approved_by, created_at) VALUES (?, ?, ?, 'paid_cloud_render', ?, ?, ?)")
      .bind(authId, j.project_id, id, maxUsd, me.email, now()),
    env.DB.prepare("UPDATE jobs SET status = 'queued', authorization_id = ?, updated_at = ? WHERE id = ?").bind(authId, now(), id),
  ]);
  await audit(env, me.email, "job.authorize_paid", id, { maxUsd });
  return json({ ok: true, authorization_id: authId });
}

// --- timeline versions ------------------------------------------------------------------------------------
export async function decideVersion(request: Request, env: Env, me: Person, id: string) {
  const decision = String((await body(request)).decision);
  if (!["approved", "rejected"].includes(decision)) throw new HttpError(400, "decision must be approved or rejected");
  const r = await env.DB.prepare("UPDATE timeline_versions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'proposed'")
    .bind(decision, me.email, now(), id).run();
  if (!r.meta.changes) throw new HttpError(409, "This edit was already decided");
  await audit(env, me.email, `version.${decision}`, id);
  return json({ ok: true, status: decision });
}

export async function getVersion(env: Env, id: string) {
  const v = await env.DB.prepare("SELECT * FROM timeline_versions WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!v) throw new HttpError(404, "Version not found");
  const { timeline_json, ...rest } = v;
  return json({ ...rest, timeline: JSON.parse(timeline_json) });
}

// --- review links (owner) and public review ----------------------------------------------------------------
export async function createReviewLink(request: Request, env: Env, me: Person, projectId: string) {
  await project(env, projectId);
  const b = await body(request);
  const a = await env.DB.prepare("SELECT * FROM assets WHERE id = ? AND project_id = ? AND status = 'ready' AND media_type = 'video'")
    .bind(String(b.asset_id || ""), projectId).first<Record<string, any>>();
  if (!a) throw new HttpError(404, "Choose a finished video from this project");
  const hours = Math.min(Math.max(Number(b.hours || 72), 1), 24 * 14);   // short-lived: default 3 days, max 14
  const token = randomToken("rv_");
  const id = newId("rvl");
  await env.DB.prepare("INSERT INTO review_links (id, project_id, asset_id, token_hash, label, allow_download, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, projectId, a.id, await sha256Hex(token), str(b.label, "label", { max: 120, required: false }) || "Client review",
          b.allow_download ? 1 : 0, me.email, now(), now() + hours * 3600).run();
  await audit(env, me.email, "review_link.create", id, { hours });
  return json({ id, token, path: `/review.html#${token}`, expires_at: now() + hours * 3600 }, 201);
}

export async function revokeReviewLink(env: Env, me: Person, id: string) {
  await env.DB.prepare("UPDATE review_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), id).run();
  await audit(env, me.email, "review_link.revoke", id);
  return json({ ok: true });
}

async function linkByToken(env: Env, token: string) {
  if (!/^rv_[A-Za-z0-9_-]{30,60}$/.test(token)) throw new HttpError(404, "This review link isn't valid.");
  const l = await env.DB.prepare("SELECT * FROM review_links WHERE token_hash = ?").bind(await sha256Hex(token)).first<Record<string, any>>();
  if (!l) throw new HttpError(404, "This review link isn't valid.");
  if (l.revoked_at) throw new HttpError(410, "This review link was turned off.");
  if (l.expires_at <= now()) throw new HttpError(410, "This review link has expired. Ask for a new one.");
  return l;
}

export async function publicReview(request: Request, env: Env, token: string) {
  await rateLimit(env, `review:${request.headers.get("cf-connecting-ip") || "local"}`, 120);
  const l = await linkByToken(env, token);
  const a = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(l.asset_id).first<Record<string, any>>();
  const p = await env.DB.prepare("SELECT name FROM projects WHERE id = ?").bind(l.project_id).first<{ name: string }>();
  const { results } = await env.DB.prepare("SELECT kind, author, body, at_seconds, created_at FROM review_events WHERE link_id = ? ORDER BY created_at").bind(l.id).all();
  return json({ project_name: p?.name, label: l.label, expires_at: l.expires_at, video_url: await s3.presignGet(env, a!.object_key),
                download_url: l.allow_download ? await s3.presignGet(env, a!.object_key, a!.name) : null, url_expires_in: s3.GET_URL_TTL,
                events: results });
}

export async function publicReviewEvent(request: Request, env: Env, token: string) {
  await rateLimit(env, `review-post:${request.headers.get("cf-connecting-ip") || "local"}`, 20);
  const l = await linkByToken(env, token);
  const b = await body(request, 16 * 1024);
  const kind = String(b.kind);
  if (!["comment", "approved", "changes_requested"].includes(kind)) throw new HttpError(400, "Unknown review action");
  const author = str(b.author, "Your name", { max: 80 });
  const text = str(b.body, "note", { max: 4000, required: kind !== "approved" });
  const at = b.at_seconds == null ? null : Math.max(0, Number(b.at_seconds) || 0);
  const id = newId("rve");
  await env.DB.prepare("INSERT INTO review_events (id, link_id, project_id, kind, author, body, at_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, l.id, l.project_id, kind, author, text, at, now()).run();
  await audit(env, `review:${author}`, `review.${kind}`, l.id);
  await emit(env, { type: "review", project_id: l.project_id, event_id: id, kind, author, body: text });
  return json({ ok: true, id }, 201);
}

// --- notifications, workers, costs, status ------------------------------------------------------------------
export async function notifications(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100").all();
  const unread = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").first<{ n: number }>();
  return json({ items: results, unread: unread?.n ?? 0 });
}

export async function markRead(env: Env) {
  await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").bind(now()).run();
  return json({ ok: true });
}

export async function registerWorker(request: Request, env: Env, me: Person) {
  requireOwner(me);
  const name = str((await body(request)).name, "name", { max: 80 });
  const id = newId("wkr");
  const secret = randomToken("", 32);
  await env.DB.prepare("INSERT INTO workers (id, name, secret_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, name, await sha256Hex(secret), me.email, now()).run();
  await audit(env, me.email, "worker.register", id, { name });
  return json({ id, name, token: `cqw_${id}.${secret}`, note: "Shown once. Put it in the Mac worker's config." }, 201);
}

export async function listWorkers(env: Env) {
  const { results } = await env.DB.prepare("SELECT id, name, capabilities_json, version, created_at, last_seen_at, revoked_at FROM workers ORDER BY created_at").all();
  return json(results.map((w: any) => ({ ...w, online: !w.revoked_at && w.last_seen_at > now() - 120, capabilities: JSON.parse(w.capabilities_json) })));
}

export async function revokeWorker(env: Env, me: Person, id: string) {
  requireOwner(me);
  await env.DB.prepare("UPDATE workers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), id).run();
  // Anything it held goes back to the queue right away.
  await env.DB.prepare("UPDATE jobs SET status = 'queued', lease_worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = ? WHERE lease_worker_id = ? AND status IN ('leased','running')")
    .bind(now(), id).run();
  await audit(env, me.email, "worker.revoke", id);
  return json({ ok: true });
}

export async function costs(env: Env, month: string | null) {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  const start = Date.parse(`${m}-01T00:00:00Z`) / 1000;
  const end = Date.parse(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString()) / 1000;
  const { results } = await env.DB.prepare(`SELECT kind, COALESCE(SUM(usd),0) AS usd, COUNT(*) AS entries FROM cost_ledger
                                            WHERE created_at >= ? AND created_at < ? GROUP BY kind`).bind(start, end).all();
  const byProject = await env.DB.prepare(`SELECT p.id, p.name, p.budget_usd, COALESCE(SUM(c.usd),0) AS spent FROM projects p
                                          LEFT JOIN cost_ledger c ON c.project_id = p.id GROUP BY p.id ORDER BY spent DESC LIMIT 50`).all();
  const storage = await env.DB.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM assets WHERE status = 'ready'").first<{ bytes: number }>();
  return json({ month: m, by_kind: results, projects: byProject.results, cloud_rendering: env.CLOUD_RENDERING,
                storage_gb: (storage?.bytes ?? 0) / 1024 ** 3,
                storage_estimate_usd_month: Math.max(0, (storage?.bytes ?? 0) / 1024 ** 3 - 10) * 0.015,
                note: "AI costs are recorded by the worker from real token usage. Storage is an estimate from R2 Standard list prices (first 10 GB free)." });
}

export async function status(env: Env) {
  const workers = await env.DB.prepare("SELECT COUNT(*) AS n FROM workers WHERE revoked_at IS NULL AND last_seen_at > ?").bind(now() - 120).first<{ n: number }>();
  const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all();
  return json({ workers_online: workers?.n ?? 0, jobs: Object.fromEntries(results.map((r: any) => [r.status, r.n])),
                cloud_rendering: env.CLOUD_RENDERING, environment: env.ENVIRONMENT });
}

export async function auditLog(env: Env, me: Person) {
  requireOwner(me);
  const { results } = await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").all();
  return json(results);
}

export { STAGES };
