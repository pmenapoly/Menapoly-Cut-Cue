// Scheduled recovery (every 5 minutes): abandoned leases, expired uploads, orphaned outputs, old bookkeeping rows.
import * as s3 from "./s3";
import { emit, Env, jobEvent, now } from "./util";

export async function recover(env: Env) {
  const t = now();
  const report = { requeued: 0, dead: 0, uploads_expired: 0, outputs_cleaned: 0 };

  // 1. Leases that ran out (Mac asleep, offline, crashed): back to the queue, or dead after max_attempts.
  const { results: lost } = await env.DB.prepare(
    "SELECT id, project_id, type, attempts, max_attempts, lease_worker_id FROM jobs WHERE status IN ('leased','running') AND lease_expires_at < ?")
    .bind(t).all<Record<string, any>>();
  for (const j of lost) {
    const dead = j.attempts >= j.max_attempts;
    const r = await env.DB.prepare(`UPDATE jobs SET status = ?, lease_worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
          stage = ?, progress = NULL, error = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status IN ('leased','running') AND lease_expires_at < ?`)
      .bind(dead ? "dead" : "queued", dead ? "failed" : "waiting for a worker",
            dead ? "The worker stopped responding on every attempt." : null, t, dead ? t : null, j.id, t).run();
    if (!r.meta.changes) continue;
    await jobEvent(env, j.id, dead ? "dead" : "lease_expired", { worker: j.lease_worker_id, attempt: j.attempts });
    if (dead) {
      report.dead++;
      await emit(env, { type: "job_status", job_id: j.id, project_id: j.project_id, status: "dead", job_type: j.type,
                        error: "The worker stopped responding on every attempt." });
    } else report.requeued++;
  }

  // 2. Upload sessions past their expiry: abort the multipart upload so storage frees the parts.
  const { results: stale } = await env.DB.prepare("SELECT * FROM upload_sessions WHERE status = 'open' AND expires_at < ? LIMIT 50")
    .bind(t).all<Record<string, any>>();
  for (const s of stale) {
    try { await s3.abortMultipart(env, s.object_key, s.s3_upload_id); } catch (e) { console.error("abort failed", s.id, String(e)); continue; }
    await env.DB.batch([
      env.DB.prepare("UPDATE upload_sessions SET status = 'expired' WHERE id = ?").bind(s.id),
      env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = ? AND status = 'uploading'").bind(s.asset_id),
    ]);
    report.uploads_expired++;
  }

  // 3. Output objects whose job never completed (older than a day): delete the object, mark the asset failed.
  const { results: orphans } = await env.DB.prepare(`SELECT a.id, a.object_key FROM assets a JOIN jobs j ON j.id = a.source_job_id
      WHERE a.kind = 'output' AND a.status = 'uploading' AND a.created_at < ? AND j.status != 'succeeded' LIMIT 50`)
    .bind(t - 86400).all<{ id: string; object_key: string }>();
  for (const o of orphans) {
    try { await s3.deleteObject(env, o.object_key); } catch (e) { console.error("delete failed", o.id, String(e)); continue; }
    await env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = ?").bind(o.id).run();
    report.outputs_cleaned++;
  }

  // 4. Bookkeeping.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM idempotency WHERE created_at < ?").bind(t - 7 * 86400),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(t - 86400),
  ]);
  return report;
}
