// Mac worker API. The Mac polls outbound over HTTPS (no inbound ports), takes an expiring lease on one job, downloads
// only that job's inputs through short-lived URLs, uploads outputs through short-lived URLs, and reports measured
// progress. A lease token (stored hashed) proves the caller still holds the job; a lost lease means stop work.
import { WorkerIdentity } from "./auth";
import * as s3 from "./s3";
import { audit, body, emit, Env, HttpError, jobEvent, json, newId, now, randomToken, safeEqual, safeName, sha256Hex, str } from "./util";

const OUTPUT_TYPES: Record<string, { media: string; ext: string[]; max: number }> = {
  "video/mp4": { media: "video", ext: ["mp4"], max: 20 * 1024 ** 3 },
  "video/quicktime": { media: "video", ext: ["mov"], max: 20 * 1024 ** 3 },
  "audio/wav": { media: "audio", ext: ["wav"], max: 4 * 1024 ** 3 },
  "audio/mp4": { media: "audio", ext: ["m4a"], max: 4 * 1024 ** 3 },
  "image/jpeg": { media: "image", ext: ["jpg", "jpeg"], max: 20 * 1024 ** 2 },
  "application/json": { media: "data", ext: ["json"], max: 50 * 1024 ** 2 },
  "text/vtt": { media: "document", ext: ["vtt"], max: 10 * 1024 ** 2 },
  "application/x-subrip": { media: "document", ext: ["srt"], max: 10 * 1024 ** 2 },
};

const leaseSeconds = (env: Env) => Math.min(Math.max(Number(env.LEASE_SECONDS || 180), 30), 3600);

async function heldJob(request: Request, env: Env, w: WorkerIdentity, id: string) {
  const token = request.headers.get("x-lease-token") || "";
  const j = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!j) throw new HttpError(404, "Job not found");
  if (j.lease_worker_id !== w.id || !["leased", "running"].includes(j.status) || !j.lease_token_hash ||
      !safeEqual(j.lease_token_hash, await sha256Hex(token)))
    throw new HttpError(409, "Lease lost. Stop work on this job.", { lease_lost: true, status: j.status });
  return j;
}

export async function heartbeat(request: Request, env: Env, w: WorkerIdentity) {
  const b = await body(request, 16 * 1024);
  const caps = Array.isArray(b.capabilities) ? (b.capabilities as unknown[]).map(String).slice(0, 20) : [];
  // A worker that stops cleanly says so, so the phone shows "Mac offline" at once instead of after 2 minutes.
  const leaving = b.going_offline === true;
  await env.DB.prepare("UPDATE workers SET last_seen_at = ?, version = ?, capabilities_json = ? WHERE id = ?")
    .bind(leaving ? null : now(), str(b.version, "version", { max: 40, required: false }) || null, JSON.stringify(caps), w.id).run();
  return json({ ok: true, server_time: now(), offline: leaving });
}

export async function lease(request: Request, env: Env, w: WorkerIdentity) {
  await env.DB.prepare("UPDATE workers SET last_seen_at = ? WHERE id = ?").bind(now(), w.id).run();
  const b = await body(request, 16 * 1024);
  const types = (Array.isArray(b.types) ? (b.types as unknown[]).map(String) : ["transcribe", "auto_edit", "render"])
    .filter((t) => ["transcribe", "auto_edit", "render"].includes(t));
  if (!types.length) return new Response(null, { status: 204 });
  const token = randomToken("lt_"), t = now();
  // One atomic statement: two workers can never lease the same job.
  const j = await env.DB.prepare(`UPDATE jobs SET status = 'leased', attempts = attempts + 1, lease_worker_id = ?, lease_token_hash = ?,
        lease_expires_at = ?, updated_at = ?, started_at = COALESCE(started_at, ?), stage = 'leased', progress = NULL, error = NULL
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND target = 'mac' AND attempts < max_attempts
                  AND type IN (${types.map(() => "?").join(",")}) ORDER BY created_at LIMIT 1)
        AND status = 'queued'
      RETURNING *`).bind(w.id, await sha256Hex(token), t + leaseSeconds(env), t, t, ...types).first<Record<string, any>>();
  if (!j) return new Response(null, { status: 204 });
  await jobEvent(env, j.id, "leased", { worker: w.name, attempt: j.attempts });
  const ids: string[] = JSON.parse(j.input_asset_ids_json);
  const { results } = await env.DB.prepare(`SELECT id, name, content_type, media_type, size, sha256, object_key FROM assets
      WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`).bind(j.project_id, ...ids).all<Record<string, any>>();
  const inputs = await Promise.all(results.map(async (a) => ({ id: a.id, name: a.name, content_type: a.content_type,
    media_type: a.media_type, size: a.size, sha256: a.sha256, url: await s3.presignGet(env, a.object_key) })));
  const budget = await env.DB.prepare(`SELECT p.name, p.budget_usd, COALESCE((SELECT SUM(usd) FROM cost_ledger c WHERE c.project_id = p.id), 0) AS spent
      FROM projects p WHERE p.id = ?`).bind(j.project_id).first<{ name: string; budget_usd: number; spent: number }>();
  return json({ job: { id: j.id, project_id: j.project_id, project_name: budget?.name, type: j.type, attempt: j.attempts,
                       params: JSON.parse(j.params_json) },
                lease_token: token, lease_seconds: leaseSeconds(env), inputs, urls_expire_in: s3.GET_URL_TTL,
                ai_budget_remaining_usd: Math.max(0, (budget?.budget_usd ?? 0) - (budget?.spent ?? 0)) });
}

export async function progress(request: Request, env: Env, w: WorkerIdentity, id: string) {
  const j = await heldJob(request, env, w, id);
  const b = await body(request, 16 * 1024);
  const stage = str(b.stage, "stage", { max: 80 });
  // Progress is only stored when the worker measured it (0..1); otherwise NULL so the UI shows the stage, not a guess.
  const p = b.progress == null ? null : Number(b.progress);
  if (p !== null && !(p >= 0 && p <= 1)) throw new HttpError(400, "progress must be 0..1 or null");
  const t = now();
  await env.DB.prepare("UPDATE jobs SET status = 'running', stage = ?, progress = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(stage, p, t + leaseSeconds(env), t, id).run();
  if (stage !== j.stage) await jobEvent(env, id, "stage", { stage });
  return json({ ok: true, lease_expires_at: t + leaseSeconds(env), cancelled: false });
}

export async function outputUrl(request: Request, env: Env, w: WorkerIdentity, id: string) {
  const j = await heldJob(request, env, w, id);
  const b = await body(request, 16 * 1024);
  const name = safeName(str(b.name, "name", { max: 200 }));
  const contentType = str(b.content_type, "content_type", { max: 100 }).toLowerCase();
  const type = OUTPUT_TYPES[contentType];
  if (!type) throw new HttpError(415, "Output type not accepted");
  if (!type.ext.includes(name.split(".").pop()!.toLowerCase())) throw new HttpError(415, "Output name doesn't match its type");
  const size = Number(b.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > type.max) throw new HttpError(413, "Output size not accepted");
  const sha = String(b.sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, "sha256 required");
  // Deterministic key per job + name: a retried upload overwrites the same object instead of duplicating it.
  const key = `projects/${j.project_id}/outputs/${j.id}/${name}`;
  let asset = await env.DB.prepare("SELECT id, status FROM assets WHERE object_key = ?").bind(key).first<{ id: string; status: string }>();
  if (asset?.status === "ready") throw new HttpError(409, "This output was already stored");
  if (!asset) {
    asset = { id: newId("ast"), status: "uploading" };
    await env.DB.prepare(`INSERT INTO assets (id, project_id, kind, media_type, name, content_type, size, sha256, object_key, status, source_job_id, created_by, created_at)
                          VALUES (?, ?, 'output', ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`)
      .bind(asset.id, j.project_id, type.media, name, contentType, size, sha, key, j.id, `worker:${w.id}`, now()).run();
  } else {
    await env.DB.prepare("UPDATE assets SET size = ?, sha256 = ? WHERE id = ?").bind(size, sha, asset.id).run();
  }
  return json({ asset_id: asset.id, url: await s3.presignPut(env, key), expires_in: s3.PART_URL_TTL, method: "PUT" });
}

type Timeline = { clips: { asset_id: string; start: number; end: number }[]; [k: string]: unknown };

function checkTimeline(t: unknown, allowed: string[]): Timeline {
  const tl = t as Timeline;
  if (!tl || !Array.isArray(tl.clips) || !tl.clips.length || tl.clips.length > 2000) throw new HttpError(400, "timeline.clips required");
  for (const c of tl.clips) {
    if (!allowed.includes(c.asset_id)) throw new HttpError(400, "timeline refers to a file outside this job");
    if (!(Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start)) throw new HttpError(400, "bad clip times");
  }
  return tl;
}

export async function complete(request: Request, env: Env, w: WorkerIdentity, id: string) {
  const current = await env.DB.prepare("SELECT status, lease_worker_id FROM jobs WHERE id = ?").bind(id).first<{ status: string; lease_worker_id: string }>();
  if (current?.status === "succeeded" && current.lease_worker_id === w.id) return json({ ok: true, already: true });
  const j = await heldJob(request, env, w, id);
  const b = await body(request, 2 * 1024 * 1024);
  const outputIds = Array.isArray(b.outputs) ? (b.outputs as unknown[]).map(String) : [];
  const { results: outs } = await env.DB.prepare(`SELECT * FROM assets WHERE source_job_id = ? AND kind = 'output'`).bind(id).all<Record<string, any>>();
  for (const oid of outputIds) {
    const a = outs.find((o) => o.id === oid);
    if (!a) throw new HttpError(400, `Unknown output ${oid}`);
    const stored = await s3.head(env, a.object_key);
    if (!stored) throw new HttpError(409, `Output ${a.name} was not uploaded`);
    if (stored.size !== a.size) throw new HttpError(409, `Output ${a.name} size differs from what was declared`);
  }
  const result = (b.result && typeof b.result === "object") ? b.result as Record<string, unknown> : {};
  const aiUsd = b.ai_usd == null ? 0 : Number(b.ai_usd);
  if (!(aiUsd >= 0 && aiUsd < 1000)) throw new HttpError(400, "ai_usd must be a real measured amount");
  const t = now();
  const stmts = [
    env.DB.prepare(`UPDATE jobs SET status = 'succeeded', stage = 'done', progress = 1, result_json = ?, finished_at = ?, updated_at = ?,
                    lease_token_hash = NULL, lease_expires_at = NULL WHERE id = ? AND status IN ('leased','running')`)
      .bind(JSON.stringify({ ...result, outputs: outputIds }), t, t, id),
    ...outputIds.map((oid) => env.DB.prepare("UPDATE assets SET status = 'ready', verified_at = ? WHERE id = ?").bind(t, oid)),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(t, j.project_id),
  ];
  let versionId: string | null = null;
  if (j.type === "auto_edit") {
    const timeline = checkTimeline(b.timeline, JSON.parse(j.input_asset_ids_json));
    versionId = newId("ver");
    // Every AI edit is a proposal: the owner must approve it before it can be rendered.
    stmts.push(env.DB.prepare(`INSERT INTO timeline_versions (id, project_id, number, status, label, timeline_json, source_job_id, created_by, created_at)
        VALUES (?, ?, COALESCE((SELECT MAX(number) FROM timeline_versions WHERE project_id = ?), 0) + 1, 'proposed', ?, ?, ?, ?, ?)`)
      .bind(versionId, j.project_id, j.project_id, str(b.label, "label", { max: 120, required: false }) || "Suggested edit",
            JSON.stringify(timeline), id, `worker:${w.id}`, t));
  }
  if (aiUsd > 0)
    stmts.push(env.DB.prepare("INSERT INTO cost_ledger (id, project_id, job_id, kind, usd, detail, created_at) VALUES (?, ?, ?, 'ai', ?, ?, ?)")
      .bind(newId("cst"), j.project_id, id, aiUsd, str(b.ai_detail, "ai_detail", { max: 200, required: false }), t));
  await env.DB.batch(stmts);
  await jobEvent(env, id, "succeeded", { outputs: outputIds.length, version: versionId });
  await audit(env, `worker:${w.id}`, "job.complete", id, { outputs: outputIds, version: versionId });
  await emit(env, { type: "job_status", job_id: id, project_id: j.project_id, status: "succeeded", job_type: j.type });
  return json({ ok: true, version_id: versionId });
}

export async function fail(request: Request, env: Env, w: WorkerIdentity, id: string) {
  const j = await heldJob(request, env, w, id);
  const b = await body(request, 64 * 1024);
  const error = str(b.error, "error", { max: 2000 });
  const retryable = Boolean(b.retryable);
  const status = !retryable ? "failed" : j.attempts >= j.max_attempts ? "dead" : "queued";
  const t = now();
  await env.DB.prepare(`UPDATE jobs SET status = ?, error = ?, stage = ?, lease_worker_id = CASE WHEN ? = 'queued' THEN NULL ELSE lease_worker_id END,
                        lease_token_hash = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = CASE WHEN ? = 'queued' THEN NULL ELSE ? END
                        WHERE id = ?`).bind(status, error, status === "queued" ? "waiting to retry" : "failed", status, t, status, t, id).run();
  await jobEvent(env, id, status === "queued" ? "retry_scheduled" : status, { error, attempt: j.attempts });
  if (status !== "queued") await emit(env, { type: "job_status", job_id: id, project_id: j.project_id, status, job_type: j.type, error });
  return json({ ok: true, status });
}

export async function release(request: Request, env: Env, w: WorkerIdentity, id: string) {
  await heldJob(request, env, w, id);
  // Graceful shutdown: give the job back without spending an attempt.
  await env.DB.prepare(`UPDATE jobs SET status = 'queued', attempts = MAX(attempts - 1, 0), lease_worker_id = NULL, lease_token_hash = NULL,
                        lease_expires_at = NULL, stage = 'waiting for a worker', progress = NULL, updated_at = ? WHERE id = ?`).bind(now(), id).run();
  await jobEvent(env, id, "released", { worker: w.name });
  return json({ ok: true });
}
