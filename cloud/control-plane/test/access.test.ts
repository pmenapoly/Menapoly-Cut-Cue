// Unit tests for Cloudflare Access JWT verification and the person/worker guards (run: npm test).
// Real RS256 keys are generated here; the Access certs endpoint is replaced by a stub fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { requirePerson, verifyAccessJwt } from "../src/auth";
import type { Env } from "../src/util";

const TEAM = "menapoly.cloudflareaccess.com";
const AUD = "aud-1234567890";
const enc = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
let certFetches = 0;
globalThis.fetch = (async (url: string) => {
  assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
  certFetches++;
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function sign(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: CryptoKey } = {}) {
  const head = enc({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}
const t = Math.floor(Date.now() / 1000);
const good = { aud: [AUD], iss: `https://${TEAM}`, exp: t + 600, iat: t, email: "Owner@Example.com" };
const env = { ENVIRONMENT: "production", CF_ACCESS_AUD: AUD, CF_ACCESS_TEAM_DOMAIN: TEAM, OWNER_EMAILS: "owner@example.com",
              EDITOR_EMAILS: "editor@example.com", DEV_OWNER_EMAIL: "owner@example.com" } as unknown as Env;
const req = (headers: Record<string, string> = {}, url = "https://cue.example.com/v1/projects") => new Request(url, { headers });

test("a valid Access token verifies and the email is normalised", async () => {
  assert.deepEqual(await verifyAccessJwt(env, await sign(good)), { email: "owner@example.com" });
});

test("tokens with the wrong audience, issuer, expiry, algorithm, key or signature are rejected", async () => {
  assert.equal(await verifyAccessJwt(env, await sign({ ...good, aud: ["someone-else"] })), null);
  assert.equal(await verifyAccessJwt(env, await sign({ ...good, iss: "https://evil.cloudflareaccess.com" })), null);
  assert.equal(await verifyAccessJwt(env, await sign({ ...good, exp: t - 1 })), null);
  assert.equal(await verifyAccessJwt(env, await sign({ ...good, nbf: t + 3600 })), null);
  assert.equal(await verifyAccessJwt(env, await sign(good, { alg: "HS256" })), null);
  assert.equal(await verifyAccessJwt(env, await sign(good, { key: other.privateKey })), null);
  assert.equal(await verifyAccessJwt(env, await sign({ ...good, email: undefined })), null);
  const before = certFetches;
  assert.equal(await verifyAccessJwt(env, await sign(good, { kid: "unknown" })), null);
  assert.equal(certFetches, before + 1, "an unknown key id refreshes the key set once");
  const tampered = (await sign(good)).split(".");
  tampered[1] = enc({ ...good, email: "attacker@example.com" });
  assert.equal(await verifyAccessJwt(env, tampered.join(".")), null);
  assert.equal(await verifyAccessJwt(env, "not-a-jwt"), null);
});

test("requirePerson: roles from the allowlists; everyone else is refused", async () => {
  assert.deepEqual(await requirePerson(req({ "cf-access-jwt-assertion": await sign(good) }), env), { kind: "person", email: "owner@example.com", role: "owner" });
  assert.equal((await requirePerson(req({ "cf-access-jwt-assertion": await sign({ ...good, email: "editor@example.com" }) }), env)).role, "editor");
  await assert.rejects(requirePerson(req({ "cf-access-jwt-assertion": await sign({ ...good, email: "stranger@example.com" }) }), env), { status: 403 });
  await assert.rejects(requirePerson(req(), env), { status: 401 });
  await assert.rejects(requirePerson(req({ "cf-access-jwt-assertion": await sign({ ...good, exp: t - 5 }) }), env), { status: 401 });
});

test("identity headers alone are never trusted, and the dev identity never applies outside development + localhost", async () => {
  await assert.rejects(requirePerson(req({ "cf-access-authenticated-user-email": "owner@example.com", "x-dev-user": "owner@example.com" }), env), { status: 401 });
  // development flag but a public hostname: still needs Access
  await assert.rejects(requirePerson(req({ "x-dev-user": "owner@example.com" }), { ...env, ENVIRONMENT: "development" } as Env), { status: 401 });
  // production on localhost: still needs Access
  await assert.rejects(requirePerson(req({}, "http://localhost:8787/v1/projects"), env), { status: 401 });
  // development + localhost: allowed (local testing only)
  assert.equal((await requirePerson(req({}, "http://localhost:8787/v1/projects"), { ...env, ENVIRONMENT: "development" } as Env)).role, "owner");
});

test("production without Access settings refuses everyone (no unauthenticated fallback)", async () => {
  const bare = { ...env, CF_ACCESS_AUD: undefined, CF_ACCESS_TEAM_DOMAIN: undefined } as unknown as Env;
  await assert.rejects(requirePerson(req({ "cf-access-jwt-assertion": await sign(good) }), bare), { status: 503 });
  await assert.rejects(requirePerson(req({}, "http://localhost:8787/v1/projects"), bare), { status: 503 });
});
