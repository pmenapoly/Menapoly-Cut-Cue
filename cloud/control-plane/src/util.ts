// Shared helpers: environment type, ids, JSON responses, hashing, audit log, rate limits, idempotency, events.

export interface Env {
  DB: D1Database;
  EVENTS?: Queue<CueEvent>;
  ASSETS?: Fetcher;
  EMAIL?: { send(message: unknown): Promise<void> };
  ENVIRONMENT: string;
  CLOUD_RENDERING: string;
  PUBLIC_REVIEW?: string;        // "enabled" turns on client review links; anything else (the default) keeps them off
  S3_ENDPOINT?: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  OWNER_EMAILS?: string;
  EDITOR_EMAILS?: string;
  DEV_OWNER_EMAIL?: string;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
  MAX_VIDEO_GB: string;
  LEASE_SECONDS: string;
  UPLOAD_SESSION_HOURS: string;
}

export type CueEvent =
  | { type: "job_status"; job_id: string; project_id: string; status: string; job_type: string; error?: string | null }
  | { type: "review"; project_id: string; event_id: string; kind: string; author: string; body: string }
  | { type: "upload_complete"; project_id: string; asset_id: string; name: string };

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export const now = () => Date.now() / 1000;

/** Client review links (the only route family meant for people outside Access) are off unless explicitly enabled. */
export const publicReviewEnabled = (env: Env) => env.PUBLIC_REVIEW === "enabled";

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function randomToken(prefix: string, bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let b64 = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}${b64}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function body<T = Record<string, unknown>>(request: Request, maxBytes = 256 * 1024): Promise<T> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new HttpError(413, "Request body too large");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request body too large");
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { throw new HttpError(400, "Body must be JSON"); }
}

export function str(value: unknown, name: string, { max = 200, required = true } = {}): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s && required) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long`);
  return s;
}

export async function audit(env: Env, actor: string, action: string, target: string | null, detail: unknown = {}) {
  await env.DB.prepare("INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)")
    .bind(now(), actor, action, target, JSON.stringify(detail)).run();
}

/** Fixed-window limiter stored in D1 (good enough for a single-owner app; Cloudflare WAF rules sit in front). */
export async function rateLimit(env: Env, key: string, limit: number, windowSeconds = 60) {
  const window = Math.floor(now() / windowSeconds) * windowSeconds;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
                                    window_start = excluded.window_start
     RETURNING count`).bind(key, window).first<{ count: number }>();
  if ((row?.count ?? 0) > limit) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
}

/** Replays the stored response for a repeated Idempotency-Key (scoped to actor + route). */
export async function idempotent(env: Env, scope: string, key: string | null, run: () => Promise<Response>): Promise<Response> {
  if (!key) return run();
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) throw new HttpError(400, "Idempotency-Key must be 8-100 safe characters");
  const id = `${scope}:${key}`;
  const prior = await env.DB.prepare("SELECT status, response_json FROM idempotency WHERE key = ?").bind(id).first<{ status: number; response_json: string }>();
  if (prior) return new Response(prior.response_json, { status: prior.status, headers: { "content-type": "application/json", "idempotent-replay": "true" } });
  const response = await run();
  if (response.status < 500) {
    const text = await response.clone().text();
    await env.DB.prepare("INSERT OR IGNORE INTO idempotency (key, status, response_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, response.status, text, now()).run();
  }
  return response;
}

export async function emit(env: Env, event: CueEvent) {
  if (env.EVENTS) {
    await env.EVENTS.send(event);
  } else {
    const { handleEvent } = await import("./events");
    await handleEvent(env, event);
  }
}

export async function jobEvent(env: Env, jobId: string, kind: string, detail: unknown = {}) {
  await env.DB.prepare("INSERT INTO job_events (job_id, at, kind, detail_json) VALUES (?, ?, ?, ?)")
    .bind(jobId, now(), kind, JSON.stringify(detail)).run();
}

export function safeName(name: string): string {
  return name.normalize("NFKC").replace(/[^\w.\- ]+/g, "_").replace(/\.{2,}/g, ".").replace(/\s+/g, " ")
    .replace(/^[.\s_]+/, "").trim().slice(0, 120) || "file";
}
