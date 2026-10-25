// Authorization rules (policy.js) against the fictional fixtures. Run: node --test studio-preview/tests/
import assert from "node:assert/strict";
import { test } from "node:test";
import { can, canViewProject, canViewAsset, canViewWorkspace, enforce, Denied } from "../js/policy.js";
import { seed } from "../js/data.js";

const S = seed();
const U = Object.fromEntries(S.users.map((u) => [u.id, u]));
const P = Object.fromEntries(S.projects.map((p) => [p.id, p]));
const visible = (u) => S.projects.filter((p) => canViewProject(u, p)).map((p) => p.id).sort();

test("tenant isolation: each client sees only their own workspace's projects", () => {
  assert.deepEqual(visible(U.u_jordan), ["p_launch", "p_reels"]);
  assert.deepEqual(visible(U.u_priya), ["p_podcast", "p_promo"]);
  assert.equal(canViewWorkspace(U.u_jordan, "ws_hb", S.projects), false);
  assert.equal(canViewWorkspace(U.u_priya, "ws_nw", S.projects), false);
});

test("editors see only projects they are assigned to", () => {
  assert.deepEqual(visible(U.u_sam), ["p_launch", "p_podcast"]);
  assert.deepEqual(visible(U.u_mika), ["p_reels"]);
  assert.equal(canViewProject(U.u_mika, P.p_launch), false);
});

test("admins see everything", () => {
  assert.deepEqual(visible(U.u_admin), S.projects.map((p) => p.id).sort());
});

test("workspace-library files (no project) are hidden from editors and other clients", () => {
  const logo = S.assets.find((a) => a.id === "a_logo");
  assert.equal(canViewAsset(U.u_jordan, logo, null), true);
  assert.equal(canViewAsset(U.u_admin, logo, null), true);
  assert.equal(canViewAsset(U.u_sam, logo, null), false);
  assert.equal(canViewAsset(U.u_priya, logo, null), false);
});

test("editors never approve; clients approve only in their workspace", () => {
  assert.equal(can(U.u_sam, "review.decide", { project: P.p_launch }), false);
  assert.equal(can(U.u_jordan, "review.decide", { project: P.p_launch }), true);
  assert.equal(can(U.u_priya, "review.decide", { project: P.p_launch }), false);
  assert.equal(can(U.u_admin, "review.decide", { project: P.p_podcast }), true);
});

test("only assigned editors (and admins) upload new versions", () => {
  assert.equal(can(U.u_sam, "review.upload_version", { project: P.p_launch }), true);
  assert.equal(can(U.u_mika, "review.upload_version", { project: P.p_launch }), false);
  assert.equal(can(U.u_jordan, "review.upload_version", { project: P.p_launch }), false);
});

test("requests: clients create in their own workspace; only admins assign", () => {
  assert.equal(can(U.u_jordan, "request.create", { project: P.p_launch }), true);
  assert.equal(can(U.u_jordan, "request.create", { project: P.p_podcast }), false);
  assert.equal(can(U.u_sam, "request.create", { project: P.p_launch }), false);
  assert.equal(can(U.u_jordan, "request.assign", { project: P.p_launch }), false);
  assert.equal(can(U.u_admin, "request.assign", { project: P.p_launch }), true);
});

test("AI Visibility: editors never; clients only their workspace and only modules in their plan", () => {
  assert.equal(can(U.u_sam, "visibility.view", { ws: "ws_nw", plan: "growth", module: "overview" }), false);
  assert.equal(can(U.u_jordan, "visibility.view", { ws: "ws_nw", plan: "growth", module: "competitive" }), true);
  assert.equal(can(U.u_priya, "visibility.view", { ws: "ws_hb", plan: "essentials", module: "overview" }), true);
  assert.equal(can(U.u_priya, "visibility.view", { ws: "ws_hb", plan: "essentials", module: "competitive" }), false);
  assert.equal(can(U.u_jordan, "visibility.view", { ws: "ws_hb", plan: "essentials", module: "overview" }), false);
  assert.equal(can(U.u_admin, "visibility.view", { ws: "ws_hb", plan: "unknown", module: "overview" }), false); // unknown plan → nothing
});

test("admin-only areas and deny-by-default", () => {
  for (const a of ["clients.view", "team.view", "audit.view", "post.schedule"]) {
    assert.equal(can(U.u_admin, a, { ws: "ws_nw" }), true, a);
    assert.equal(can(U.u_jordan, a, { ws: "ws_nw" }), false, a);
    assert.equal(can(U.u_sam, a, { ws: "ws_nw" }), false, a);
  }
  assert.equal(can(U.u_admin, "anything.unknown", {}), false);
  assert.equal(can(null, "project.view", { project: P.p_launch }), false);
  assert.equal(can({ id: "x", role: "superuser" }, "clients.view", {}), false);
  assert.throws(() => enforce(U.u_sam, "clients.view", {}), Denied);
});

test("clients resolve only their own comments; assigned editors resolve any on their project", () => {
  const theirs = { by: "u_jordan" }, other = { by: "u_sam" };
  assert.equal(can(U.u_jordan, "review.resolve", { project: P.p_launch, resource: theirs }), true);
  assert.equal(can(U.u_jordan, "review.resolve", { project: P.p_launch, resource: other }), false);
  assert.equal(can(U.u_sam, "review.resolve", { project: P.p_launch, resource: theirs }), true);
  assert.equal(can(U.u_mika, "review.resolve", { project: P.p_launch, resource: theirs }), false);
});
