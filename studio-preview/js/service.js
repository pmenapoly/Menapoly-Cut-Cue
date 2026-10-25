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
function log(action, detail, ws) {
  state.activity.unshift({ id: id("act"), at: now(), by: user().id, action, detail, ws });
  state.activity = state.activity.slice(0, 200);
}
function notify(to, text, link) { state.notifications.unshift({ id: id("n"), to, at: now(), text, link, read: false }); }
function visibleProjects(u = user()) { return state.projects.filter((p) => canViewProject(u, p)); }
function assetCtx(a) { return { resource: a, project: a.projectId ? project(a.projectId) : null, ws: a.ws }; }
function mediaFor(a) {
  if (a.localUrl && localMedia.has(a.id)) return { src: localMedia.get(a.id), poster: null, local: true };
  return a.media ? MEDIA[a.media] : null;
}
const withMedia = (a) => ({ ...a, mediaInfo: mediaFor(a), projectName: project(a.projectId)?.name, byName: userName(a.by) });

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
      requests: state.requests.filter((r) => r.projectId === pid), reviews: state.reviews.filter((r) => r.projectId === pid),
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
    .map((r) => ({ ...r, projectName: project(r.projectId)?.name, assignee: r.assigneeId ? userName(r.assigneeId) : null, byName: userName(r.by) }))
    .sort((a, b) => b.at.localeCompare(a.at))),
  createRequest: (data) => call(() => {
    const p = project(data.projectId);
    enforce(user(), "request.create", { project: p, ws: p?.ws });
    const title = String(data.title || "").trim().slice(0, 120), brief = String(data.brief || "").trim().slice(0, 4000);
    if (!title || !brief) { const e = new Error("Add a title and a brief so the editor knows what to make."); e.code = 400; throw e; }
    const r = { id: id("r"), ws: p.ws, projectId: p.id, type: data.type, title, brief, aspect: data.aspect, length: String(data.length || "").slice(0, 40),
      due: data.due, assigneeId: null, by: user().id, at: now(), status: "Submitted", revisionsUsed: 0, assetIds: data.assetIds || [] };
    state.requests.unshift(r); log("Submitted editing request", title, p.ws);
    state.users.filter((u) => u.role === "admin").forEach((a) => notify(a.id, `New editing request: ${title}`, `project-${p.id}`));
    save(); return r;
  }),
  assignRequest: (rid, editorId) => call(() => {
    const r = state.requests.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "request.assign", { project: p });
    const ed = state.users.find((u) => u.id === editorId && u.role === "editor");
    if (!ed) { const e = new Error("Pick an editor."); e.code = 400; throw e; }
    r.assigneeId = ed.id; r.status = "Assigned"; if (!p.editorIds.includes(ed.id)) p.editorIds.push(ed.id);
    log("Assigned editor", `${ed.name} → ${r.title}`, p.ws); notify(ed.id, `You were assigned: ${r.title}`, `project-${p.id}`); save(); return r;
  }),
  startRequest: (rid) => call(() => {
    const r = state.requests.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "request.start", { project: p });
    r.status = "In progress"; log("Started editing", r.title, p.ws); save(); return r;
  }),

  // ---- reviews ----
  reviews: () => call(() => state.reviews.filter((r) => canViewProject(user(), project(r.projectId))).map((r) => ({
    ...r, projectName: project(r.projectId)?.name, open: r.comments.filter((c) => !c.resolved).length,
    latest: r.versions[r.versions.length - 1], poster: MEDIA[r.versions[r.versions.length - 1].media]?.poster }))),
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
    log("Commented on review", r.title, p.ws); save(); return c;
  }),
  reply: (rid, cid, body) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId); enforce(user(), "review.comment", { project: p });
    const c = r.comments.find((x) => x.id === cid); const text = String(body || "").trim().slice(0, 2000);
    if (!c || !text) { const e = new Error("Write a reply first."); e.code = 400; throw e; }
    c.replies.push({ by: user().id, body: text, at: now() }); save(); return c;
  }),
  resolve: (rid, cid, resolved) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId); const c = r?.comments.find((x) => x.id === cid);
    enforce(user(), "review.resolve", { project: p, resource: c, ws: p?.ws });
    c.resolved = resolved; r.audit.push({ at: now(), by: user().id, action: resolved ? "Resolved a comment" : "Reopened a comment" }); save(); return c;
  }),
  decide: (rid, decision, note) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "review.decide", { project: p, ws: p?.ws });
    const req = state.requests.find((x) => x.id === r.requestId);
    if (decision === "changes") {
      const text = String(note || "").trim();
      if (!text) { const e = new Error("Say what should change so the editor can act on it."); e.code = 400; throw e; }
      if (req && req.revisionsUsed >= p.revisionLimit) { const e = new Error(`This project's ${p.revisionLimit} included revisions are used. Ask your producer about an extra round.`); e.code = 409; throw e; }
      r.status = "Changes requested"; if (req) { req.status = "Revision"; req.revisionsUsed += 1; }
      r.audit.push({ at: now(), by: user().id, action: "Requested changes", detail: text.slice(0, 120) });
      p.editorIds.forEach((e) => notify(e, `Changes requested on ${r.title}`, `review-${r.id}`));
    } else if (decision === "approve") {
      r.status = "Approved"; if (req) req.status = "Approved";
      r.audit.push({ at: now(), by: user().id, action: `Approved version ${r.versions.length}` });
      const latest = r.versions[r.versions.length - 1];
      const a = state.assets.find((x) => x.projectId === p.id && x.media === latest.media); if (a) a.channel = true;
      state.feed.unshift({ id: id("fd"), ws: p.ws, kind: "approved", by: user().id, at: now(), text: `Approved ${r.title} (version ${r.versions.length}).`,
        assetId: a?.id, comments: [], saves: [] });
      p.editorIds.forEach((e) => notify(e, `${r.title} was approved`, `review-${r.id}`));
    } else { const e = new Error("Unknown decision"); e.code = 400; throw e; }
    log(decision === "approve" ? "Approved deliverable" : "Requested changes", r.title, p.ws); save(); return r;
  }),
  /** Simulated: adds a new version using an existing demo clip. No rendering happens in the preview. */
  uploadVersion: (rid, note) => call(() => {
    const r = state.reviews.find((x) => x.id === rid); const p = project(r?.projectId);
    enforce(user(), "review.upload_version", { project: p });
    const prev = r.versions[r.versions.length - 1];
    r.versions.push({ n: r.versions.length + 1, media: prev.media === "v1" ? "v2" : prev.media, by: user().id, at: now(), note: String(note || "Revised cut").slice(0, 200), simulated: true });
    r.status = "In review"; const req = state.requests.find((x) => x.id === r.requestId); if (req) req.status = "In review";
    r.audit.push({ at: now(), by: user().id, action: `Uploaded version ${r.versions.length} (simulated)` });
    state.users.filter((u) => u.role === "client" && u.workspaceIds.includes(p.ws)).forEach((c) => notify(c.id, `New version of ${r.title} is ready`, `review-${r.id}`));
    log("Submitted new version", r.title, p.ws); save(); return r;
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
    state.assets.filter((a) => canViewAsset(u, a, project(a.projectId)) && (hit(a.name) || a.tags.some(hit)))
      .forEach((a) => out.push({ type: "Media", title: a.name, sub: project(a.projectId)?.name || "Workspace library", link: `asset-${a.id}` }));
    state.reviews.filter((r) => canViewProject(u, project(r.projectId)) && (hit(r.title) || r.comments.some((c) => hit(c.body))))
      .forEach((r) => out.push({ type: "Review", title: r.title, sub: r.status, link: `review-${r.id}` }));
    state.lessons.filter((l) => hit(l.title) || hit(l.track)).forEach((l) => out.push({ type: "Coaching", title: l.title, sub: l.track, link: `lesson-${l.id}` }));
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
    // Approval runs the same authorized service call a person would make; a denied action stays unexecuted.
    if (p.kind === "request") await svc.createRequest(p.payload);
    else if (p.kind === "comment") await svc.addComment(p.payload.reviewId, p.payload);
    else if (p.kind === "folder") await svc.createFolder(p.payload.ws, p.payload.name);
    p.status = "Done"; save(); return clone(p);
  },
  chat: () => clone(state.chat[user().id] || []),
  saveChat: (msgs) => { state.chat[user().id] = msgs.slice(-40); save(); },
};

export function fmtT(t) { const s = Math.max(0, t || 0); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; }
export { Denied };
