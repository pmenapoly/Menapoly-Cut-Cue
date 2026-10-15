// Authentication. Three kinds of caller, each verified; no request header is trusted as identity by itself.
//  1. People (owner/editor): a Cloudflare Access JWT (RS256; audience, issuer, expiry, key id, signature checked),
//     then the email must be in OWNER_EMAILS or EDITOR_EMAILS. Missing Access settings in production = nobody.
//  2. Mac workers: "Authorization: Bearer cqw_<worker id>.<secret>"; only a SHA-256 of the secret is stored.
//  3. Clients with a review link: a random token in the URL path, stored hashed, expiring, revocable (see api.ts).
// Local development ONLY (ENVIRONMENT=development AND a localhost URL): DEV_OWNER_EMAIL stands in for Access.
import { Env, HttpError, now, safeEqual, sha256Hex } from "./util";

export type Role = "owner" | "editor";
export type Person = { kind: "person"; email: string; role: Role };
export type WorkerIdentity = { kind: "worker"; id: string; name: string };

type AccessKey = JsonWebKey & { kid?: string };
let jwks: { at: number; keys: AccessKey[] } | null = null;

const list = (v?: string) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function isLocalhost(url: URL) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function accessConfigured(env: Env) {
  return Boolean(env.CF_ACCESS_AUD && env.CF_ACCESS_TEAM_DOMAIN);
}

function b64urlBytes(s: string): Uint8Array {
  const n = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(n.padEnd(Math.ceil(n.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function accessKeys(env: Env, refresh = false): Promise<AccessKey[]> {
  if (!refresh && jwks && now() - jwks.at < 3600) return jwks.keys;
  const team = String(env.CF_ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, "Cloudflare Access keys unavailable");
  const keys = ((await res.json()) as { keys?: AccessKey[] }).keys ?? [];
  jwks = { at: now(), keys };
  return keys;
}

export async function verifyAccessJwt(env: Env, token: string): Promise<{ email: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0]))) as { alg?: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1]))) as {
      aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
    if (header.alg !== "RS256" || !header.kid) return null;
    const t = now();
    if (!claims.exp || claims.exp <= t || (claims.nbf && claims.nbf > t + 30)) return null;
    const team = String(env.CF_ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
    if (String(claims.iss || "").replace(/\/$/, "") !== `https://${team}`) return null;
    const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!list(env.CF_ACCESS_AUD).some((a) => auds.map((x) => x.toLowerCase()).includes(a))) return null;
    let key = (await accessKeys(env)).find((k) => k.kid === header.kid);
    if (!key) key = (await accessKeys(env, true)).find((k) => k.kid === header.kid);
    if (!key || !claims.email) return null;
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok ? { email: claims.email.trim().toLowerCase() } : null;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return null;
  }
}

/** The signed-in person, or a 401/403. */
export async function requirePerson(request: Request, env: Env): Promise<Person> {
  const url = new URL(request.url);
  let email: string | null = null;
  if (env.ENVIRONMENT === "development" && isLocalhost(url) && env.DEV_OWNER_EMAIL) {
    // Local development only: tests may act as another listed person via x-dev-user. Never in production.
    email = (request.headers.get("x-dev-user") || env.DEV_OWNER_EMAIL).trim().toLowerCase();
  } else {
    if (!accessConfigured(env)) throw new HttpError(503, "Sign-in is not configured (Cloudflare Access settings missing).");
    const token = request.headers.get("cf-access-jwt-assertion");
    const verified = token ? await verifyAccessJwt(env, token) : null;
    if (!verified) throw new HttpError(401, "Sign in through Cloudflare Access.");
    email = verified.email;
  }
  if (list(env.OWNER_EMAILS).includes(email)) return { kind: "person", email, role: "owner" };
  if (list(env.EDITOR_EMAILS).includes(email)) return { kind: "person", email, role: "editor" };
  throw new HttpError(403, "This account is not allowed in Menapoly Cue.");
}

export function requireOwner(p: Person) {
  if (p.role !== "owner") throw new HttpError(403, "Only the owner can do this.");
}

/** A registered, non-revoked Mac (or cloud) worker. */
export async function requireWorker(request: Request, env: Env): Promise<WorkerIdentity> {
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer cqw_(wkr_[0-9a-f]{16})\.([A-Za-z0-9_-]{20,100})$/.exec(auth);
  if (!m) throw new HttpError(401, "Worker credentials required.");
  const row = await env.DB.prepare("SELECT id, name, secret_hash, revoked_at FROM workers WHERE id = ?").bind(m[1])
    .first<{ id: string; name: string; secret_hash: string; revoked_at: number | null }>();
  if (!row || row.revoked_at || !safeEqual(row.secret_hash, await sha256Hex(m[2]))) throw new HttpError(401, "Worker credentials rejected.");
  return { kind: "worker", id: row.id, name: row.name };
}
