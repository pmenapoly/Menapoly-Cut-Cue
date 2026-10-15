// Menapoly Cue cloud control plane: routes /v1/* (everything else is the static PWA from ../web).
// Auth per route family: people → Cloudflare Access JWT + allowlist; /v1/worker → worker bearer token;
// /v1/public/review → hashed, expiring review-link token; /v1/health → no data.
import * as api from "./api";
import { Person, requireOwner, requirePerson, requireWorker } from "./auth";
import { recover } from "./cron";
import { handleEvent } from "./events";
import { CueEvent, Env, HttpError, json } from "./util";
import * as worker from "./worker_api";

const VERSION = "2026.10.0";
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-resource-policy": "same-origin",
};

type Handler = (req: Request, env: Env, m: string[], url: URL) => Promise<Response>;
type PersonHandler = (req: Request, env: Env, me: Person, m: string[], url: URL) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
const ID = "([a-z]{3}_[0-9a-f]{16})";
const on = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path.replace(/:id/g, ID)}$`), h]);
const person = (method: string, path: string, h: PersonHandler) =>
  on(method, path, async (req, env, m, url) => h(req, env, await requirePerson(req, env), m, url));
const workerRoute = (path: string, h: (req: Request, env: Env, w: Awaited<ReturnType<typeof requireWorker>>, id: string) => Promise<Response>) =>
  on("POST", path, async (req, env, m) => h(req, env, await requireWorker(req, env), m[1]));

on("GET", "/v1/health", async (_r, env) => json({ ok: true, service: "menapoly-cue-cloud", version: VERSION, environment: env.ENVIRONMENT }));
person("GET", "/v1/me", async (_r, env, me) => json({ email: me.email, role: me.role, environment: env.ENVIRONMENT }));
person("GET", "/v1/status", async (_r, env) => api.status(env));
person("GET", "/v1/projects", async (_r, env) => api.listProjects(env));
person("POST", "/v1/projects", async (r, env, me) => api.createProject(r, env, me));
person("GET", "/v1/projects/:id", async (_r, env, _me, m) => api.getProject(env, m[1]));
person("PUT", "/v1/projects/:id/budget", async (r, env, me, m) => api.setBudget(r, env, me, m[1]));
person("POST", "/v1/projects/:id/uploads", async (r, env, me, m) => api.createUpload(r, env, me, m[1]));
person("GET", "/v1/uploads/:id", async (_r, env, me, m) => api.uploadStatus(env, me, m[1]));
person("POST", "/v1/uploads/:id/parts", async (r, env, me, m) => api.partUrls(r, env, me, m[1]));
person("POST", "/v1/uploads/:id/complete", async (_r, env, me, m) => api.completeUpload(env, me, m[1]));
person("DELETE", "/v1/uploads/:id", async (_r, env, me, m) => api.abortUpload(env, me, m[1]));
person("GET", "/v1/assets/:id/url", async (_r, env, me, m, url) => api.assetUrl(env, me, m[1], url.searchParams.get("download") === "1"));
person("POST", "/v1/projects/:id/jobs", async (r, env, me, m) => api.createJob(r, env, me, m[1]));
person("GET", "/v1/jobs/:id", async (_r, env, _me, m) => api.getJob(env, m[1]));
person("POST", "/v1/jobs/:id/cancel", async (_r, env, me, m) => api.cancelJob(env, me, m[1]));
person("POST", "/v1/jobs/:id/retry", async (_r, env, me, m) => api.retryJob(env, me, m[1]));
person("POST", "/v1/jobs/:id/authorize", async (r, env, me, m) => api.authorizeJob(r, env, me, m[1]));
person("GET", "/v1/versions/:id", async (_r, env, _me, m) => api.getVersion(env, m[1]));
person("POST", "/v1/versions/:id/decision", async (r, env, me, m) => api.decideVersion(r, env, me, m[1]));
person("POST", "/v1/projects/:id/review-links", async (r, env, me, m) => api.createReviewLink(r, env, me, m[1]));
person("DELETE", "/v1/review-links/:id", async (_r, env, me, m) => api.revokeReviewLink(env, me, m[1]));
person("GET", "/v1/notifications", async (_r, env) => api.notifications(env));
person("POST", "/v1/notifications/read", async (_r, env) => api.markRead(env));
person("GET", "/v1/workers", async (_r, env, me) => { requireOwner(me); return api.listWorkers(env); });
person("POST", "/v1/workers", async (r, env, me) => api.registerWorker(r, env, me));
person("DELETE", "/v1/workers/:id", async (_r, env, me, m) => api.revokeWorker(env, me, m[1]));
person("GET", "/v1/costs", async (_r, env, _me, _m, url) => api.costs(env, url.searchParams.get("month")));
person("GET", "/v1/audit", async (_r, env, me) => api.auditLog(env, me));

on("GET", "/v1/public/review/(rv_[A-Za-z0-9_-]{30,60})", async (r, env, m) => api.publicReview(r, env, m[1]));
on("POST", "/v1/public/review/(rv_[A-Za-z0-9_-]{30,60})/events", async (r, env, m) => api.publicReviewEvent(r, env, m[1]));

on("POST", "/v1/worker/heartbeat", async (r, env) => worker.heartbeat(r, env, await requireWorker(r, env)));
on("POST", "/v1/worker/lease", async (r, env) => worker.lease(r, env, await requireWorker(r, env)));
workerRoute("/v1/worker/jobs/:id/progress", worker.progress);
workerRoute("/v1/worker/jobs/:id/outputs", worker.outputUrl);
workerRoute("/v1/worker/jobs/:id/complete", worker.complete);
workerRoute("/v1/worker/jobs/:id/fail", worker.fail);
workerRoute("/v1/worker/jobs/:id/release", worker.release);

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Browsers send Origin on cross-site requests; state changes from another site are refused (CSRF defence).
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && request.method !== "HEAD" && origin && origin !== url.origin)
    throw new HttpError(403, "Cross-site request refused");
  const ctype = request.headers.get("content-type") || "";
  if (["POST", "PUT"].includes(request.method) && request.headers.get("content-length") !== "0" && ctype && !ctype.startsWith("application/json"))
    throw new HttpError(415, "Send JSON");
  let methodMatched = false;
  for (const [method, re, h] of routes) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    if (method !== request.method) { methodMatched = true; continue; }
    return h(request, env, m, url);
  }
  throw new HttpError(methodMatched ? 405 : 404, methodMatched ? "Method not allowed" : "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    }
    let res: Response;
    try {
      res = await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message, ...e.extra }, e.status);
      else { console.error("unhandled", e instanceof Error ? e.stack : String(e)); res = json({ error: "Internal error" }, 500); }
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const report = await recover(env);
    console.log("recovery", JSON.stringify(report));
  },

  async queue(batch: MessageBatch<CueEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try { await handleEvent(env, message.body); message.ack(); }
      catch (e) { console.error("event failed", String(e)); message.retry({ delaySeconds: 30 }); } // DLQ after max_retries
    }
  },
} satisfies ExportedHandler<Env, CueEvent>;
