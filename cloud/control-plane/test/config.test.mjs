// Guards the pilot's safety settings in wrangler.jsonc so a careless edit fails `npm test` instead of shipping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function jsonc(text) {
  // Remove // and /* */ comments outside strings, then trailing commas.
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i = text.indexOf("*/", i + 2) + 1; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
const cfg = jsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const RELAY = { worker: "menapoly-cue-production", d1: "menapoly-cue-production" };

test("no address outside the Access-protected custom domain", () => {
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.deepEqual(cfg.routes, [{ pattern: "cue.menapoly-digital.com", custom_domain: true }]);
});

test("production defaults: no dev identity, no paid cloud work, no public review links", () => {
  assert.equal(cfg.vars.ENVIRONMENT, "production");
  assert.equal(cfg.vars.CLOUD_RENDERING, "disabled");
  assert.equal(cfg.vars.PUBLIC_REVIEW, "disabled");
  for (const secret of ["DEV_OWNER_EMAIL", "S3_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID", "CF_ACCESS_AUD", "OWNER_EMAILS"])
    assert.ok(!(secret in cfg.vars), `${secret} must be a Worker secret (or absent), never a plain var`);
});

test("kept separate from MenapolyRelay (different Worker, D1, bucket, queues)", () => {
  assert.notEqual(cfg.name, RELAY.worker);
  assert.ok(cfg.d1_databases.every((d) => d.database_name !== RELAY.d1));
  assert.ok(!cfg.r2_buckets, "media is reached through presigned S3 URLs, not a shared R2 binding");
  assert.equal(cfg.vars.S3_BUCKET, "menapoly-cue-media");
  assert.ok(cfg.queues.producers.every((q) => q.queue.startsWith("menapoly-cue-events")));
});
