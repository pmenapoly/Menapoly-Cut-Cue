// Mock service layer for the preview. It stands where the real API will stand: every call checks policy.js,
// writes an audit entry and returns copies. Data lives in this browser only (localStorage), seeded with fictional
// fixtures. There is deliberately no fetch/XHR/WebSocket anywhere in the preview.
import { seed, visibilityFixtures, MEDIA } from "./data.js";
import { can, enforce, canViewProject, canViewAsset, canViewWorkspace, Denied, PLANS } from "./policy.js";

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
    if (raw) { const s = JSON.parse(raw); if (s?.version === seed().version) return s; }
  } catch { /* storage blocked: run in memory */ }
  return seed();
}
let state = load();
let session = (() => { try { return JSON.parse(sessionStorage.getItem(SESSION) || localStorage.getItem(SESSION) || "null"); } catch { return null; } })()
  || { userId: "u_jordan", ws: null };
const flags = { failRequests: false, latency: true };

function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* in-memory only */ } }
function saveSession() { try { localStorage.setItem(SESSION, JSON.stringify(session)); } catch { /* ignore */ } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(fn) {
  if (flags.latency) await sleep(120 + Math.random() * 160);
  if (flags.failRequests) { const e = new Error("The demo service is simulating an outage. Turn it off in Settings → Preview tools."); e.code = 503; throw e; }
  return clone(fn());
}

const user = () => state.users.find((u) => u.id === session.userId) || state.users[0];
const project = (pid) => state.projects.find((p) => p.id === pid);
const userName = (uid) => state.users.find((u) => u.id === uid)?.name || "Someone";
function log(action, detail, ws, pid) {
  state.activity.unshift({ id: id("act"), at: now(), by: user().id, action, detail, ws, pid: pid || null });
  state.activity = state.activity.slice(0, 200);
}
function notify(to, text, link) { if (to && to !== user().id) state.notifications.unshift({ id: id("n"), to, at: now(), text, link, read: false }); }
const admins = () => state.users.filter((u) => u.role === "admin").map((u) => u.id);
const clientsOf = (ws) => state.users.filter((u) => u.role === "client" && (u.workspaceIds || []).includes(ws)).map((u) => u.id);
const roomLink = (rid) => { const v = state.videos.find((x) => x.reviewId === rid); return v ? `video-${v.id}` : `review-${rid}`; };
function conflict(message) { const e = new Error(message); e.code = 409; return e; }
function visibleProjects(u = user()) { return state.projects.filter((p) => canViewProject(u, p)); }
function assetCtx(a) { return { resource: a, project: a.projectId ? project(a.projectId) : null, ws: a.ws }; }
function mediaFor(a) {
  if (a.localUrl && localMedia.has(a.id)) return { src: localMedia.get(a.id), poster: null, local: true };
  return a.media ? MEDIA[a.media] : null;
}
const withMedia = (a) => ({ ...a, mediaInfo: mediaFor(a), projectName: project(a.projectId)?.name, byName: userName(a.by) });

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
    const today = new Date().toISOString().slice(0, 10);
    const rows = state.requests.filter((r) => canViewProject(u, project(r.projectId)) && (u.role === "admin" || r.assigneeId === u.id)).map((r) => {
      const v = state.videos.find((x) => x.requestId === r.id), rv = v && state.reviews.find((x) => x.id === v.reviewId);
      return { ...r, projectName: project(r.projectId)?.name, workspace: state.workspaces.find((w) => w.id === r.ws)?.name, assignee: r.assigneeId ? userName(r.assigneeId) : null,
        byName: userName(r.by), videoId: v?.id || null, stage: v ? roomStatus(v, rv) : r.status, overdue: Boolean(r.due && r.due < today && !/approved/i.test(r.status)),
        versions: rv?.versions.length || 0, open: rv ? rv.comments.filter((c) => !c.resolved).length : 0,
        tasks: v ? v.checklist.length : 0, done: v ? v.checklist.filter((t) => t.done).length : 0 };
    }).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    const editors = u.role === "admin" ? state.users.filter((x) => x.role === "editor").map((ed) => {
      const mine = rows.filter((r) => r.assigneeId === ed.id && !/approved/i.test(r.status));
      return { id: ed.id, name: ed.name, title: ed.title, open: mine.length, overdue: mine.filter((r) => r.overdue).length, next: mine[0]?.due || null };
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
    return { ...r, projectName: p.name, revisionLimit: p.revisionLimit, revisionsUsed: req?.revisionsUsed ?? 0,
      versions: r.versions.map((v) => ({ ...v, ...MEDIA[v.media], byName: userName(v.by) })),
      comments: r.comments.map((c) => ({ ...c, byName: userName(c.by), replies: c.replies.map((x) => ({ ...x, byName: userName(x.by) })) })),
      audit: r.audit.map((a) => ({ ...a, byName: userName(a.by) })) };
  }),
  addComment: (rid, { version, t, shape, body }) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "review.comment", { project: p });
    const text = String(body || "").trim().slice(0, 2000);
    if (!text) { const e = new Error("Write what should change before sending."); e.code = 400; throw e; }
    const c = { id: id("c"), version, t: Math.max(0, Number(t) || 0), shape: shape || null, body: text, by: user().id, at: now(), resolved: false, replies: [] };
    r.comments.push(c); r.audit.push({ at: now(), by: user().id, action: `Commented at ${fmtT(c.t)}`, detail: text.slice(0, 80) });
    // The other side hears about it: client feedback reaches the editing team, editor notes reach the client.
    const to = user().role === "client" ? [...p.editorIds, ...admins()] : clientsOf(p.ws);
    to.forEach((uid) => notify(uid, `${userName(user().id)} left feedback at ${fmtT(c.t)} on ${r.title}`, roomLink(r.id)));
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
      if (req && req.revisionsUsed >= p.revisionLimit) { const e = new Error(`This project's ${p.revisionLimit} included revisions are used. Ask your producer about an extra round.`); e.code = 409; throw e; }
      r.status = "Changes requested"; if (req) { req.status = "Revision"; req.revisionsUsed += 1; }
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
      [...p.editorIds, ...admins()].forEach((e) => notify(e, `${r.title} was approved (version ${r.versions.length})`, roomLink(r.id)));
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
      .map((p) => ({ ...p, asset: withMedia(state.assets.find((a) => a.id === p.assetId)), byName: userName(p.by) }));
  }),
  savePost: (data) => call(() => {
    const a = state.assets.find((x) => x.id === data.assetId);
    enforce(user(), "post.create", { ws: a?.ws });
    if (!a?.channel) { const e = new Error("Only approved media can be shared. Approve it in Review first."); e.code = 409; throw e; }
    if (!data.platforms?.length) { const e = new Error("Pick at least one channel."); e.code = 400; throw e; }
    let p = data.id && state.posts.find((x) => x.id === data.id);
    if (!p) { p = { id: id("s"), ws: a.ws, assetId: a.id, status: "Draft", by: user().id, at: now(), history: [] }; state.posts.unshift(p); }
    Object.assign(p, { captions: data.captions || {}, platforms: data.platforms, scheduledFor: data.scheduledFor || null });
    p.history.push({ at: now(), by: user().id, action: "Saved draft" }); log("Saved social draft", a.name, a.ws); save(); return p;
  }),
  submitPost: (pid) => call(() => {
    const p = state.posts.find((x) => x.id === pid); enforce(user(), "post.edit", { ws: p?.ws });
    p.status = "Awaiting approval"; p.history.push({ at: now(), by: user().id, action: "Sent for approval" }); save(); return p;
  }),
  approvePost: (pid) => call(() => {
    const p = state.posts.find((x) => x.id === pid); enforce(user(), "post.approve", { ws: p?.ws });
    p.status = "Approved"; p.history.push({ at: now(), by: user().id, action: "Approved" }); save(); return p;
  }),
  /** Preparation only: nothing is connected to any social network in the preview. */
  schedulePost: (pid) => call(() => {
    const p = state.posts.find((x) => x.id === pid); enforce(user(), "post.schedule", { ws: p?.ws });
    if (p.status !== "Approved") { const e = new Error("Approve the post before preparing it for scheduling."); e.code = 409; throw e; }
    p.status = "Ready to schedule (simulated)"; p.history.push({ at: now(), by: user().id, action: "Prepared for scheduling (simulated, nothing posted)" }); save(); return p;
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

function newRequest(data, from) {
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
    due: data.due || "", assigneeId: null, by: user().id, at: now(), status: "Submitted", revisionsUsed: 0, assetIds: footage.map((a) => a.id), templateId: tpl?.id || null };
  state.requests.unshift(r);
  // Its Editing Room: instructions from the brief (and template or source video), checklist from the template or defaults.
  const src = from?.instructions || {}, ti = tpl?.instructions || {};
  const lead = footage.find((a) => a.media && MEDIA[a.media]);
  const rv = { id: id("rv"), ws: p.ws, projectId: p.id, requestId: r.id, title, status: "Waiting to start", versions: [], comments: [],
    audit: [{ at: now(), by: user().id, action: "Requested this video" }] };
  const v = { id: id("v"), ws: p.ws, projectId: p.id, reviewId: rv.id, requestId: r.id, title, editorId: null,
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
  log("Submitted editing request", title, p.ws, p.id);
  admins().forEach((a) => notify(a, `New editing request: ${title} (needs an editor)`, "studio-board"));
  save(); return r;
}

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
      request: (() => { const q = state.requests.find((x) => x.id === v.requestId); return q ? { id: q.id, status: q.status, assigneeId: q.assigneeId, due: q.due, byName: userName(q.by), type: q.type } : null; })(),
      editors: user().role === "admin" ? state.users.filter((u) => u.role === "editor").map((u) => ({ id: u.id, name: u.name })) : [],
      comments: r.comments.map((c) => ({ ...c, byName: userName(c.by), assigneeName: c.assigneeId ? userName(c.assigneeId) : null,
        replies: c.replies.map((x) => ({ ...x, byName: userName(x.by) })) })),
      checklist: v.checklist.map((t) => ({ ...t, ownerName: t.owner ? userName(t.owner) : "Not assigned yet", doneByName: t.doneBy ? userName(t.doneBy) : null,
        notes: t.notes.map((n) => ({ ...n, byName: userName(n.by) })) })),
      activity: [...r.audit, ...v.history].map((a) => ({ ...a, byName: userName(a.by) })).sort((a, b) => b.at.localeCompare(a.at)),
      revisionLimit: p.revisionLimit, revisionsUsed: state.requests.find((x) => x.id === v.requestId)?.revisionsUsed ?? 0,
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
      repurposable: shareable.filter((a) => !reused.has(a.id)).length, drafts: posts.filter((p) => p.status === "Draft").length,
      awaiting: posts.filter((p) => p.status === "Awaiting approval").length, approvedPosts: posts.filter((p) => p.status === "Approved").length,
      ready: posts.filter((p) => /ready to schedule/i.test(p.status)).length, published: 0 };
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
