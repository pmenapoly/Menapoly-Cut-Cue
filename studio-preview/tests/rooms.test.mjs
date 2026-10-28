// Upload-first rooms, Phase 1: data model, migration and integrity (fictional data, runs the mock service in Node).
// Run: node --test studio-preview/tests/
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { seed } from "../js/data.js";
import { migrate6, snapshotIntact, roomStage, sanitizeBriefPatch, validateShapes, validateVoice } from "../js/rooms.js";
import { micSupport, micError, mediaAvailability, deviceStore } from "../js/local-media.js";
import { can } from "../js/policy.js";
const { svc, migrateState } = await import("../js/service.js");

svc.flags.latency = false;
const as = (uid) => svc.switchUser(uid);
const fails = async (p, code, reason) => { try { await p; } catch (e) { assert.equal(e.code, code, e.message); if (reason) assert.equal(e.reason, reason); return e; } assert.fail(`expected ${code}`); };
const file = (name = "roastery-floor.mp4", size = 48_000_000) => ({ name, size, type: "video/mp4" });
const upload = (opId, projectId, f = file()) => svc.registerUpload({ opId, projectId, file: f });
async function readyRoom(opId = "op_ready_0001") {
  const { room } = await upload(opId, "p_launch");
  let b = await svc.saveBrief(room.id, { outcome: "Bring people to opening weekend", instructions: "Open on the bean pour", aspects: ["9:16"], platforms: ["instagram"] }, 0);
  b = await svc.markBriefReady(room.id, b.rev);
  return { room, rev: b.rev };
}
beforeEach(() => { svc.reset(); as("u_jordan"); });

/** A saved demo from the previous preview (version 6): the seed with every version 7 addition removed. */
function v6() {
  const s = JSON.parse(JSON.stringify(seed()));
  for (const k of ["rooms", "briefs", "briefSnapshots", "notes", "uploadOps", "migrations"]) delete s[k];
  s.assets.forEach((a) => { delete a.storage; delete a.roomId; });
  s.requests.forEach((r) => { for (const k of ["roomId", "briefId", "briefRev", "snapshotId", "requestedDate"]) delete r[k]; });
  s.reviews.forEach((r) => r.comments.forEach((c) => delete c.phase));
  s.version = 6;
  return s;
}

test("migration 6 → 7 keeps room ids, links, comments, approvals and revision usage", () => {
  const before = v6(), s = migrateState(JSON.parse(JSON.stringify(before)));
  assert.equal(s.version, 7);
  assert.deepEqual(s.rooms.map((r) => r.id), before.videos.map((v) => v.id)); // same ids → #video-* links keep working
  for (const rm of s.rooms) {
    const v = s.videos.find((x) => x.id === rm.id);
    assert.equal(rm.requestId, v.requestId); assert.equal(rm.reviewId, v.reviewId); assert.equal(rm.ws, v.ws);
    assert.equal(s.requests.find((r) => r.id === rm.requestId).roomId, rm.id);
    const b = s.briefs.find((x) => x.id === rm.briefId);
    assert.equal(b.status, "submitted");
    const snap = s.briefSnapshots.find((x) => x.id === b.snapshotIds[0]);
    assert.ok(snapshotIntact(snap)); assert.equal(snap.fields.instructions, v.instructions.brief);
  }
  // Reviews are untouched apart from each comment's new phase
  const strip = (r) => ({ ...r, comments: r.comments.map(({ phase, ...c }) => c) });
  assert.deepEqual(s.reviews.map(strip), before.reviews);
  assert.deepEqual(s.reviews.find((r) => r.id === "rv_launch").comments.map((c) => c.phase), ["revision", "revision"]);
  assert.deepEqual(s.reviews.find((r) => r.id === "rv_pod").comments.map((c) => c.phase), ["brief"]); // before any version
  assert.deepEqual(s.videos, before.videos); assert.deepEqual(s.posts, before.posts);
  assert.equal(s.requests.find((r) => r.id === "r_launch").requestedDate, null); // never invented
  assert.equal(s.migrations.length, 1); assert.equal(s.migrations[0].from, 6); assert.equal(s.migrations[0].rooms, 3);
});

test("migration is idempotent, chains from version 5, warns on odd records and refuses unknown versions", () => {
  const once = migrateState(v6()), twice = migrate6(JSON.parse(JSON.stringify(once)));
  assert.equal(twice.rooms.length, once.rooms.length); assert.equal(twice.briefSnapshots.length, once.briefSnapshots.length);
  const old = v6(); old.version = 5;
  old.projects.forEach((p) => { p.revisionLimit = p.revisionsIncluded ?? 3; delete p.revisionsIncluded; });
  old.requests.forEach((r) => { delete r.dueRev; r.revisionsUsed = r.id === "r_launch" ? 1 : 0; });
  old.reviews.forEach((r) => { delete r.rounds; delete r.extraRounds; delete r.extraAsks; });
  const up = migrateState(old);
  assert.equal(up.version, 7); assert.equal(up.rooms.length, 3);
  assert.equal(up.reviews.find((r) => r.id === "rv_launch").rounds.length, 1);
  const orphan = v6(); orphan.requests.push({ id: "r_lost", ws: "ws_nw", projectId: "p_launch", title: "Old request", status: "Submitted", by: "u_jordan", at: new Date().toISOString() });
  const o = migrateState(orphan);
  assert.equal(o.requests.find((r) => r.id === "r_lost").roomId, null);
  assert.match(o.migrations[0].warnings.join(" "), /r_lost has no Editing Room/);
  assert.equal(migrateState({ version: 99 }), null); assert.equal(migrateState(null), null);
});

test("the seed is already version 7 and passes every integrity check", async () => {
  as("u_admin");
  const r = await svc.integrity();
  assert.equal(r.ok, true, r.issues.join("; ")); assert.equal(r.rooms, 3);
  assert.equal((await svc.room("v_launch")).stage, "Ready for review");
  assert.equal((await svc.room("v_reel")).stage, "Approved");
  assert.equal((await svc.room("v_pod")).stage, "Assigned");
});

test("a room exists without any request: upload → draft → ready, invisible to editors until submitted", async () => {
  const videos = (await svc.videos()).length, requests = (await svc.requests()).length;
  const { room, replayed } = await upload("op_room_0001", "p_launch");
  assert.equal(replayed, false); assert.equal(room.requestId, null); assert.equal(room.reviewId, null);
  assert.equal(room.stage, "Uploaded"); assert.equal(room.brief.status, "draft");
  assert.equal((await svc.videos()).length, videos); // no new production room or Studio row yet
  assert.equal((await svc.requests()).length, requests); // nothing assigned or requested on upload
  await svc.addNote(room.id, { body: "Slow this down", t: 4.2 });
  assert.equal((await svc.room(room.id)).stage, "Preparing instructions");
  as("u_sam"); // assigned to p_launch, but this is still the client's draft
  await fails(svc.room(room.id), 403);
  assert.equal((await svc.rooms({ projectId: "p_launch" })).some((r) => r.id === room.id), false);
});

test("duplicate upload retries return the same file and room; reusing an id for something else is refused", async () => {
  const first = await upload("op_retry_0001", "p_launch");
  const retries = await Promise.all([1, 2, 3, 4].map(() => upload("op_retry_0001", "p_launch")));
  assert.ok(retries.every((r) => r.replayed && r.room.id === first.room.id && r.asset.id === first.asset.id));
  assert.equal((await svc.rooms({ projectId: "p_launch" })).filter((r) => r.uploadOpId === "op_retry_0001").length, 1);
  assert.equal((await svc.assets({ ws: "ws_nw" })).filter((a) => a.uploadOpId === "op_retry_0001").length, 1);
  await fails(upload("op_retry_0001", "p_launch", file("other.mp4")), 409, "op-reused");
  await fails(upload("op_retry_0001", "p_reels"), 409, "op-reused");
  await fails(upload("short", "p_launch"), 400);
  // A second, intentional upload of the same file is a new operation and a new room
  const second = await upload("op_retry_0002", "p_launch");
  assert.notEqual(second.room.id, first.room.id);
  as("u_admin"); assert.equal((await svc.integrity()).ok, true);
});

test("identical files in different projects and workspaces never share or merge rooms", async () => {
  const a = await upload("op_same_0001", "p_launch"), b = await upload("op_same_0002", "p_reels");
  as("u_priya");
  const c = await upload("op_same_0001", "p_podcast"); // same name, size and even the same op id, another person and workspace
  assert.equal(new Set([a.room.id, b.room.id, c.room.id]).size, 3);
  assert.deepEqual([a.room.ws, b.room.ws, c.room.ws], ["ws_nw", "ws_nw", "ws_hb"]);
  assert.equal(c.replayed, false);
  await fails(svc.room(a.room.id), 403); // Priya can't open Northwind's room
  await fails(upload("op_same_0003", "p_launch"), 403); // nor upload into Northwind
  await fails(svc.saveBrief(a.room.id, { outcome: "x" }, 0), 403);
  as("u_jordan");
  await fails(svc.room(c.room.id), 403);
  await fails(svc.registerUpload({ opId: "op_same_0004", projectId: "p_launch", roomId: b.room.id, file: file() }), 400); // other project's room
  as("u_admin"); assert.equal((await svc.integrity()).ok, true);
});

test("brief edits: required revision, 409 when stale, edit log per field, ready needs the essentials", async () => {
  const { room } = await upload("op_brief_0001", "p_launch");
  await fails(svc.saveBrief(room.id, { outcome: "x" }), 400); // no expectedRev
  const b1 = await svc.saveBrief(room.id, { outcome: "Visits", requestedDate: "2026-11-06" }, 0);
  assert.equal(b1.rev, 1); assert.deepEqual(b1.editLog.map((e) => e.field), ["outcome", "requestedDate"]);
  await fails(svc.saveBrief(room.id, { outcome: "Other tab" }, 0), 409, "stale");
  await fails(svc.saveBrief(room.id, { colour: "red" }, 1), 400);
  await fails(svc.saveBrief(room.id, { platforms: ["myspace"] }, 1), 400);
  const e = await fails(svc.markBriefReady(room.id, 1), 400);
  assert.deepEqual(e.missing, ["Editing instructions", "Platforms or shape"]);
  const b2 = await svc.saveBrief(room.id, { instructions: "Open on the pour", aspects: ["9:16"] }, 1);
  const ready = await svc.markBriefReady(room.id, b2.rev);
  assert.equal(ready.status, "ready"); assert.equal((await svc.room(room.id)).stage, "Ready to submit");
  const back = await svc.saveBrief(room.id, { instructions: "" }, ready.rev); // removing an essential returns it to draft
  assert.equal(back.status, "draft");
  as("u_sam"); await fails(svc.saveBrief(room.id, { outcome: "x" }, back.rev), 403);
});

test("submission is idempotent and freezes an immutable snapshot; the request links back to its room", async () => {
  const { room, rev } = await readyRoom();
  await svc.addNote(room.id, { kind: "drawing", t: 4.2, shapes: [{ type: "circle", x: 0.2, y: 0.3, w: 0.2, h: 0.2 }], body: "Start here" });
  await fails(svc.submitBrief(room.id, { expectedRev: rev - 1 }), 409, "stale");
  const [x, y] = await Promise.all([svc.submitBrief(room.id, { expectedRev: rev }), svc.submitBrief(room.id, { expectedRev: rev })]);
  assert.equal(x.request.id, y.request.id); assert.ok(x.replayed !== y.replayed);
  const again = await svc.submitBrief(room.id, { expectedRev: rev, key: `${room.briefId}:${rev}` });
  assert.equal(again.replayed, true);
  const rm = await svc.room(room.id);
  assert.equal(rm.stage, "Submitted for editing"); assert.equal(rm.requestId, x.request.id);
  assert.equal(x.request.roomId, room.id); assert.equal(x.request.briefRev, rev); assert.equal(x.request.due, ""); // estimate is Menapoly's to set
  assert.equal(rm.snapshots.length, 1); assert.ok(rm.snapshots[0].intact); assert.equal(rm.snapshots[0].noteIds.length, 1);
  await fails(svc.saveBrief(room.id, { outcome: "Changed later" }, rev), 409, "submitted");
  const snap = rm.snapshots[0], tampered = { ...snap, fields: { ...snap.fields, outcome: "Changed later" } };
  assert.equal(snapshotIntact(tampered), false);
  assert.equal((await svc.video(room.id)).id, room.id); // the existing Editing Room opens under the same id
  as("u_admin"); assert.equal((await svc.integrity()).ok, true);
  await svc.assignRequest(x.request.id, "u_sam"); as("u_sam");
  assert.equal((await svc.room(room.id)).stage, "Assigned"); // now the assigned editor sees it
});

test("briefing, drawings, voice notes and questions never use a revision round; change requests still do (once)", async () => {
  const { room, rev } = await readyRoom("op_rounds_0001");
  await svc.addNote(room.id, { body: "Warm, slow open" });
  await svc.addNote(room.id, { kind: "voice", t: 8.6, voice: { blobKey: "rec_1", mime: "audio/webm;codecs=opus", duration: 14, storage: "device" } });
  const { request } = await svc.submitBrief(room.id, { expectedRev: rev });
  await svc.addNote(room.id, { body: "Use the new logo file" }); // added after submission, still a brief note
  as("u_admin"); await svc.assignRequest(request.id, "u_sam");
  as("u_sam");
  const q = await svc.addNote(room.id, { body: "OK to dissolve into the pour?", t: 4 });
  assert.equal(q.phase, "question");
  as("u_jordan");
  const rid = (await svc.room(room.id)).reviewId;
  await svc.addComment(rid, { version: 0, t: 2, body: "Clarifying: the pour is the hero" });
  let rm = await svc.room(room.id);
  assert.equal(rm.revisions.used, 0); assert.equal(rm.revisions.remaining, rm.revisions.total);
  assert.deepEqual([...new Set(rm.instructions.map((n) => n.phase))].sort(), ["brief", "question"]);
  assert.ok(rm.instructions.find((n) => n.body === "Use the new logo file").afterSubmission);
  // First formal review: one round, and never twice for the same version
  as("u_sam"); await svc.startRequest(request.id); await svc.uploadVersion(rid, "First cut");
  as("u_jordan");
  const rev1 = await svc.addNote(room.id, { body: "Logo too small", t: 6, version: 1 });
  assert.equal(rev1.phase, "revision");
  assert.equal((await svc.room(room.id)).revisions.used, 0); // feedback notes alone don't count
  await svc.decide(rid, "changes", "Bigger logo", 1);
  await fails(svc.decide(rid, "changes", "Again", 1), 409);
  rm = await svc.room(room.id);
  assert.equal(rm.revisions.used, 1); assert.equal(rm.stage, "Changes requested");
  // Existing seeded rooms: notes and comments before a version don't touch their ledgers either
  as("u_priya"); await svc.addComment("rv_pod", { version: 0, t: 5, body: "Also trim the intro" });
  assert.equal((await svc.review("rv_pod")).revisions.used, 0);
});

test("old rooms and approvals still work after the change", async () => {
  const launch = await svc.video("v_launch");
  assert.equal(launch.status, "Ready for review"); assert.equal(launch.revisions.used, 1);
  await svc.decide("rv_launch", "approve", "", 2);
  assert.equal((await svc.room("v_launch")).stage, "Approved");
  as("u_admin");
  const done = await svc.completeRoom("v_launch");
  assert.equal(done.stage, "Completed");
  await fails(svc.completeRoom("v_launch"), 409);
  await fails(svc.completeRoom("v_pod"), 409); // not approved yet
  as("u_jordan"); await fails(svc.completeRoom("v_reel"), 403);
});

test("request-first flows still work and each request gets a room with a submitted brief", async () => {
  const req = await svc.createRequest({ projectId: "p_launch", key: "form_0001", title: "Cafe tour", brief: "A 30 s tour", aspect: "9:16", due: "2026-11-20", assetIds: ["a_launch_v2"] });
  const dup = await svc.createRequest({ projectId: "p_launch", key: "form_0001", title: "Cafe tour", brief: "A 30 s tour" });
  assert.equal(dup.id, req.id);
  const rm = await svc.room(req.videoId);
  assert.equal(rm.id, req.videoId); assert.equal(rm.brief.status, "submitted"); assert.equal(rm.snapshots[0].source, "request-form");
  assert.equal(req.requestedDate, "2026-11-20"); assert.equal(rm.stage, "Submitted for editing");
  const more = await svc.videoAction("v_reel", "another", { key: "more_0001", change: "new tip" });
  assert.equal((await svc.room(more.roomId)).requestId, more.id);
  as("u_admin"); const r = await svc.integrity(); assert.equal(r.ok, true, r.issues.join("; ")); assert.equal(r.rooms, 5);
});

test("notes: validation, workspace ownership, and only your own draft notes can be deleted", async () => {
  const { room } = await upload("op_notes_0001", "p_launch");
  await fails(svc.addNote(room.id, { kind: "drawing", shapes: [{ type: "laser" }], body: "x" }), 400);
  await fails(svc.addNote(room.id, { kind: "drawing", shapes: [{ type: "arrow", x: 0, y: 0, x2: 1, y2: 1 }] }), 400); // needs a description
  await fails(svc.addNote(room.id, { kind: "voice", voice: { blobKey: "k", mime: "audio/webm", duration: 5, storage: "server" } }), 400);
  await fails(svc.addNote(room.id, { kind: "voice", voice: { blobKey: "k", mime: "audio/webm", duration: 500, storage: "device" } }), 400);
  await fails(svc.addNote(room.id, { body: "x", version: 3 }), 400);
  const d = await svc.addNote(room.id, { kind: "drawing", t: 1, shapes: [{ type: "graphic-zone", x: 2, y: -1, w: 0.3, h: 0.2, label: "Date" }], body: "Put the date here" });
  assert.deepEqual([d.shapes[0].x, d.shapes[0].y], [1, 0]); // clamped to the frame
  const v = await svc.addNote(room.id, { kind: "voice", voice: { blobKey: "rec_9", mime: "audio/webm", duration: 3.25, storage: "device", uploaded: true, transcript: "made up" } });
  assert.equal(v.voice.uploaded, false); assert.equal(v.voice.transcript, null); // never claims upload or invents a transcript
  as("u_admin"); await fails(svc.deleteNote(room.id, v.id), 403);
  as("u_jordan"); assert.deepEqual(await svc.deleteNote(room.id, v.id), { deleted: v.id, blobKey: "rec_9" });
  as("u_priya"); await fails(svc.addNote(room.id, { body: "x" }), 403);
});

test("persistence: storage failures are reported, never hidden; media availability is honest after a refresh", async () => {
  const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
  globalThis.localStorage = { getItem: () => null, setItem: () => { throw quota; }, removeItem() {} };
  try {
    await svc.createFolder("ws_nw", "Probe");
    const p = svc.persistence();
    assert.equal(p.ok, false); assert.equal(p.reason, "quota"); assert.match(p.message, /full/);
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    await svc.createFolder("ws_nw", "Probe 2");
    assert.equal(svc.persistence().ok, true);
  } finally { delete globalThis.localStorage; }
  assert.equal(mediaAvailability({ storage: "session" }, { sessionUrl: false }).missing, true); // refreshed: object URL gone
  assert.equal(mediaAvailability({ storage: "device" }, { deviceBlob: false }).missing, true);
  assert.equal(mediaAvailability({ storage: "demo", media: "v1" }).available, true);
  assert.ok(Object.values({ a: mediaAvailability({ storage: "session" }), b: mediaAvailability({ storage: "device" }) }).every((x) => x.uploaded === false));
  const up = await upload("op_media_0001", "p_launch");
  assert.equal(up.asset.storageInfo.storage, "none"); assert.equal(up.asset.storageInfo.available, false);
});

test("microphone and device storage: unsupported, denied, blocked and missing are explained, never faked", async () => {
  assert.equal(micSupport({ isSecureContext: false }).reason, "insecure");
  assert.equal(micSupport({ isSecureContext: true, navigator: {} }).reason, "no-media-devices");
  assert.equal(micSupport({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } }).reason, "no-recorder");
  assert.equal(micSupport({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: function () {} }).ok, true);
  const top = {}, page = { self: top, top };
  assert.equal(micError({ name: "NotAllowedError" }, page).reason, "denied");
  assert.equal(micError({ name: "NotAllowedError" }, { self: {}, top: {} }).reason, "blocked"); // inside a frame
  assert.equal(micError({ name: "NotFoundError" }, page).reason, "no-device");
  assert.equal(micError({ name: "NotReadableError" }, page).reason, "busy");
  const store = deviceStore({});
  assert.equal((await store.put("k", "blob")).reason, "unavailable");
  assert.equal((await store.get("k")).ok, false);
});

test("pure model rules: stages, brief fields, shapes and voice", () => {
  assert.equal(roomStage({}, { brief: { status: "draft", fields: { platforms: [], aspects: [] } } }), "Uploaded");
  assert.equal(roomStage({ completedAt: "x" }, { review: { status: "Approved" } }), "Completed");
  assert.throws(() => sanitizeBriefPatch({ references: [{ url: "javascript:alert(1)" }] }), /web addresses/);
  assert.deepEqual(sanitizeBriefPatch({ references: [{ url: "https://example.com/ref" }] }).references[0].label, "https://example.com/ref");
  assert.throws(() => validateShapes(Array(51).fill({ type: "box" })), /50 shapes/);
  assert.throws(() => validateVoice({ storage: "device", duration: 3, mime: "video/mp4", blobKey: "k" }), /audio/);
  assert.equal(can({ id: "u_sam", role: "editor" }, "room.complete", {}), false);
});
