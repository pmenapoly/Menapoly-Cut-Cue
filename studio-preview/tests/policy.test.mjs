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

test("checklist: only the assigned editor (and admins) tick tasks; clients may only comment", () => {
  assert.equal(can(U.u_sam, "checklist.update", { project: P.p_launch }), true);
  assert.equal(can(U.u_mika, "checklist.update", { project: P.p_launch }), false);
  assert.equal(can(U.u_jordan, "checklist.update", { project: P.p_launch }), false);
  assert.equal(can(U.u_admin, "checklist.update", { project: P.p_launch }), true);
  assert.equal(can(U.u_jordan, "checklist.comment", { project: P.p_launch }), true);
  assert.equal(can(U.u_priya, "checklist.comment", { project: P.p_launch }), false);
});

test("feedback assignment: admins and the assigned editor only", () => {
  assert.equal(can(U.u_sam, "review.assign", { project: P.p_launch }), true);
  assert.equal(can(U.u_jordan, "review.assign", { project: P.p_launch }), false);
  assert.equal(can(U.u_mika, "review.assign", { project: P.p_launch }), false);
});

test("templates stay inside their workspace", () => {
  assert.equal(can(U.u_jordan, "template.view", { ws: "ws_nw", projects: S.projects }), true);
  assert.equal(can(U.u_priya, "template.view", { ws: "ws_nw", projects: S.projects }), false);
  assert.equal(can(U.u_sam, "template.view", { ws: "ws_nw", projects: S.projects }), true); // assigned in ws_nw
  assert.equal(can(U.u_mika, "template.view", { ws: "ws_hb", projects: S.projects }), false);
  assert.equal(can(U.u_sam, "template.create", { project: P.p_launch }), true);
  assert.equal(can(U.u_mika, "template.create", { project: P.p_launch }), false);
});

test("finished-video actions: share, feed, library, new versions are client/admin decisions", () => {
  for (const a of ["video.share", "video.feed", "video.library", "video.another", "video.translate"]) {
    assert.equal(can(U.u_jordan, a, { project: P.p_launch }), true, a);
    assert.equal(can(U.u_admin, a, { project: P.p_launch }), true, a);
    assert.equal(can(U.u_sam, a, { project: P.p_launch }), false, a);
    assert.equal(can(U.u_priya, a, { project: P.p_launch }), false, a);
  }
  assert.equal(can(U.u_sam, "video.download", { project: P.p_launch }), true);
  assert.equal(can(U.u_mika, "video.download", { project: P.p_launch }), false);
});

test("every fixture video belongs to a project in the same workspace", () => {
  for (const v of S.videos) assert.equal(P[v.projectId].ws, v.ws, v.id);
  for (const a of S.assets.filter((x) => x.videoId)) assert.equal(S.videos.find((v) => v.id === a.videoId).projectId, a.projectId, a.id);
});

test("social review: clients of the workspace and admins review; editors and other clients don't; only admins prepare", () => {
  const nw = { ws: "ws_nw" };
  assert.equal(can(U.u_jordan, "post.review", nw), true);
  assert.equal(can(U.u_admin, "post.review", nw), true);
  assert.equal(can(U.u_sam, "post.review", nw), false);
  assert.equal(can(U.u_priya, "post.review", nw), false);
  assert.equal(can(U.u_admin, "post.prepare", nw), true);
  assert.equal(can(U.u_jordan, "post.prepare", nw), false);
});

test("revision rounds: clients ask, only admins approve extra rounds; plans set the included rounds", async () => {
  const { PLANS } = await import("../js/policy.js");
  assert.equal(can(U.u_jordan, "revision.ask", { project: P.p_launch }), true);
  assert.equal(can(U.u_jordan, "revision.grant", { project: P.p_launch }), false);
  assert.equal(can(U.u_sam, "revision.grant", { project: P.p_launch }), false);
  assert.equal(can(U.u_admin, "revision.grant", { project: P.p_launch }), true);
  assert.equal(can(U.u_priya, "revision.ask", { project: P.p_launch }), false);
  assert.equal(PLANS.growth.revisionsIncluded, 3);
  assert.equal(PLANS.essentials.revisionsIncluded, 2);
  assert.equal(P.p_reels.revisionsIncluded, 2); // a contracted project override wins over the plan
});

test("target dates: only admins change them; the seed tracks revisions per date", () => {
  assert.equal(can(U.u_admin, "request.schedule", { project: P.p_launch }), true);
  for (const u of ["u_jordan", "u_sam", "u_priya"]) assert.equal(can(U[u], "request.schedule", { project: P.p_launch }), false);
  assert.ok(S.requests.every((r) => r.dueRev === 0 && Array.isArray(r.dueHistory)));
  assert.ok(S.reviews.every((r) => Array.isArray(r.rounds) && Array.isArray(r.extraRounds)));
});
