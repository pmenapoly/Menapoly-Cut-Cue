// Mock service layer for the preview. It stands where the real API will stand: every call checks policy.js,
// writes an audit entry and returns copies. Data lives in this browser only (localStorage), seeded with fictional
// fixtures. There is deliberately no fetch/XHR/WebSocket anywhere in the preview.
import { seed, visibilityFixtures, MEDIA } from "./data.js";
import { can, enforce, canViewProject, canViewAsset, canViewWorkspace, Denied, PLANS } from "./policy.js";
import { migrate6, emptyFields, sanitizeBriefPatch, briefMissing, validateShapes, validateVoice, roomStage, notePhase, fieldsFromRequest,
  fingerprint, snapshotBody, snapshotIntact, NOTE_KINDS, UPLOAD_OP } from "./rooms.js";
import { mediaAvailability } from "./local-media.js";

const KEY = "menapoly-cue-studio-demo";
const SESSION = "menapoly-cue-studio-session";
const clone = (v) => JSON.parse(JSON.stringify(v));
const now = () => new Date().toISOString();
let seq = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;
const localMedia = new Map(); // object URLs for files picked this session (never uploaded, never persisted)

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw), was = s?.version, up = migrateState(s);
      if (up) { if (was !== up.version) { try { localStorage.setItem(KEY, JSON.stringify(up)); } catch { /* in-memory only */ } } return up; }
    }
  } catch { /* storage blocked or unreadable: run in memory */ }
  return seed();
}

/** Brings saved demo state forward (5 → 6 → 7). Unknown or future versions return null and the fictional seed is used. */
export function migrateState(s) {
  if (s?.version === 5) s = migrate5(s);
  if (s?.version === 6) s = migrate6(s);
  return s?.version === 7 ? s : null;
}

/**
 * Demo state from the previous preview (version 5) moves forward instead of being wiped, so work in progress continues:
 * social statuses map to the review lifecycle; project revision limits become contracted overrides; counted revisions
 * become rounds; any usage above the new allowance is covered by a recorded carry-over grant (never a silent block).
 */
export function migrate5(s) {
  const iso = new Date().toISOString();
  (s.posts || []).forEach((p) => {
    p.rev = p.rev || 1; p.submittedBy = p.submittedBy ?? (/awaiting|approved|ready/i.test(p.status) ? p.by : null);
    p.reviewerId = p.reviewerId ?? ((p.history || []).filter((h) => /^approved/i.test(h.action)).pop()?.by || null);
    p.status = p.status === "Awaiting approval" ? "Submitted" : /ready to schedule/i.test(p.status) ? "Prepared for publishing" : p.status;
  });
  (s.projects || []).forEach((p) => { if (p.revisionLimit != null) { p.revisionsIncluded = p.revisionLimit; delete p.revisionLimit; } });
  (s.requests || []).forEach((r) => { r.dueRev = r.dueRev || 0; r.dueHistory = r.dueHistory || []; });
  (s.reviews || []).forEach((r) => {
    const req = (s.requests || []).find((x) => x.id === r.requestId), used = req?.revisionsUsed || 0;
    r.rounds = r.rounds || Array.from({ length: used }, () => ({ version: null, at: req?.at || iso, by: req?.by || null, note: "Counted before revision tracking (demo migration)", kind: "included" }));
    r.extraRounds = r.extraRounds || []; r.extraAsks = r.extraAsks || [];
    const p = (s.projects || []).find((x) => x.id === r.projectId), w = (s.workspaces || []).find((x) => x.id === r.ws);
    const included = p?.revisionsIncluded ?? w?.revisionsIncluded ?? PLANS[w?.plan]?.revisionsIncluded ?? 0;
    if (r.rounds.length > included) r.extraRounds.push({ id: `xr_mig_${r.id}`, rounds: r.rounds.length - included, by: null, at: iso,
      reason: "Carried over: rounds used before allowances were configured (demo migration)" });
  });
  s.version = 6;
  return s;
}
let state = load();
let session = (() => { try { return JSON.parse(sessionStorage.getItem(SESSION) || localStorage.getItem(SESSION) || "null"); } catch { return null; } })()
  || { userId: "u_jordan", ws: null };
const flags = { failRequests: false, latency: true };

// Whether the last save reached this browser's storage. A failure is reported (svc.persistence), never hidden.
const persistence = { ok: true, mode: "browser", reason: null, failures: 0, at: null };
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); Object.assign(persistence, { ok: true, mode: "browser", reason: null, at: now() }); }
  catch (e) {
    const quota = e?.name === "QuotaExceededError" || e?.code === 22;
    Object.assign(persistence, { ok: false, mode: "memory", reason: quota ? "quota" : "blocked", failures: persistence.failures + 1, at: now() });
  }
}
function saveSession() { try { localStorage.setItem(SESSION, JSON.stringify(session)); } catch { /* ignore */ } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Like a server, a call acts as the person who started it, even if the demo role is switched while it's in flight.
let acting = null;
async function call(fn) {
  const who = session.userId;
  if (flags.latency) await sleep(120 + Math.random() * 160);
  if (flags.failRequests) { const e = new Error("The demo service is simulating an outage. Turn it off in Settings → Preview tools."); e.code = 503; throw e; }
  acting = who;
  try { return clone(fn()); } finally { acting = null; }
}

const user = () => state.users.find((u) => u.id === (acting || session.userId)) || state.users[0];
const project = (pid) => state.projects.find((p) => p.id === pid);
const userName = (uid) => state.users.find((u) => u.id === uid)?.name || "Someone";
function log(action, detail, ws, pid) {
  state.activity.unshift({ id: id("act"), at: now(), by: user().id, action, detail, ws, pid: pid || null });
  state.activity = state.activity.slice(0, 200);
}
function notify(to, text, link) { if (to && to !== user().id) state.notifications.unshift({ id: id("n"), to, at: now(), text, link, read: false }); }
/** One notification per person, even when they're in several of the target groups. */
function notifyAll(ids, text, link) { [...new Set(ids.filter(Boolean))].forEach((uid) => notify(uid, text, link)); }
const admins = () => state.users.filter((u) => u.role === "admin").map((u) => u.id);
const clientsOf = (ws) => state.users.filter((u) => u.role === "client" && (u.workspaceIds || []).includes(ws)).map((u) => u.id);
const roomLink = (rid) => { const v = state.videos.find((x) => x.reviewId === rid); return v ? `video-${v.id}` : `review-${rid}`; };
function conflict(message, reason) { const e = new Error(message); e.code = 409; if (reason) e.reason = reason; return e; }

/** Revision allowance for one video: included rounds (project → workspace → plan), plus approved additional rounds. */
function includedFor(p) {
  const w = state.workspaces.find((x) => x.id === p?.ws);
  if (p?.revisionsIncluded != null) return { included: p.revisionsIncluded, source: "this project's agreement" };
  if (w?.revisionsIncluded != null) return { included: w.revisionsIncluded, source: `${w.name}'s agreement` };
  return { included: PLANS[w?.plan]?.revisionsIncluded ?? 0, source: `the ${PLANS[w?.plan]?.label || "current"} plan` };
}
function allowanceOf(r) {
  const p = project(r.projectId), { included, source } = includedFor(p);
  const extra = (r.extraRounds || []).reduce((n, x) => n + x.rounds, 0), used = (r.rounds || []).length;
  return { included, source, extra, used, total: included + extra, remaining: Math.max(0, included + extra - used),
    usedIncluded: Math.min(used, included), usedExtra: Math.max(0, used - included),
    rounds: (r.rounds || []).map((x) => ({ ...x, byName: x.by ? userName(x.by) : "Demo migration" })),
    extraRounds: (r.extraRounds || []).map((x) => ({ ...x, byName: x.by ? userName(x.by) : "Demo migration" })),
    openAsk: (r.extraAsks || []).find((x) => x.status === "open") || null };
}
function visibleProjects(u = user()) { return state.projects.filter((p) => canViewProject(u, p)); }
function assetCtx(a) { return { resource: a, project: a.projectId ? project(a.projectId) : null, ws: a.ws }; }
function mediaFor(a) {
  if (a.localUrl && localMedia.has(a.id)) return { src: localMedia.get(a.id), poster: null, local: true };
  return a.media ? MEDIA[a.media] : null;
}
const withMedia = (a) => ({ ...a, mediaInfo: mediaFor(a), projectName: project(a.projectId)?.name, byName: userName(a.by),
  storageInfo: mediaAvailability(a, { sessionUrl: localMedia.has(a.id) }) });

// Another tab saved: reload so this tab never decides on stale data (a real server returns 409 for the same case).
if (typeof window !== "undefined") window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  state = load(); document.dispatchEvent(new CustomEvent("cue:external"));
});

export const svc = {
  flags,
  reset() { state = seed(); localMedia.clear(); save(); },
  // ---- session / people ----
  me: () => clone(user()),
  users: () => clone(state.users),
  userName,
  switchUser(uid) { if (state.users.some((u) => u.id === uid)) { session = { userId: uid, ws: null }; saveSession(); } },
  workspaces() {
    const u = user();
    return clone(state.workspaces.filter((w) => canViewWorkspace(u, w.id, state.projects)));
  },
  currentWs() {
    const list = this.workspaces();
    return list.find((w) => w.id === session.ws) || list[0] || null;
  },
  setWs(ws) { session.ws = ws; saveSession(); },

  // ---- projects & media ----
  projects: () => call(() => visibleProjects().map((p) => ({ ...p, editors: p.editorIds.map(userName),
    requests: state.requests.filter((r) => r.projectId === p.id).length,
    pendingReview: state.reviews.some((r) => r.projectId === p.id && r.status === "In review") }))),
  project: (pid) => call(() => {
    const p = project(pid);
    if (!p) { const e = new Error("That project doesn't exist."); e.code = 404; throw e; }
    enforce(user(), "project.view", { project: p });
    return { ...p, editors: p.editorIds.map(userName), workspace: state.workspaces.find((w) => w.id === p.ws)?.name,
      revisionsIncluded: includedFor(p).included, revisionSource: includedFor(p).source,
      allowances: Object.fromEntries(state.requests.filter((r) => r.projectId === pid).map((r) => {
        const rv = state.reviews.find((x) => x.requestId === r.id); return [r.id, rv ? allowanceOf(rv) : null]; })),
      requests: state.requests.filter((r) => r.projectId === pid).map((r) => ({ ...r, videoId: state.videos.find((v) => v.requestId === r.id)?.id || null })), reviews: state.reviews.filter((r) => r.projectId === pid),
      assets: state.assets.filter((a) => a.projectId === pid).map(withMedia) };
  }),
  folders: (ws) => call(() => { enforce(user(), "feed.view", { ws, projects: state.projects }); return state.folders.filter((f) => f.ws === ws); }),
  assets: ({ ws, folderId, q, kind, channel, mine } = {}) => call(() => {
    const u = user(); const needle = (q || "").trim().toLowerCase();
    return state.assets.filter((a) => (!ws || a.ws === ws) && canViewAsset(u, a, project(a.projectId))
      && (!folderId || a.folderId === folderId) && (!kind || kind === "all" || a.kind === kind)
      && (!channel || a.channel) && (!mine || a.by === u.id)
      && (!needle || `${a.name} ${a.tags.join(" ")} ${project(a.projectId)?.name || ""}`.toLowerCase().includes(needle)))
      .sort((x, y) => y.at.localeCompare(x.at)).map(withMedia);
  }),
  asset: (aid) => call(() => {
    const a = state.assets.find((x) => x.id === aid);
    if (!a) { const e = new Error("That file doesn't exist."); e.code = 404; throw e; }
    enforce(user(), "asset.view", assetCtx(a));
    return withMedia(a);
  }),
  createFolder: (ws, name) => call(() => {
    enforce(user(), "folder.create", { ws });
    const clean = String(name || "").trim().slice(0, 60);
    if (!clean) { const e = new Error("Give the folder a name."); e.code = 400; throw e; }
    const f = { id: id("f"), ws, name: clean }; state.folders.push(f); log("Created folder", clean, ws); save(); return f;
  }),
  moveAsset: (aid, folderId) => call(() => {
    const a = state.assets.find((x) => x.id === aid); const f = state.folders.find((x) => x.id === folderId);
    enforce(user(), "folder.move", { ws: a?.ws });
    if (!a || !f || f.ws !== a.ws) { const e = new Error("Pick a folder in the same workspace."); e.code = 400; throw e; }
    a.folderId = folderId; log("Moved file", `${a.name} → ${f.name}`, a.ws); save(); return a;
  }),
  /** Simulated upload: reads only the file's name, size and type. Nothing leaves the device. */
  addLocalFile: (file, ws, projectId, folderId) => call(() => {
    const p = projectId ? project(projectId) : null;
    enforce(user(), "asset.upload", { ws, project: p });
    const okTypes = /^(video|audio|image)\//.test(file.type) || /\.(pdf|docx?|txt|srt|vtt|zip)$/i.test(file.name);
    if (!okTypes) { const e = new Error(`${file.name}: that file type isn't accepted. Use video, audio, image or document files.`); e.code = 415; throw e; }
    if (file.size > 20 * 1024 ** 3) { const e = new Error(`${file.name} is over the 20 GB limit.`); e.code = 413; throw e; }
    const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : file.type.startsWith("image/") ? "image" : "document";
    const a = { id: id("a"), ws, projectId: projectId || null, folderId: folderId || null, name: file.name, kind, size: file.size,
      tags: ["new"], by: user().id, at: now(), channel: false, localUrl: true };
    if (file.url) localMedia.set(a.id, file.url);
    state.assets.push(a); log("Added file (simulated upload)", file.name, ws);
    state.feed.unshift({ id: id("fd"), ws, kind: "upload", by: user().id, at: now(), text: `Added ${file.name}.`, assetId: a.id, comments: [], saves: [] });
    save(); return withMedia(a);
  }),

  // ---- editing requests ----
  requests: () => call(() => state.requests.filter((r) => canViewProject(user(), project(r.projectId)))
    .map((r) => ({ ...r, projectName: project(r.projectId)?.name, assignee: r.assigneeId ? userName(r.assigneeId) : null, byName: userName(r.by),
      videoId: state.videos.find((v) => v.requestId === r.id)?.id || null }))
    .sort((a, b) => b.at.localeCompare(a.at))),
  /** Submitting is idempotent per draft key: a double tap or a retry returns the first request instead of a duplicate. */
  createRequest: (data) => call(() => newRequest(data)),
  assignRequest: (rid, editorId) => call(() => {
    const r = state.requests.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "request.assign", { project: p });
    const ed = state.users.find((u) => u.id === editorId && u.role === "editor");
    if (!ed) { const e = new Error("Pick an editor."); e.code = 400; throw e; }
    if (/approved/i.test(r.status)) throw conflict("This request is already approved. Make a new request for more work.");
    const prev = r.assigneeId;
    r.assigneeId = ed.id; if (/submitted/i.test(r.status)) r.status = "Assigned"; if (!p.editorIds.includes(ed.id)) p.editorIds.push(ed.id);
    const v = state.videos.find((x) => x.requestId === r.id);
    if (v) { v.editorId = ed.id; v.checklist.forEach((t) => { if (!t.owner || t.owner === prev) t.owner = ed.id; });
      v.history.push({ at: now(), by: user().id, action: `Assigned ${ed.name}` }); }
    log(prev ? "Reassigned editor" : "Assigned editor", `${ed.name} → ${r.title}`, p.ws, p.id);
    notify(ed.id, `You were assigned: ${r.title}`, v ? `video-${v.id}` : `project-${p.id}`);
    if (prev && prev !== ed.id) notify(prev, `${r.title} was reassigned to ${ed.name}`, `project-${p.id}`);
    notify(r.by, `${ed.name} will edit “${r.title}”`, v ? `video-${v.id}` : `project-${p.id}`);
    save(); return r;
  }),
  /** Client (or admin) asks Menapoly for an extra revision round. Recorded and sent to administrators; nothing is charged. */
  askExtraRound: (rid, note) => call(() => {
    const r = state.reviews.find((x) => x.id === rid), p = project(r?.projectId);
    enforce(user(), "revision.ask", { project: p, ws: p?.ws });
    if (allowanceOf(r).openAsk) throw conflict("An extra round has already been asked for and is waiting for your producer.");
    const ask = { id: id("xa"), by: user().id, at: now(), note: String(note || "").trim().slice(0, 500), status: "open" };
    r.extraAsks = r.extraAsks || []; r.extraAsks.push(ask); r.audit.push({ at: now(), by: user().id, action: "Asked for an extra revision round", detail: ask.note });
    admins().forEach((a) => notify(a, `${userName(user().id)} asked for an extra revision round on ${r.title}`, roomLink(r.id)));
    log("Asked for an extra revision round", r.title, p.ws, p.id); save(); return ask;
  }),
  /** Administrator approves additional rounds with a reason. expectedTotal guards against approving twice from stale screens. */
  grantExtraRound: (rid, reason, rounds = 1, expectedTotal) => call(() => {
    const r = state.reviews.find((x) => x.id === rid), p = project(r?.projectId);
    enforce(user(), "revision.grant", { project: p, ws: p?.ws });
    const why = String(reason || "").trim().slice(0, 300), n = Math.max(1, Math.min(3, Number(rounds) || 1));
    if (!why) { const e = new Error("Give a reason for the extra round so the decision is on record."); e.code = 400; throw e; }
    const before = allowanceOf(r);
    if (expectedTotal != null && before.total !== Number(expectedTotal)) throw conflict("The allowance changed since you opened this video (someone already approved a round). Refresh first.");
    r.extraRounds = r.extraRounds || []; r.extraRounds.push({ id: id("xr"), rounds: n, reason: why, by: user().id, at: now() });
    (r.extraAsks || []).filter((x) => x.status === "open").forEach((x) => { x.status = "granted"; x.closedAt = now(); });
    r.audit.push({ at: now(), by: user().id, action: `Approved ${n} additional revision round(s)`, detail: why });
    const req = state.requests.find((x) => x.id === r.requestId);
    notifyAll([...clientsOf(p.ws), ...p.editorIds, req?.by], `${n} additional revision round(s) approved for ${r.title}`, roomLink(r.id));
    log(`Approved ${n} additional revision round(s)`, `${r.title}: ${why}`, p.ws, p.id); save(); return allowanceOf(r);
  }),
  /** Target delivery date (an estimate, not a guarantee). Admin only; expectedRev refuses stale overwrites. */
  setDue: (rid, date, reason, expectedRev) => call(() => {
    const r = state.requests.find((x) => x.id === rid), p = project(r?.projectId);
    enforce(user(), "request.schedule", { project: p, ws: p?.ws });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) { const e = new Error("Pick a valid date."); e.code = 400; throw e; }
    if (expectedRev != null && (r.dueRev || 0) !== Number(expectedRev)) throw conflict("Someone changed this date after you opened it. Refresh to see the latest before changing it again.");
    if (r.due === date) throw conflict("That's already the target date.");
    const from = r.due || null; r.due = date; r.dueRev = (r.dueRev || 0) + 1;
    r.dueHistory = r.dueHistory || []; r.dueHistory.push({ from, to: date, by: user().id, at: now(), reason: String(reason || "").trim().slice(0, 200) });
    const v = state.videos.find((x) => x.requestId === r.id); if (v) v.history.push({ at: now(), by: user().id, action: `Target date ${from || "not set"} → ${date}` });
    const fmt = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en", { month: "short", day: "numeric" });
    notifyAll([r.assigneeId, r.by, ...clientsOf(p.ws)], `Target delivery for “${r.title}” moved to ${fmt(date)} (an estimate)`, v ? `video-${v.id}` : `project-${p.id}`);
    log("Changed target date", `${r.title}: ${from ? fmt(from) : "not set"} → ${fmt(date)}${reason ? ` (${String(reason).trim().slice(0, 60)})` : ""}`, p.ws, p.id);
    save(); return r;
  }),
  startRequest: (rid) => call(() => {
    const r = state.requests.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "request.start", { project: p });
    if (!/assigned|submitted|revision/i.test(r.status)) throw conflict(`This request is “${r.status}”, so editing can't start again.`);
    if (!r.assigneeId) throw conflict("Assign an editor first.");
    r.status = "In progress"; log("Started editing", r.title, p.ws, p.id);
    const v = state.videos.find((x) => x.requestId === r.id); if (v) v.history.push({ at: now(), by: user().id, action: "Started editing" });
    notify(r.by, `${userName(user().id)} started editing “${r.title}”`, v ? `video-${v.id}` : `project-${p.id}`);
    save(); return r;
  }),
  /** Admin board / editor queue: open requests with owner, deadline and lateness. Editors see only their own. */
  production: () => call(() => {
    const u = user(); enforce(u, "production.view", {});
    const today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const rows = state.requests.filter((r) => canViewProject(u, project(r.projectId)) && (u.role === "admin" || r.assigneeId === u.id)).map((r) => {
      const v = state.videos.find((x) => x.requestId === r.id), rv = v && state.reviews.find((x) => x.id === v.reviewId);
      return { ...r, projectName: project(r.projectId)?.name, workspace: state.workspaces.find((w) => w.id === r.ws)?.name, assignee: r.assigneeId ? userName(r.assigneeId) : null,
        byName: userName(r.by), videoId: v?.id || null, stage: v ? roomStatus(v, rv) : r.status, overdue: Boolean(r.due && r.due < today && !/approved/i.test(r.status)),
        // At risk: target within 3 days while the work hasn't reached the client yet.
        atRisk: Boolean(r.due && r.due >= today && r.due <= soon && !/approved|in review/i.test(r.status)), revisions: rv ? allowanceOf(rv) : null,
        versions: rv?.versions.length || 0, open: rv ? rv.comments.filter((c) => !c.resolved).length : 0,
        tasks: v ? v.checklist.length : 0, done: v ? v.checklist.filter((t) => t.done).length : 0 };
    }).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    const editors = u.role === "admin" ? state.users.filter((x) => x.role === "editor").map((ed) => {
      const mine = rows.filter((r) => r.assigneeId === ed.id && !/approved/i.test(r.status));
      return { id: ed.id, name: ed.name, title: ed.title, open: mine.length, overdue: mine.filter((r) => r.overdue).length, atRisk: mine.filter((r) => r.atRisk).length,
        next: mine.find((r) => r.due)?.due || null };
    }) : [];
    return { rows, editors };
  }),
  projectActivity: (pid) => call(() => {
    enforce(user(), "project.view", { project: project(pid) });
    return state.activity.filter((a) => a.pid === pid).slice(0, 40).map((a) => ({ ...a, byName: userName(a.by) }));
  }),

  // ---- reviews ----
  reviews: () => call(() => state.reviews.filter((r) => canViewProject(user(), project(r.projectId))).map((r) => ({
    ...r, projectName: project(r.projectId)?.name, open: r.comments.filter((c) => !c.resolved).length,
    latest: r.versions[r.versions.length - 1] || { n: 0 }, videoId: state.videos.find((v) => v.reviewId === r.id)?.id,
    poster: MEDIA[r.versions[r.versions.length - 1]?.media || state.videos.find((v) => v.reviewId === r.id)?.original.media]?.poster }))),
  review: (rid) => call(() => {
    const r = state.reviews.find((x) => x.id === rid);
    if (!r) { const e = new Error("That review doesn't exist."); e.code = 404; throw e; }
    const p = project(r.projectId); enforce(user(), "review.view", { project: p });
    const req = state.requests.find((x) => x.id === r.requestId);
    const al = allowanceOf(r);
    return { ...r, projectName: p.name, revisionLimit: al.total, revisionsUsed: al.used, revisions: al,
      versions: r.versions.map((v) => ({ ...v, ...MEDIA[v.media], byName: userName(v.by) })),
      comments: r.comments.map((c) => ({ ...c, byName: userName(c.by), replies: c.replies.map((x) => ({ ...x, byName: userName(x.by) })) })),
      audit: r.audit.map((a) => ({ ...a, byName: userName(a.by) })) };
  }),
  addComment: (rid, { version, t, shape, body }) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "review.comment", { project: p });
    const text = String(body || "").trim().slice(0, 2000);
    if (!text) { const e = new Error("Write what should change before sending."); e.code = 400; throw e; }
    // Phase: briefing or clarification before the first edited version, revision feedback after. Never a revision round.
    const c = { id: id("c"), version, t: Math.max(0, Number(t) || 0), shape: shape || null, body: text, by: user().id, at: now(), resolved: false, replies: [],
      phase: notePhase({ role: user().role, versions: r.versions.length }) };
    r.comments.push(c); r.audit.push({ at: now(), by: user().id, action: `Commented at ${fmtT(c.t)}`, detail: text.slice(0, 80) });
    // The other side hears about it: client feedback reaches the editing team, editor notes reach the client.
    const to = user().role === "client" ? [...p.editorIds, ...admins()] : clientsOf(p.ws);
    notifyAll(to, `${userName(user().id)} left feedback at ${fmtT(c.t)} on ${r.title}`, roomLink(r.id));
    log("Left feedback", `${r.title} at ${fmtT(c.t)}`, p.ws, p.id); save(); return c;
  }),
  reply: (rid, cid, body) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId); enforce(user(), "review.comment", { project: p });
    const c = r.comments.find((x) => x.id === cid); const text = String(body || "").trim().slice(0, 2000);
    if (!c || !text) { const e = new Error("Write a reply first."); e.code = 400; throw e; }
    c.replies.push({ by: user().id, body: text, at: now() });
    notify(c.by, `${userName(user().id)} replied to your feedback on ${r.title}`, roomLink(r.id)); save(); return c;
  }),
  resolve: (rid, cid, resolved) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId); const c = r?.comments.find((x) => x.id === cid);
    enforce(user(), "review.resolve", { project: p, resource: c, ws: p?.ws });
    c.resolved = resolved; r.audit.push({ at: now(), by: user().id, action: resolved ? "Resolved a comment" : "Reopened a comment" });
    notify(c.by, `${userName(user().id)} ${resolved ? "resolved" : "reopened"} your feedback on ${r.title}`, roomLink(r.id));
    log(resolved ? "Resolved feedback" : "Reopened feedback", r.title, p.ws, p.id); save(); return c;
  }),
  /** expectedVersion: the version the person was looking at. A newer version or an earlier decision makes it stale. */
  decide: (rid, decision, note, expectedVersion) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "review.decide", { project: p, ws: p?.ws });
    const req = state.requests.find((x) => x.id === r.requestId);
    if (r.status !== "In review") throw conflict(r.status === "Approved" ? "This video is already approved. Refresh to see the latest." : `This video is “${r.status.toLowerCase()}”, so there's no version waiting for a decision. Refresh to see the latest.`);
    const latestN = r.versions[r.versions.length - 1]?.n;
    if (expectedVersion != null && latestN !== Number(expectedVersion)) throw conflict(`Version ${latestN} arrived after you opened version ${expectedVersion}. Watch the newest version before deciding.`);
    if (decision === "changes") {
      const text = String(note || "").trim();
      if (!text) { const e = new Error("Say what should change so the editor can act on it."); e.code = 400; throw e; }
      // One revision round per formal change request on a submitted version; never twice for the same version.
      if ((r.rounds || []).some((x) => x.version === latestN)) throw conflict(`Changes were already requested on version ${latestN}; that round is already counted.`, "duplicate");
      const a = allowanceOf(r);
      if (a.remaining <= 0) throw conflict(`All ${a.total} revision round(s) for this video are used (${a.included} included${a.extra ? `, ${a.extra} additional` : ""}). Ask your producer for an extra round.`, "allowance");
      r.rounds = r.rounds || []; r.rounds.push({ version: latestN, at: now(), by: user().id, note: text.slice(0, 200), kind: a.used >= a.included ? "additional" : "included" });
      r.status = "Changes requested"; if (req) { req.status = "Revision"; }
      r.audit.push({ at: now(), by: user().id, action: "Requested changes", detail: text.slice(0, 120) });
      p.editorIds.forEach((e) => notify(e, `Changes requested on ${r.title}: “${text.slice(0, 60)}”`, roomLink(r.id)));
      admins().forEach((a) => notify(a, `Changes requested on ${r.title}`, roomLink(r.id)));
    } else if (decision === "approve") {
      if (!r.versions.length) { const e = new Error("There's no edited version to approve yet."); e.code = 409; throw e; }
      r.status = "Approved"; if (req) req.status = "Approved";
      r.audit.push({ at: now(), by: user().id, action: `Approved version ${r.versions.length}` });
      const latest = r.versions[r.versions.length - 1];
      const v = state.videos.find((x) => x.reviewId === r.id);
      const a = state.assets.find((x) => v && x.videoId === v.id && x.version === latest.n) || state.assets.find((x) => x.projectId === p.id && x.media === latest.media); if (a) a.channel = true;
      state.feed.unshift({ id: id("fd"), ws: p.ws, kind: "approved", by: user().id, at: now(), text: `Approved ${r.title} (version ${r.versions.length}).`,
        assetId: a?.id, comments: [], saves: [] });
      notifyAll([...p.editorIds, ...admins()], `${r.title} was approved (version ${r.versions.length})`, roomLink(r.id));
    } else { const e = new Error("Unknown decision"); e.code = 400; throw e; }
    log(decision === "approve" ? `Approved version ${r.versions.length}` : "Requested changes", r.title, p.ws, p.id); save(); return r;
  }),
  /** Simulated: adds a new version using an existing demo clip. No rendering happens in the preview. */
  uploadVersion: (rid, note) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "review.upload_version", { project: p });
    if (r.status === "Approved") throw conflict("This video is already approved. Use “Make more from this video” for new work.");
    const v = state.videos.find((x) => x.reviewId === r.id), req = state.requests.find((x) => x.id === r.requestId);
    const prev = r.versions[r.versions.length - 1];
    // The preview can't render: it reuses a synthetic clip and labels the version simulated.
    const media = prev ? (prev.media === "v1" ? "v2" : prev.media) : v?.original.media || DEMO_CLIP[req?.type] || "v2";
    r.versions.push({ n: r.versions.length + 1, media, by: user().id, at: now(), note: String(note || "Revised cut").slice(0, 200), simulated: true });
    // Each submitted version is a deliverable file (a reused synthetic clip, labelled simulated); approval makes it shareable.
    if (v && !state.assets.some((a) => a.videoId === v.id && a.version === r.versions.length)) {
      const slug = r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      state.assets.push({ id: id("a"), videoId: v.id, version: r.versions.length, ws: p.ws, projectId: p.id, folderId: null, name: `${slug}-v${r.versions.length}.mp4`, kind: "video",
        media, size: MEDIA[media] ? 200000 : 0, tags: ["deliverable", "simulated render"], by: user().id, at: now(), channel: false });
    }
    r.status = "In review"; if (req) req.status = "In review";
    r.audit.push({ at: now(), by: user().id, action: `Uploaded version ${r.versions.length} (simulated)` });
    if (v) v.history.push({ at: now(), by: user().id, action: `Submitted version ${r.versions.length} for review` });
    clientsOf(p.ws).forEach((c) => notify(c, `Version ${r.versions.length} of ${r.title} is ready for your review`, roomLink(r.id)));
    log(`Submitted version ${r.versions.length}`, r.title, p.ws, p.id); save(); return r;
  }),

  // ---- feed ----
  feed: (ws) => call(() => {
    enforce(user(), "feed.view", { ws, projects: state.projects });
    const u = user();
    return state.feed.filter((f) => f.ws === ws).filter((f) => {
      if (u.role !== "editor") return true;
      const a = state.assets.find((x) => x.id === f.assetId);
      return a ? canViewAsset(u, a, project(a.projectId)) : f.kind === "coaching";
    }).map((f) => {
      const a = state.assets.find((x) => x.id === f.assetId);
      return { ...f, byName: userName(f.by), asset: a ? withMedia(a) : null, saved: f.saves.includes(u.id),
        comments: f.comments.map((c) => ({ ...c, byName: userName(c.by) })) };
    });
  }),
  commentFeed: (fid, body) => call(() => {
    const f = state.feed.find((x) => x.id === fid); enforce(user(), "feed.comment", { ws: f?.ws, projects: state.projects });
    const text = String(body || "").trim().slice(0, 1000);
    if (!text) { const e = new Error("Write a comment first."); e.code = 400; throw e; }
    f.comments.push({ by: user().id, body: text, at: now() }); save(); return f;
  }),
  toggleSave: (fid) => call(() => {
    const f = state.feed.find((x) => x.id === fid); enforce(user(), "feed.view", { ws: f?.ws, projects: state.projects });
    const me = user().id; f.saves = f.saves.includes(me) ? f.saves.filter((x) => x !== me) : [...f.saves, me]; save(); return f;
  }),

  // ---- social ----
  posts: (ws) => call(() => {
    const u = user();
    return state.posts.filter((p) => (!ws || p.ws === ws) && (u.role === "admin" || (u.role === "client" && u.workspaceIds.includes(p.ws))))
      .map((p) => ({ ...p, asset: withMedia(state.assets.find((a) => a.id === p.assetId)), byName: userName(p.by),
        submittedByName: p.submittedBy ? userName(p.submittedBy) : null, reviewerName: p.reviewerId ? userName(p.reviewerId) : null,
        owner: state.workspaces.find((w) => w.id === p.ws)?.name, canReview: p.status === "Submitted" && p.submittedBy !== u.id && can(u, "post.review", { ws: p.ws }),
        history: p.history.map((x) => ({ ...x, byName: userName(x.by) })) }));
  }),
  /** Saves captions. Editing a submitted or approved post returns it to Draft (new revision): approval covers exact text. */
  savePost: (data) => call(() => {
    const a = state.assets.find((x) => x.id === data.assetId);
    enforce(user(), "post.create", { ws: a?.ws });
    if (!a?.channel) { const e = new Error("Only approved media can be shared. Approve it in Review first."); e.code = 409; throw e; }
    if (!data.platforms?.length) { const e = new Error("Pick at least one channel."); e.code = 400; throw e; }
    let p = data.id && state.posts.find((x) => x.id === data.id);
    if (p && /prepared/i.test(p.status)) throw conflict("This post is prepared for publishing. Make a new draft to change it.");
    if (!p) { p = { id: id("s"), ws: a.ws, assetId: a.id, status: "Draft", rev: 1, by: user().id, at: now(), submittedBy: null, reviewerId: null, history: [] }; state.posts.unshift(p);
      p.history.push({ at: now(), by: user().id, action: "Created draft", rev: 1 }); }
    else if (/submitted|approved|changes/i.test(p.status)) {
      const was = p.status; p.rev += 1; p.status = "Draft"; p.submittedBy = null;
      p.history.push({ at: now(), by: user().id, action: was === "Changes requested" ? "Revised after feedback" : `Edited while ${was.toLowerCase()}: needs review again`, rev: p.rev });
    } else p.history.push({ at: now(), by: user().id, action: "Saved draft", rev: p.rev });
    Object.assign(p, { captions: data.captions || {}, platforms: data.platforms, scheduledFor: data.scheduledFor || null });
    log("Saved social draft", a.name, a.ws); save(); return p;
  }),
  /** Draft (or Changes requested) → Submitted. Reviewers are told; the submitter can't review it themselves. */
  submitPost: (pid, expectedRev) => call(() => {
    const p = state.posts.find((x) => x.id === pid); enforce(user(), "post.edit", { ws: p?.ws });
    if (!/^(draft|changes requested)$/i.test(p.status)) throw conflict(`This post is “${p.status.toLowerCase()}”, so it can't be submitted again.`);
    if (expectedRev != null && p.rev !== Number(expectedRev)) throw conflict("This draft changed since you opened it. Refresh to see the latest.");
    p.status = "Submitted"; p.submittedBy = user().id; p.reviewerId = null;
    p.history.push({ at: now(), by: user().id, action: "Submitted for review", rev: p.rev });
    const asset = state.assets.find((a) => a.id === p.assetId)?.name || "a post";
    notifyAll([...admins(), ...clientsOf(p.ws)], `Social draft for ${asset} is waiting for your review`, "social");
    log("Submitted social draft", asset, p.ws); save(); return p;
  }),
  /** Reviewer decision on a submitted post: approve, or request changes with a comment. Stale or repeated → 409. */
  reviewPost: (pid, decision, note, expectedRev) => call(() => {
    const p = state.posts.find((x) => x.id === pid); enforce(user(), "post.review", { ws: p?.ws });
    if (p.status !== "Submitted") throw conflict(p.status === "Draft" ? "Submit the draft for review first." : `This post is already “${p.status.toLowerCase()}”. Refresh to see the latest.`);
    if (expectedRev != null && p.rev !== Number(expectedRev)) throw conflict("This post was edited after you opened it. Review the latest text.");
    if (p.submittedBy === user().id) { const e = new Error("You submitted this post, so another reviewer needs to approve it or request changes."); e.code = 403; throw e; }
    const asset = state.assets.find((a) => a.id === p.assetId)?.name || "a post", text = String(note || "").trim().slice(0, 1000);
    if (decision === "changes") {
      if (!text) { const e = new Error("Say what should change so the author can fix it."); e.code = 400; throw e; }
      p.status = "Changes requested"; p.reviewerId = user().id;
      p.history.push({ at: now(), by: user().id, action: "Requested changes", note: text, rev: p.rev });
      notifyAll([p.by, p.submittedBy], `Changes requested on the social draft for ${asset}: “${text.slice(0, 60)}”`, "social");
    } else if (decision === "approve") {
      p.status = "Approved"; p.reviewerId = user().id;
      p.history.push({ at: now(), by: user().id, action: "Approved", note: text || null, rev: p.rev });
      notifyAll([p.by, p.submittedBy, ...admins()], `Social draft for ${asset} was approved (not published)`, "social");
    } else { const e = new Error("Unknown decision"); e.code = 400; throw e; }
    log(decision === "approve" ? "Approved social draft" : "Requested changes on social draft", asset, p.ws); save(); return p;
  }),
  approvePost: (pid, expectedRev) => svc.reviewPost(pid, "approve", "", expectedRev),
  /** Approved → Prepared for publishing. Preparation only: no account is connected, so nothing is ever "Published". */
  schedulePost: (pid) => call(() => {
    const p = state.posts.find((x) => x.id === pid); enforce(user(), "post.prepare", { ws: p?.ws });
    if (p.status !== "Approved") throw conflict(p.status === "Prepared for publishing" ? "This post is already prepared." : "Approve the post before preparing it for publishing.");
    p.status = "Prepared for publishing"; p.history.push({ at: now(), by: user().id, action: "Prepared for publishing (simulated; nothing was posted)", rev: p.rev });
    notify(p.by, `A social post was prepared for publishing (simulated; not published)`, "social");
    save(); return p;
  }),

  // ---- coaching ----
  lessons: () => call(() => state.lessons.map((l) => ({ ...l, progress: state.progress[user().id]?.[l.id] || 0, mediaInfo: l.media ? MEDIA[l.media] : null }))),
  setProgress: (lid, pct) => call(() => {
    const me = user().id; state.progress[me] = state.progress[me] || {}; state.progress[me][lid] = Math.max(state.progress[me][lid] || 0, Math.min(100, pct)); save();
    return state.progress[me][lid];
  }),

  // ---- notifications, activity, audit ----
  notifications: () => call(() => state.notifications.filter((n) => n.to === user().id)),
  unread: () => state.notifications.filter((n) => n.to === user().id && !n.read).length,
  markAllRead: () => call(() => { state.notifications.forEach((n) => { if (n.to === user().id) n.read = true; }); save(); return true; }),
  audit: () => call(() => { enforce(user(), "audit.view", {}); return state.activity.map((a) => ({ ...a, byName: userName(a.by) })); }),
  clients: () => call(() => { enforce(user(), "clients.view", {}); return state.workspaces.map((w) => ({ ...w, plan: PLANS[w.plan]?.label,
    projects: state.projects.filter((p) => p.ws === w.id).length, people: state.users.filter((u) => u.workspaceIds?.includes(w.id)).map((u) => u.name) })); }),
  team: () => call(() => { enforce(user(), "team.view", {}); return state.users.filter((u) => u.role !== "client").map((u) => ({ ...u,
    assigned: state.projects.filter((p) => p.editorIds.includes(u.id)).map((p) => p.name) })); }),

  // ---- AI Visibility (FICTIONAL DEMO DATA, entitlement-gated) ----
  visibility: (ws, module, weeks = 12) => call(() => {
    const w = state.workspaces.find((x) => x.id === ws);
    enforce(user(), "visibility.view", { ws, plan: w?.plan, module });
    return { plan: w.plan, planLabel: PLANS[w.plan]?.label, data: visibilityFixtures(ws, weeks) };
  }),
  entitled: (ws, module) => { const w = state.workspaces.find((x) => x.id === ws); return can(user(), "visibility.view", { ws, plan: w?.plan, module }); },

  // ---- universal search ----
  search: (q) => call(() => {
    const needle = String(q || "").trim().toLowerCase(); if (!needle) return [];
    const u = user(), hit = (s) => String(s).toLowerCase().includes(needle), out = [];
    visibleProjects(u).forEach((p) => { if (hit(p.name) || hit(p.brief)) out.push({ type: "Project", title: p.name, sub: p.status, link: `project-${p.id}` }); });
    state.videos.filter((v) => canViewProject(u, project(v.projectId)) && (hit(v.title) || hit(v.instructions.brief)))
      .forEach((v) => out.push({ type: "Video", title: v.title, sub: `Editing Room · ${project(v.projectId)?.name}`, link: `video-${v.id}` }));
    state.assets.filter((a) => canViewAsset(u, a, project(a.projectId)) && (hit(a.name) || a.tags.some(hit)))
      .forEach((a) => out.push({ type: "Media", title: a.name, sub: project(a.projectId)?.name || "Workspace library", link: a.videoId ? `video-${a.videoId}` : `asset-${a.id}` }));
    state.reviews.filter((r) => canViewProject(u, project(r.projectId)) && r.comments.some((c) => hit(c.body)))
      .forEach((r) => out.push({ type: "Review", title: `Comment in ${r.title}`, sub: r.status, link: `review-${r.id}` }));
    state.lessons.filter((l) => hit(l.title) || hit(l.track)).forEach((l) => out.push({ type: "Tutorial", title: l.title, sub: l.track, link: `lesson-${l.id}` }));
    return out.slice(0, 30);
  }),

  // ---- Ask Cue proposals (approval-first) ----
  proposals: () => call(() => state.proposals.filter((p) => p.by === user().id)),
  propose: (kind, payload, summary) => call(() => {
    const p = { id: id("pr"), kind, payload, summary, status: "Waiting for you", by: user().id, at: now() };
    state.proposals.unshift(p); save(); return p;
  }),
  decideProposal: async (pid, approve) => {
    const p = state.proposals.find((x) => x.id === pid && x.by === user().id);
    if (!p || p.status !== "Waiting for you") { const e = new Error("That suggestion was already handled."); e.code = 409; throw e; }
    if (!approve) { p.status = "Declined"; save(); return clone(p); }
    p.status = "Working"; // a second tap while the first approval runs can't run it twice
    try {
    // Approval runs the same authorized service call a person would make; a denied action stays unexecuted.
    if (p.kind === "request") await svc.createRequest(p.payload);
    else if (p.kind === "comment") await svc.addComment(p.payload.reviewId, p.payload);
    else if (p.kind === "folder") await svc.createFolder(p.payload.ws, p.payload.name);
    else if (p.kind === "changes") await svc.decide(p.payload.reviewId, "changes", p.payload.note);
    else if (p.kind === "post") await svc.savePost(p.payload);
    else if (p.kind === "feed") await svc.videoAction(p.payload.videoId, "feed", p.payload);
    else if (p.kind === "another") await svc.videoAction(p.payload.videoId, "another", p.payload);
    } catch (e) { p.status = "Waiting for you"; save(); throw e; }
    p.status = "Done"; save(); return clone(p);
  },
  chat: () => clone(state.chat[user().id] || []),
  saveChat: (msgs) => { state.chat[user().id] = msgs.slice(-40); save(); },
};

/* ---------------- Editing Room (videos, checklist, templates, contextual actions) ---------------- */
const video = (vid) => state.videos.find((v) => v.id === vid);
function videoCtx(v) { return { project: project(v.projectId), ws: v.ws, projects: state.projects }; }
const templateSafe = (text, v) => {
  // Templates must not carry client details: strip the workspace and project names, and any timecodes tied to footage.
  const w = state.workspaces.find((x) => x.id === v.ws), p = project(v.projectId);
  return String(text || "").split(w?.name || "\u0000").join("the client").split(p?.name || "\u0000").join("this project");
};
function roomStatus(v, r) {
  const req = state.requests.find((x) => x.id === v.requestId);
  if (r.status === "Approved") return "Approved";
  if (r.versions.length && r.status === "In review") return "Ready for review";
  if (req && /progress/i.test(req.status)) return "Being edited"; // includes reworking requested changes
  if (r.status === "Changes requested") return "Changes requested";
  if (req && /revision/i.test(req.status)) return "Being edited";
  return r.versions.length ? "Ready for review" : "Waiting to start";
}
function capabilities(v) {
  const u = user(), c = videoCtx(v), all = ["review.comment", "review.decide", "review.assign", "review.upload_version", "checklist.update", "checklist.comment",
    "template.create", "video.share", "video.feed", "video.library", "video.another", "video.translate", "video.download"];
  return Object.fromEntries(all.map((a) => [a, can(u, a, c)]));
}

/* ---------------- Request lifecycle: every request gets its own Editing Room ---------------- */
const DEMO_CLIP = { short: "reel", captions: "reel", aspect: "reel", highlights: "podcast", podcast: "podcast" };
const DEFAULT_CHECKLIST = [
  ["Before editing", "Read the brief and watch all the footage"], ["Video and sound", "Assemble the cut"],
  ["Video and sound", "Clean and level the sound"], ["Captions and graphics", "Add captions and brand graphics"], ["Final checks", "Play every deliverable through"]];
const presetFor = (aspect = "") => /9:16/.test(aspect) ? "reels" : /1:1|4:5/.test(aspect) ? "li" : "yt";

/** opts.room: the upload-first room whose submitted brief this request carries (its video record takes the room's id). */
function newRequest(data, from, opts = {}) {
  const p = project(data.projectId);
  enforce(user(), "request.create", { project: p, ws: p?.ws });
  const key = data.key ? String(data.key).slice(0, 80) : null;
  const dup = key && state.requests.find((x) => x.key === key && x.by === user().id);
  if (dup) return dup;
  const title = String(data.title || "").trim().slice(0, 120), brief = String(data.brief || "").trim().slice(0, 4000);
  if (!title || !brief) { const e = new Error("Add a title and a brief so the editor knows what to make."); e.code = 400; throw e; }
  // Footage must be media this person can see, in the same workspace.
  const footage = (data.assetIds || []).map((aid) => state.assets.find((a) => a.id === aid)).filter((a) => a && a.ws === p.ws && canViewAsset(user(), a, project(a.projectId)));
  if ((data.assetIds || []).length !== footage.length) { const e = new Error("Some of the chosen footage isn't available to this project."); e.code = 400; throw e; }
  const tpl = data.templateId ? state.templates.find((t) => t.id === data.templateId && t.ws === p.ws) : null;
  const r = { id: id("r"), key, ws: p.ws, projectId: p.id, type: data.type || "short", title, brief, aspect: data.aspect || "", length: String(data.length || "").slice(0, 40),
    due: data.due || "", dueRev: 0, dueHistory: [], assigneeId: null, by: user().id, at: now(), status: "Submitted", assetIds: footage.map((a) => a.id), templateId: tpl?.id || null };
  state.requests.unshift(r);
  // Its Editing Room: instructions from the brief (and template or source video), checklist from the template or defaults.
  const src = from?.instructions || {}, ti = tpl?.instructions || {};
  const lead = footage.find((a) => a.media && MEDIA[a.media]);
  const rv = { id: id("rv"), ws: p.ws, projectId: p.id, requestId: r.id, title, status: "Waiting to start", versions: [], comments: [], rounds: [], extraRounds: [], extraAsks: [],
    audit: [{ at: now(), by: user().id, action: "Requested this video" }] };
  const v = { id: opts.room ? opts.room.id : id("v"), ws: p.ws, projectId: p.id, reviewId: rv.id, requestId: r.id, title, editorId: null,
    original: { media: lead?.media || from?.media || null, label: lead ? `${lead.name} (original)` : from?.media ? "Approved video it builds on" : "No footage attached yet" },
    instructions: { brief, brand: tpl?.brand?.length ? [...tpl.brand] : [...(src.brand || [])],
      deliverables: tpl?.outputs?.length ? tpl.outputs.map((o) => ({ label: o === "reels" ? "Vertical cut" : o === "li" ? "Square cut" : "Main edit", preset: o }))
        : [{ label: `${title} (${r.aspect || "16:9"})`, preset: presetFor(r.aspect) }],
      visual: ti.visual || src.visual || "", audio: ti.audio || src.audio || "", captions: ti.captions || src.captions || "" },
    checklist: (tpl?.checklist?.length ? tpl.checklist.map((t) => [t.section, t.text]) : DEFAULT_CHECKLIST)
      .map(([section, text], i) => ({ id: `t${i + 1}`, section, text, owner: null, done: false, src: "", out: "", notes: [] })),
    history: [{ at: now(), by: user().id, action: from ? `Requested from “${from.title}”` : tpl ? `Requested from the template “${tpl.name}”` : "Requested this video" },
      ...footage.map((a) => ({ at: now(), by: user().id, action: `Attached footage: ${a.name}` }))] };
  state.reviews.push(rv); state.videos.push(v); r.videoId = v.id;
  linkRoom(r, v, rv, opts.room);
  log("Submitted editing request", title, p.ws, p.id);
  admins().forEach((a) => notify(a, `New editing request: ${title} (needs an editor)`, "studio-board"));
  save(); return r;
}

/* ---------------- Upload-first rooms (Phase 1: data model; no new screens yet) ---------------- */
const room = (rid) => state.rooms.find((x) => x.id === rid);
const briefOf = (rm) => state.briefs.find((b) => b.id === rm.briefId);
const roomCtx = (rm) => ({ project: project(rm.projectId), ws: rm.ws, room: rm, projects: state.projects });
const notFound = (what) => { const e = new Error(`That ${what} doesn't exist.`); e.code = 404; return e; };
const badRequest = (m) => { const e = new Error(m); e.code = 400; return e; };
function stageOf(rm) {
  const request = state.requests.find((x) => x.id === rm.requestId), review = state.reviews.find((x) => x.id === rm.reviewId);
  return roomStage(rm, { brief: briefOf(rm), request, review, hasNotes: state.notes.some((n) => n.roomId === rm.id) });
}
function roomEvent(rm, action, detail) { rm.history.push({ at: now(), by: user().id, action, ...(detail ? { detail } : {}) }); }
function makeSnapshot(b, source) {
  // The submitted brief, frozen with the briefing notes it included. Nothing in the service ever edits a snapshot.
  const noteIds = state.notes.filter((n) => n.roomId === b.roomId && n.phase === "brief").map((n) => n.id);
  const snap = { id: id("bs"), briefId: b.id, roomId: b.roomId, ws: b.ws, rev: b.rev, fields: clone(b.fields), noteIds, by: user().id, at: now(), source };
  snap.hash = fingerprint(snapshotBody(snap));
  state.briefSnapshots.push(snap); b.snapshotIds = [...(b.snapshotIds || []), snap.id];
  return snap;
}
function newRoom({ p, title, assetIds, uploadOpId, briefFields, status = "draft" }) {
  const rid = id("v"), b = { id: id("b"), roomId: rid, ws: p.ws, status, rev: 0, fields: briefFields || emptyFields(title),
    updatedAt: now(), updatedBy: user().id, editLog: [], snapshotIds: [] };
  const rm = { id: rid, ws: p.ws, projectId: p.id, title: String(title).slice(0, 120), createdBy: user().id, createdAt: now(), uploadOpId: uploadOpId || null,
    sourceAssetIds: [...assetIds], mainAssetId: assetIds[0] || null, briefId: b.id, requestId: null, reviewId: null, completedAt: null, completedBy: null, rev: 0, history: [] };
  state.briefs.push(b); state.rooms.push(rm);
  return rm;
}
/** Links a request to its room. Request-first submissions get a room, a brief and its snapshot in the same step. */
function linkRoom(r, v, rv, rm) {
  if (!rm) {
    const fields = fieldsFromRequest(r, v.instructions);
    fields.requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(r.due || "") ? r.due : null;
    rm = newRoom({ p: project(r.projectId), title: r.title, assetIds: r.assetIds, briefFields: fields, status: "submitted" });
    state.rooms.pop(); rm.id = v.id; state.rooms.push(rm); // the room takes the Editing Room's id, so every link stays the same
    const b = briefOf(rm); b.roomId = rm.id; b.rev = 1;
    b.editLog.push({ at: now(), by: user().id, rev: 1, field: "*", from: null, to: null, note: "Submitted with the request form" });
    makeSnapshot(b, "request-form");
    roomEvent(rm, "Room created with an editing request");
  }
  const b = briefOf(rm), snap = state.briefSnapshots.find((x) => x.id === b.snapshotIds[b.snapshotIds.length - 1]);
  rm.requestId = r.id; rm.reviewId = rv.id;
  Object.assign(r, { roomId: rm.id, briefId: b.id, briefRev: snap.rev, snapshotId: snap.id, requestedDate: snap.fields.requestedDate ?? null });
}
function roomOut(rm) {
  const b = briefOf(rm), request = state.requests.find((x) => x.id === rm.requestId), review = state.reviews.find((x) => x.id === rm.reviewId);
  const notes = state.notes.filter((n) => n.roomId === rm.id);
  // Comments made in the existing Editing Room are part of the same instruction record, with their phase.
  const legacy = (review?.comments || []).map((c) => ({ id: c.id, roomId: rm.id, phase: c.phase || "revision", kind: c.shape ? "drawing" : "text", version: c.version,
    t: c.t, shapes: c.shape ? [c.shape] : [], body: c.body, voice: null, by: c.by, at: c.at, status: c.resolved ? "resolved" : "open", source: "comment" }));
  return { ...rm, stage: stageOf(rm), projectName: project(rm.projectId)?.name, byName: userName(rm.createdBy),
    brief: b ? { ...b, missing: briefMissing(b.fields) } : null,
    snapshots: state.briefSnapshots.filter((x) => x.roomId === rm.id).map((x) => ({ ...x, intact: snapshotIntact(x) })),
    instructions: [...notes.map((n) => ({ ...n, source: "note" })), ...legacy].map((n) => ({ ...n, byName: userName(n.by) }))
      .sort((a, b2) => (a.version - b2.version) || (a.t - b2.t) || a.at.localeCompare(b2.at)),
    request: request ? { id: request.id, status: request.status, key: request.key, requestedDate: request.requestedDate ?? null, estimate: request.due || null } : null,
    revisions: review ? allowanceOf(review) : null,
    assets: rm.sourceAssetIds.map((aid) => state.assets.find((a) => a.id === aid)).filter(Boolean).map(withMedia) };
}
function roomFor(rid, action) {
  const rm = room(rid); if (!rm) throw notFound("Editing Room");
  enforce(user(), "room.view", roomCtx(rm)); if (action) enforce(user(), action, roomCtx(rm));
  return rm;
}
function needRev(x, expectedRev, what) {
  if (expectedRev == null || !Number.isInteger(Number(expectedRev))) throw badRequest(`Send the ${what} revision you were editing (expectedRev).`);
  if (x.rev !== Number(expectedRev)) throw conflict(`This ${what} changed since you opened it (now revision ${x.rev}). Refresh to see the latest before saving again.`, "stale");
}

Object.assign(svc, {
  /** Where demo data is being saved. When browser storage fails, work continues in memory and this says so. */
  persistence: () => ({ ...persistence, message: persistence.ok ? "Saved in this browser (demo data, not uploaded)."
    : persistence.reason === "quota" ? "This browser's storage is full: changes are kept only until you close this tab."
    : "This browser blocks storage: changes are kept only until you close this tab." }),
  rooms: ({ ws, projectId } = {}) => call(() => state.rooms.filter((rm) => (!ws || rm.ws === ws) && (!projectId || rm.projectId === projectId)
    && can(user(), "room.view", roomCtx(rm))).map(roomOut)),
  room: (rid) => call(() => roomOut(roomFor(rid))),
  roomStage: (rid) => call(() => stageOf(roomFor(rid))),
  /**
   * Upload-first: adds a file and opens its Editing Room (or adds it to an existing room with roomId). Idempotent per
   * upload operation: a retry with the same opId returns the same file and room. Rooms are never merged because two
   * files look alike: the same name, size or content in another project or workspace is a separate upload and room.
   */
  registerUpload: ({ opId, projectId, roomId, folderId, file, title } = {}) => call(() => {
    if (!UPLOAD_OP.test(String(opId || ""))) throw badRequest("Each upload needs its own operation id (8–80 letters, digits, - or _).");
    const p = project(projectId); if (!p) throw notFound("project");
    enforce(user(), "asset.upload", { ws: p.ws, project: p }); enforce(user(), "room.create", { ws: p.ws, project: p });
    const f = { name: String(file?.name || "").slice(0, 200), size: Number(file?.size) || 0, type: String(file?.type || "") };
    const prior = state.uploadOps.find((o) => o.opId === opId && o.by === user().id);
    if (prior) {
      const same = prior.projectId === p.id && prior.name === f.name && prior.size === f.size && (prior.roomTarget || null) === (roomId || null);
      if (!same) throw conflict("This upload id was already used for a different file or project. Start a new upload.", "op-reused");
      return { replayed: true, asset: withMedia(state.assets.find((a) => a.id === prior.assetId)), room: roomOut(room(prior.roomId)) };
    }
    if (!f.name) throw badRequest("The file needs a name.");
    const okTypes = /^(video|audio|image)\//.test(f.type) || /\.(pdf|docx?|txt|srt|vtt|zip)$/i.test(f.name);
    if (!okTypes) { const e = new Error(`${f.name}: that file type isn't accepted. Use video, audio, image or document files.`); e.code = 415; throw e; }
    if (f.size > 20 * 1024 ** 3) { const e = new Error(`${f.name} is over the 20 GB limit.`); e.code = 413; throw e; }
    const target = roomId ? room(roomId) : null;
    if (roomId) {
      if (!target) throw notFound("Editing Room");
      enforce(user(), "brief.edit", roomCtx(target));
      if (target.projectId !== p.id) throw badRequest("Add the file to a room in the same project.");
    }
    if (folderId && !state.folders.some((x) => x.id === folderId && x.ws === p.ws)) throw badRequest("Pick a folder in the same workspace.");
    const kind = f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : f.type.startsWith("image/") ? "image" : "document";
    const a = { id: id("a"), ws: p.ws, projectId: p.id, folderId: folderId || null, name: f.name, kind, size: f.size, tags: ["new"], by: user().id, at: now(),
      channel: false, localUrl: Boolean(file?.url), storage: file?.url ? "session" : "none", uploadOpId: opId, roomId: null };
    if (file?.url) localMedia.set(a.id, file.url);
    state.assets.push(a);
    const rm = target || newRoom({ p, title: String(title || f.name.replace(/\.[^.]+$/, "")).trim() || "Untitled video", assetIds: [], uploadOpId: opId });
    rm.sourceAssetIds.push(a.id); rm.mainAssetId = rm.mainAssetId || a.id; a.roomId = rm.id;
    state.uploadOps.push({ opId, by: user().id, ws: p.ws, projectId: p.id, roomTarget: roomId || null, name: f.name, size: f.size, assetId: a.id, roomId: rm.id, at: now() });
    roomEvent(rm, target ? `Added file: ${f.name}` : "Room opened on upload", "Simulated upload: nothing left this device");
    log(target ? "Added a file to an Editing Room (simulated upload)" : "Uploaded a file and opened its Editing Room (simulated upload)", f.name, p.ws, p.id);
    state.feed.unshift({ id: id("fd"), ws: p.ws, kind: "upload", by: user().id, at: now(), text: `Added ${f.name}.`, assetId: a.id, comments: [], saves: [] });
    save(); return { replayed: false, asset: withMedia(a), room: roomOut(rm) };
  }),
  /** Updates draft brief fields. expectedRev is required: a save from an older screen gets 409 instead of overwriting. */
  saveBrief: (rid, patch, expectedRev) => call(() => {
    const rm = roomFor(rid, "brief.edit"), b = briefOf(rm);
    if (b.status === "submitted") throw conflict("This brief was submitted and is now the original instructions. Add a change note instead.", "submitted");
    needRev(b, expectedRev, "brief");
    const clean = sanitizeBriefPatch(patch), changed = Object.keys(clean).filter((k) => JSON.stringify(b.fields[k]) !== JSON.stringify(clean[k]));
    if (!changed.length) return { ...b, missing: briefMissing(b.fields) };
    b.rev += 1;
    changed.forEach((k) => b.editLog.push({ at: now(), by: user().id, rev: b.rev, field: k, from: b.fields[k], to: clean[k] }));
    Object.assign(b.fields, clean); b.updatedAt = now(); b.updatedBy = user().id;
    if (clean.title) rm.title = clean.title;
    if (b.status === "ready" && briefMissing(b.fields).length) { b.status = "draft"; roomEvent(rm, "Brief back to draft: a required detail was removed"); }
    roomEvent(rm, "Updated the brief", changed.join(", ")); save(); return { ...b, missing: briefMissing(b.fields) };
  }),
  markBriefReady: (rid, expectedRev) => call(() => {
    const rm = roomFor(rid, "brief.edit"), b = briefOf(rm);
    if (b.status !== "draft") throw conflict(b.status === "ready" ? "This brief is already marked ready." : "This brief was already submitted.");
    needRev(b, expectedRev, "brief");
    const missing = briefMissing(b.fields);
    if (missing.length) { const e = badRequest(`Add these before marking it ready: ${missing.join(", ")}.`); e.missing = missing; throw e; }
    b.status = "ready"; b.rev += 1; b.editLog.push({ at: now(), by: user().id, rev: b.rev, field: "status", from: "draft", to: "ready" });
    roomEvent(rm, "Marked the brief ready to submit"); save(); return { ...b, missing: [] };
  }),
  /**
   * Submits the ready brief: freezes it as an immutable snapshot and creates the editing request (with its review and
   * production record under the room's id). Idempotent by key briefId:rev: a double tap, retry or second tab returns the
   * first request.
   */
  submitBrief: (rid, { expectedRev, key, type } = {}) => call(() => {
    const rm = roomFor(rid, "room.submit"), b = briefOf(rm);
    const k = key ? String(key) : `${b.id}:${expectedRev}`;
    if (k !== `${b.id}:${expectedRev}`) throw badRequest("The submission key must be the brief id and revision.");
    const existing = state.requests.find((x) => x.key === k && x.roomId === rm.id);
    if (existing) return { replayed: true, request: existing };
    if (b.status === "submitted") throw conflict("This brief was already submitted from a newer revision. Refresh to see it.", "stale");
    if (b.status !== "ready") { const e = conflict("Mark the brief ready before submitting it.", "not-ready"); e.missing = briefMissing(b.fields); throw e; }
    needRev(b, expectedRev, "brief");
    const f = b.fields, kind = type || (f.aspects.includes("9:16") && f.aspects.length === 1 ? "short" : "long");
    b.status = "submitted"; b.updatedAt = now(); b.updatedBy = user().id;
    b.editLog.push({ at: now(), by: user().id, rev: b.rev, field: "status", from: "ready", to: "submitted" });
    makeSnapshot(b, "submitted");
    state.notes.filter((n) => n.roomId === rm.id && n.phase === "brief" && n.status === "draft").forEach((n) => { n.status = "included"; });
    const r = newRequest({ projectId: rm.projectId, key: k, type: kind, title: f.title, brief: [f.outcome, f.instructions].filter(Boolean).join("\n\n"),
      aspect: f.aspects.join(" + "), length: f.length, due: "", assetIds: rm.sourceAssetIds },
      { title: f.title, instructions: { brand: f.brand, visual: f.visual, audio: f.music, captions: f.captions } }, { room: rm });
    roomEvent(rm, "Submitted the editing request", `Brief revision ${b.rev}`);
    save(); return { replayed: false, request: r };
  }),
  /**
   * A timestamped instruction: text, a drawing (overlay shapes) or a voice note (metadata only; the audio stays on
   * this device). Notes never use a revision round, whatever their phase.
   */
  addNote: (rid, { kind = "text", t = 0, version = 0, shapes, body, voice, phase } = {}) => call(() => {
    const rm = roomFor(rid, "room.note"), review = state.reviews.find((x) => x.id === rm.reviewId);
    if (!NOTE_KINDS.includes(kind)) throw badRequest("A note is text, a drawing or a voice note.");
    const versions = review?.versions.length || 0, text = String(body || "").trim().slice(0, 2000);
    if (!Number.isInteger(Number(version)) || version < 0 || version > versions) throw badRequest("That version doesn't exist in this room.");
    const cleanShapes = kind === "drawing" ? validateShapes(shapes) : [];
    if (kind === "drawing" && !cleanShapes.length) throw badRequest("Draw at least one shape.");
    if (kind !== "voice" && !text) throw badRequest(kind === "drawing" ? "Describe what the drawing asks for, so everyone can follow it." : "Write the note first.");
    const b = briefOf(rm), ph = notePhase({ role: user().role, versions, requested: phase });
    const n = { id: id("nt"), roomId: rm.id, ws: rm.ws, phase: ph, kind, version: Number(version), t: Math.max(0, Number(t) || 0), shapes: cleanShapes, body: text,
      voice: kind === "voice" ? validateVoice(voice) : null, by: user().id, at: now(), status: b.status === "submitted" ? "open" : "draft",
      afterSubmission: b.status === "submitted", replies: [] };
    state.notes.push(n);
    roomEvent(rm, `Added a ${kind} note (${ph})`, `${fmtT(n.t)}${text ? `: ${text.slice(0, 60)}` : ""}`);
    if (n.afterSubmission) { // drafts stay private to the client side until the request is submitted
      const p = project(rm.projectId), to = user().role === "client" ? [...p.editorIds, ...admins()] : clientsOf(rm.ws);
      notifyAll(to, `${userName(user().id)} added ${ph === "question" ? "a question" : "an instruction"} at ${fmtT(n.t)} on ${rm.title}`, `video-${rm.id}`);
    }
    save(); return n;
  }),
  /** Deletes your own draft note (e.g. a voice note you re-recorded). Submitted instructions can't be deleted. */
  deleteNote: (rid, nid) => call(() => {
    const rm = roomFor(rid, "room.note"), n = state.notes.find((x) => x.id === nid && x.roomId === rm.id);
    if (!n) throw notFound("note");
    if (n.by !== user().id) { const e = new Error("Only the person who added a note can delete it."); e.code = 403; throw e; }
    if (n.status !== "draft") throw conflict("This note is part of the submitted instructions and stays on record.");
    state.notes = state.notes.filter((x) => x !== n); roomEvent(rm, `Deleted a draft ${n.kind} note`);
    save(); return { deleted: n.id, blobKey: n.voice?.blobKey || null }; // the caller removes the recording from this device
  }),
  /** Approved → Completed: an administrator records that the deliverables were handed over. */
  completeRoom: (rid) => call(() => {
    const rm = roomFor(rid, "room.complete"), review = state.reviews.find((x) => x.id === rm.reviewId);
    if (rm.completedAt) throw conflict("This room is already completed.");
    if (review?.status !== "Approved") throw conflict("Only an approved video can be marked completed.");
    rm.completedAt = now(); rm.completedBy = user().id; roomEvent(rm, "Marked completed (deliverables handed over)");
    log("Completed an Editing Room", rm.title, rm.ws, rm.projectId); save(); return roomOut(rm);
  }),
  /** Data checks an administrator (and the tests) can run: links, ownership, idempotency and snapshot integrity. */
  integrity: () => call(() => {
    enforce(user(), "audit.view", {});
    const issues = [], add = (m) => issues.push(m);
    state.rooms.forEach((rm) => {
      const p = project(rm.projectId);
      if (!p || p.ws !== rm.ws) add(`room ${rm.id}: workspace doesn't match its project`);
      if (!briefOf(rm)) add(`room ${rm.id}: brief missing`);
      rm.sourceAssetIds.forEach((aid) => { const a = state.assets.find((x) => x.id === aid); if (!a) add(`room ${rm.id}: file ${aid} missing`); else if (a.ws !== rm.ws) add(`room ${rm.id}: file ${aid} is in another workspace`); });
      if (rm.requestId && state.requests.find((r) => r.id === rm.requestId)?.roomId !== rm.id) add(`room ${rm.id}: request link broken`);
      if (rm.requestId && !state.videos.some((v) => v.id === rm.id)) add(`room ${rm.id}: production record missing`);
    });
    state.videos.forEach((v) => { if (!room(v.id)) add(`video ${v.id}: no room record`); });
    state.briefSnapshots.forEach((x) => { if (!snapshotIntact(x)) add(`snapshot ${x.id}: changed after submission`); });
    state.notes.forEach((n) => { if (room(n.roomId)?.ws !== n.ws) add(`note ${n.id}: workspace doesn't match its room`); });
    const ops = new Map(); state.uploadOps.forEach((o) => { const k = `${o.by}|${o.opId}`; if (ops.has(k)) add(`upload ${o.opId}: recorded twice`); ops.set(k, o); });
    state.assets.filter((a) => a.uploadOpId).forEach((a) => { if (state.rooms.filter((rm) => rm.uploadOpId === a.uploadOpId && rm.createdBy === a.by).length > 1) add(`upload ${a.uploadOpId}: more than one room`); });
    const keys = new Map(); state.requests.filter((r) => r.key).forEach((r) => { const k = `${r.by}|${r.key}`; if (keys.has(k)) add(`request key ${r.key}: duplicated`); keys.set(k, r); });
    return { ok: !issues.length, issues, rooms: state.rooms.length, migrations: clone(state.migrations || []) };
  }),
});

Object.assign(svc, {
  videos: ({ ws } = {}) => call(() => state.videos.filter((v) => (!ws || v.ws === ws) && canViewProject(user(), project(v.projectId))).map((v) => {
    const r = state.reviews.find((x) => x.id === v.reviewId), last = r.versions[r.versions.length - 1];
    return { id: v.id, title: v.title, ws: v.ws, projectId: v.projectId, projectName: project(v.projectId)?.name, status: roomStatus(v, r),
      editor: v.editorId ? userName(v.editorId) : null, poster: MEDIA[last?.media || v.original.media]?.poster || null, versions: r.versions.length,
      done: v.checklist.filter((t) => t.done).length, tasks: v.checklist.length, open: r.comments.filter((c) => !c.resolved).length };
  })),
  videoForAsset: (aid) => state.assets.find((a) => a.id === aid)?.videoId || null,
  videoForReview: (rid) => state.videos.find((v) => v.reviewId === rid)?.id || null,
  video: (vid) => call(() => {
    const v = video(vid);
    if (!v) { const e = new Error("That video doesn't exist."); e.code = 404; throw e; }
    enforce(user(), "project.view", videoCtx(v));
    const r = state.reviews.find((x) => x.id === v.reviewId), p = project(v.projectId);
    const versions = [{ n: 0, label: v.original.label, ...(MEDIA[v.original.media] || { src: null, poster: null, duration: 0 }), by: null, at: null,
      note: v.original.media ? "The footage as it was uploaded" : "No playable footage yet: the first edited version will appear here" },
      ...r.versions.map((x) => ({ ...x, label: `Version ${x.n}`, ...MEDIA[x.media], byName: userName(x.by) }))];
    const files = state.assets.filter((a) => a.ws === v.ws && (a.projectId === v.projectId || (!a.projectId && canViewAsset(user(), a, null)))).map(withMedia);
    const decisions = r.audit.filter((a) => /approved|requested changes/i.test(a.action)).map((a) => ({ ...a, byName: userName(a.by) }));
    return { ...v, status: roomStatus(v, r), reviewStatus: r.status, projectName: p.name, workspace: state.workspaces.find((w) => w.id === v.ws)?.name,
      editorName: v.editorId ? userName(v.editorId) : null, versions, files, decisions,
      request: (() => { const q = state.requests.find((x) => x.id === v.requestId); return q ? { id: q.id, status: q.status, assigneeId: q.assigneeId, due: q.due, dueRev: q.dueRev || 0, byName: userName(q.by), type: q.type,
        dueHistory: (q.dueHistory || []).map((x) => ({ ...x, byName: userName(x.by) })) } : null; })(),
      editors: user().role === "admin" ? state.users.filter((u) => u.role === "editor").map((u) => ({ id: u.id, name: u.name })) : [],
      comments: r.comments.map((c) => ({ ...c, byName: userName(c.by), assigneeName: c.assigneeId ? userName(c.assigneeId) : null,
        replies: c.replies.map((x) => ({ ...x, byName: userName(x.by) })) })),
      checklist: v.checklist.map((t) => ({ ...t, ownerName: t.owner ? userName(t.owner) : "Not assigned yet", doneByName: t.doneBy ? userName(t.doneBy) : null,
        notes: t.notes.map((n) => ({ ...n, byName: userName(n.by) })) })),
      activity: [...r.audit, ...v.history].map((a) => ({ ...a, byName: userName(a.by) })).sort((a, b) => b.at.localeCompare(a.at)),
      revisions: allowanceOf(r), revisionLimit: allowanceOf(r).total, revisionsUsed: allowanceOf(r).used,
      team: [...new Set([...p.editorIds, ...state.users.filter((u) => u.role === "admin").map((u) => u.id)])].map((id) => ({ id, name: userName(id) })),
      can: capabilities(v) };
  }),
  toggleTask: (vid, tid, done) => call(() => {
    const v = video(vid); enforce(user(), "checklist.update", videoCtx(v));
    const t = v.checklist.find((x) => x.id === tid); if (!t) { const e = new Error("That task doesn't exist."); e.code = 404; throw e; }
    t.done = Boolean(done); t.doneBy = done ? user().id : null; t.doneAt = done ? now() : null;
    v.history.push({ at: now(), by: user().id, action: `${done ? "Completed" : "Reopened"} task: ${t.text}` }); save(); return t;
  }),
  noteTask: (vid, tid, body) => call(() => {
    const v = video(vid); enforce(user(), "checklist.comment", videoCtx(v));
    const t = v.checklist.find((x) => x.id === tid), text = String(body || "").trim().slice(0, 1000);
    if (!t || !text) { const e = new Error("Write a note first."); e.code = 400; throw e; }
    t.notes.push({ by: user().id, body: text, at: now() }); v.history.push({ at: now(), by: user().id, action: `Commented on task: ${t.text}` }); save(); return t;
  }),
  assignComment: (rid, cid, uid) => call(() => {
    const r = state.reviews.find((x) => x.id === rid), p = project(r?.projectId);
    enforce(user(), "review.assign", { project: p, ws: p?.ws });
    const c = r.comments.find((x) => x.id === cid); if (!c) { const e = new Error("That comment doesn't exist."); e.code = 404; throw e; }
    c.assigneeId = uid || null; r.audit.push({ at: now(), by: user().id, action: uid ? `Assigned feedback to ${userName(uid)}` : "Unassigned feedback" });
    if (uid) notify(uid, `Feedback assigned to you on ${r.title}`, `video-${state.videos.find((v) => v.reviewId === rid)?.id}`);
    save(); return c;
  }),
  templates: (ws) => call(() => { enforce(user(), "template.view", { ws, projects: state.projects }); return state.templates.filter((t) => t.ws === ws).map((t) => ({ ...t, byName: userName(t.by) })); }),
  saveTemplate: (vid, { name, include }) => call(() => {
    const v = video(vid); enforce(user(), "template.create", videoCtx(v));
    const clean = String(name || "").trim().slice(0, 80);
    if (!clean) { const e = new Error("Name the template."); e.code = 400; throw e; }
    const inc = include || {};
    const t = { id: id("tpl"), ws: v.ws, name: clean, by: user().id, at: now(),
      instructions: inc.instructions ? { visual: templateSafe(v.instructions.visual, v), audio: templateSafe(v.instructions.audio, v), captions: templateSafe(v.instructions.captions, v) } : {},
      outputs: inc.outputs ? v.instructions.deliverables.map((d) => d.preset) : [],
      brand: inc.brand ? v.instructions.brand.map((b) => templateSafe(b, v)) : [],
      checklist: inc.checklist ? v.checklist.map((x) => ({ section: x.section, text: templateSafe(x.text, v) })) : [] };
    state.templates.unshift(t); v.history.push({ at: now(), by: user().id, action: `Made template “${clean}”` }); save(); return t;
  }),
  /** Contextual actions on a video. Everything here stays inside the preview; nothing is published or rendered. */
  videoAction: (vid, kind, opts = {}) => call(() => {
    const v = video(vid), c = videoCtx(v), r = state.reviews.find((x) => x.id === v.reviewId);
    const latest = r.versions[r.versions.length - 1];
    const latestAsset = state.assets.find((a) => a.videoId === v.id && a.media === latest?.media) || state.assets.find((a) => a.videoId === v.id);
    if (kind === "library") {
      enforce(user(), "video.library", c);
      if (r.status !== "Approved") { const e = new Error("Approve the video before adding it to the sharing library."); e.code = 409; throw e; }
      latestAsset.channel = true; v.history.push({ at: now(), by: user().id, action: "Added to the sharing library" }); save(); return { ok: true };
    }
    if (kind === "feed") {
      enforce(user(), "video.feed", c);
      state.feed.unshift({ id: id("fd"), ws: v.ws, kind: r.status === "Approved" ? "approved" : "deliverable", by: user().id, at: now(),
        text: String(opts.text || `${v.title} is in the workspace feed.`).slice(0, 500), assetId: latestAsset?.id, comments: [], saves: [] });
      v.history.push({ at: now(), by: user().id, action: "Added to the feed" }); save(); return { ok: true };
    }
    if (kind === "another" || kind === "translate") {
      enforce(user(), kind === "another" ? "video.another" : "video.translate", c);
      const lang = String(opts.language || "Spanish").slice(0, 40);
      const req = newRequest({ projectId: v.projectId, key: opts.key, type: kind === "another" ? (opts.type || "short") : "captions",
        title: String(opts.title || (kind === "another" ? `New version of ${v.title}` : `${lang} captions for ${v.title}`)).slice(0, 120),
        brief: kind === "another" ? String(opts.brief || `A new version of ${v.title}. Keep what worked; change: ${opts.change || "see notes"}.`)
          : `Translated ${lang} captions for ${v.title}. The preview can't translate; an editor or translator does this.`,
        aspect: opts.aspect || "9:16", length: opts.length || "", due: opts.due || "",
        assetIds: latestAsset && r.status === "Approved" ? [latestAsset.id] : [] }, { title: v.title, instructions: v.instructions, media: latest?.media });
      v.history.push({ at: now(), by: user().id, action: `Requested: ${req.title}` }); save(); return req;
    }
    const e = new Error("Unknown action"); e.code = 400; throw e;
  }),
  /** Where content stands, from completed video to social preparation. "Published" is always 0: the preview can't publish. */
  pipeline: (ws) => call(() => {
    enforce(user(), "feed.view", { ws, projects: state.projects });
    const vids = state.videos.filter((v) => v.ws === ws && canViewProject(user(), project(v.projectId)));
    const status = (v) => roomStatus(v, state.reviews.find((x) => x.id === v.reviewId));
    const approved = vids.filter((v) => status(v) === "Approved");
    const shareable = state.assets.filter((a) => a.ws === ws && a.channel && canViewAsset(user(), a, project(a.projectId)));
    const posts = state.posts.filter((p) => p.ws === ws);
    const reused = new Set(posts.map((p) => p.assetId));
    return { videos: vids.length, inProduction: vids.length - approved.length, approved: approved.length, shareable: shareable.length,
      repurposable: shareable.filter((a) => !reused.has(a.id)).length, drafts: posts.filter((p) => /^(draft|changes requested)$/i.test(p.status)).length,
      awaiting: posts.filter((p) => p.status === "Submitted").length, approvedPosts: posts.filter((p) => p.status === "Approved").length,
      ready: posts.filter((p) => p.status === "Prepared for publishing").length, published: 0 };
  }),
  announcements: () => call(() => state.announcements.filter((a) => !(state.dismissed[user().id] || []).includes(a.id))),
  dismiss: (aid) => call(() => { const me = user().id; state.dismissed[me] = [...new Set([...(state.dismissed[me] || []), aid])]; save(); return true; }),
  /** The approved spotlight whose 14-day window contains today (entries are scheduled 14 days apart). */
  spotlight: (today = new Date()) => call(() => {
    const day = 24 * 3600e3, t = today.getTime();
    const live = state.spotlights.filter((x) => x.approved && new Date(x.start).getTime() <= t && t < new Date(x.start).getTime() + 14 * day)
      .sort((a, b) => b.start.localeCompare(a.start))[0];
    if (!live) return null;
    const until = new Date(new Date(live.start).getTime() + 14 * day).toISOString().slice(0, 10);
    const next = state.spotlights.filter((x) => x.approved && x.start > live.start).sort((a, b) => a.start.localeCompare(b.start))[0];
    return { ...live, until, next: next ? { title: next.title, start: next.start } : null };
  }),
  uploaders: (ws) => call(() => [...new Set(state.assets.filter((a) => a.ws === ws && canViewAsset(user(), a, project(a.projectId))).map((a) => a.by))]
    .map((uid) => ({ id: uid, name: userName(uid) }))),
});

export function fmtT(t) { const s = Math.max(0, t || 0); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; }
export { Denied };
