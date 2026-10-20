// Menapoly Cue (cloud): phone-first app. Plain modules, no build step, no third-party code.
// Honesty rules: statuses come from the server; a percentage appears only when something was measured (bytes confirmed
// by storage, or progress your Mac measured from FFmpeg/Whisper). Otherwise the stage is shown in words.
// Safety rules: Ask Cue only proposes; you approve. A lost sign-in pauses work and keeps your place.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { pendingUploads, uploadFile } from "./upload.js";

const $app = document.getElementById("app");
const state = { me: null, status: null, timer: null, uploads: new Map(), route: "", nav: 0, expired: false,
  offline: !navigator.onLine, installPrompt: null };

// --- helpers ----------------------------------------------------------------------------------------------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // CSSOM is allowed by the CSP; inline style attributes are not
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const safe = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
               set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
               del(k) { try { sessionStorage.removeItem(k); } catch { /* private mode */ } } };
const fmtBytes = (n) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const fmtTime = (t) => t ? new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
const ago = (t) => {
  if (!t) return "never";
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : fmtTime(t);
};
const dur = (s) => { s = Math.max(0, Math.round(s)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const JOB_LABEL = { transcribe: "Transcript", auto_edit: "Suggested edit", render: "Video export" };
const STATUS = {
  awaiting_authorization: ["Needs your authorization", "warn"], queued: ["Waiting for your Mac", "muted"],
  leased: ["Starting on your Mac", "accent"], running: ["Working on your Mac", "accent"], succeeded: ["Done", "ok"],
  failed: ["Failed", "danger"], dead: ["Stopped after 3 tries", "danger"], cancelled: ["Cancelled", "muted"],
};
const LIVE = ["queued", "leased", "running", "awaiting_authorization"];
const PRESETS = [["youtube", "YouTube 1080p"], ["podcast", "Podcast + WAV"], ["reels", "Instagram Reels"], ["tiktok", "TikTok"],
  ["linkedin", "LinkedIn"], ["preview", "Quick preview"]];

function toast(message, kind = "ok") {
  const box = document.getElementById("toasts");
  while (box.children.length >= 2) box.firstElementChild.remove(); // never a pile of messages over the screen
  const el = h("div", { class: `toast ${kind}`, role: kind === "err" ? "alert" : "status" }, icon(kind === "err" ? "alert" : "check", 18), h("span", {}, message));
  box.append(el);
  setTimeout(() => el.remove(), kind === "err" ? 7000 : 3500);
}
async function run(fn, okMessage) {
  try { const r = await fn(); if (okMessage) toast(okMessage); return r; }
  catch (e) {
    if (e.status === 0 && !navigator.onLine) { state.offline = true; renderBanners(); } // the banner says it once
    else if (e.status !== 401) toast(e.message || String(e), "err");
    return undefined;
  }
}
const button = (label, onclick, cls = "btn", extra = {}) => h("button", { class: cls, type: "button", onclick, ...extra }, label);
const ibutton = (name, label, onclick, cls = "btn") => h("button", { class: cls, type: "button", onclick }, icon(name, 18), h("span", {}, label));
const chip = (text, tone = "muted") => h("span", { class: `pill ${tone}` }, text);
const progressBar = (fraction, label) => fraction == null ? null :
  h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(fraction * 100)), "aria-label": label },
    h("span", { style: `width:${(fraction * 100).toFixed(1)}%` }));

// --- session, connectivity, banners ----------------------------------------------------------------------------
function renderBanners() {
  const box = document.getElementById("banners");
  if (!box) return;
  const items = [];
  if (state.expired) items.push(h("div", { class: "banner warn", role: "alert" }, icon("lock", 20),
    h("div", { class: "grow" }, h("strong", {}, "Your sign-in has expired"),
      h("span", {}, "Nothing was lost. Uploads are paused and pick up where they stopped after you sign in.")),
    button("Sign in again", () => { safe.set("cue-return", location.hash || "#/"); location.reload(); }, "btn primary")));
  if (state.offline) items.push(h("div", { class: "banner", role: "status" }, icon("offline", 20),
    h("div", { class: "grow" }, h("strong", {}, "You're offline"), h("span", {}, "Uploads continue when the connection is back."))));
  box.replaceChildren(...items);
}
addEventListener("cue:session-expired", () => {
  if (state.expired) return;
  state.expired = true;
  clearTimeout(state.timer);
  safe.set("cue-return", location.hash || "#/");
  for (const u of state.uploads.values()) if (["checking", "uploading", "waiting", "finishing"].includes(u.phase)) {
    u.pausedForSignIn = true; u.phase = "paused"; u.controller.abort(); renderUploads(u.projectId);
  }
  renderBanners();
});
addEventListener("offline", () => { state.offline = true; renderBanners(); });
addEventListener("online", () => { state.offline = false; renderBanners(); if (!state.expired) route(); });
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); state.installPrompt = e; });

// --- shell ----------------------------------------------------------------------------------------------------
function shell(title, content, { back, nav, wide } = {}) {
  if (nav !== state.nav) return false; // a newer navigation or refresh started while this page was loading
  if (state.expired) { renderBanners(); return false; } // keep the screen you were on; just add the sign-in banner
  const hash = location.hash || "#/";
  const current = hash.startsWith("#/ask") ? "#/ask" : hash === "#/inbox" ? "#/inbox" : hash === "#/settings" ? "#/settings" : "#/";
  const tab = (href, label, name) => h("a", { href, class: "tab" + (current === href ? " on" : ""), "aria-current": current === href ? "page" : null },
    icon(name, 22), h("span", {}, label));
  const online = state.status?.workers_online;
  $app.replaceChildren(
    h("header", { class: "top" },
      back ? h("a", { href: back, class: "back", "aria-label": "Back" }, icon("back", 24)) : h("span", { class: "logo", "aria-hidden": "true" }, icon("logo", 20)),
      h("h1", {}, title),
      h("span", { id: "worker-pill", class: `pill ${online == null ? "muted" : online ? "ok" : "warn"}`,
        title: online ? "Your Mac checked in within the last 2 minutes" : "No Mac has checked in for 2 minutes. Work waits in the queue." },
        icon("laptop", 16), online == null ? "…" : online ? "Mac online" : "Mac offline")),
    h("div", { id: "banners" }),
    h("main", { id: "main", class: wide ? "wide" : "" }, content),
    h("nav", { class: "tabs", "aria-label": "Sections" },
      tab("#/", "Projects", "folder"), tab("#/ask", "Ask Cue", "sparkles"), tab("#/inbox", "Inbox", "inbox"), tab("#/settings", "Settings", "sliders")));
  renderBanners();
  return true;
}
async function refreshStatus() { const s = await api("/v1/status").catch(() => null); if (s) state.status = s; return s; }
function poll(fn, ms) {
  clearTimeout(state.timer);
  const r = state.route;
  state.timer = setTimeout(async () => {
    if (state.route !== r || state.expired) return;
    if (document.visibilityState === "visible") await fn(); else poll(fn, ms);
  }, ms);
}
const sec = (title, ...body) => h("section", { class: "card" }, h("h2", {}, title), ...body);

// --- projects -------------------------------------------------------------------------------------------------
async function projectsPage(nav) {
  const [projects] = await Promise.all([run(() => api("/v1/projects")), refreshStatus()]);
  const draft = safe.get("cue-new-project") || "";
  const name = h("input", { id: "new-project", name: "name", placeholder: "e.g. Market Mocha interview", maxlength: "120", required: true,
    autocomplete: "off", value: draft, oninput: (e) => safe.set("cue-new-project", e.target.value) });
  const client = h("input", { id: "new-client", name: "client", placeholder: "Client (optional)", maxlength: "120", autocomplete: "off" });
  const form = h("details", { class: "card new", open: draft || (projects && !projects.length) ? true : null },
    h("summary", {}, icon("plus", 20), h("span", {}, "New project")),
    h("form", { class: "form", onsubmit: async (e) => {
      e.preventDefault();
      const p = await run(() => api("/v1/projects", { method: "POST", idempotencyKey: `prj-${crypto.randomUUID()}`, body: { name: name.value, client: client.value } }));
      if (p) { safe.del("cue-new-project"); location.hash = `#/project/${p.id}`; }
    } }, h("label", { for: "new-project" }, "Project name"), name, h("label", { for: "new-client" }, "Client"), client,
      h("button", { class: "btn primary", type: "submit" }, "Create project")));
  const list = !projects ? h("p", { class: "empty" }, "Projects couldn't be loaded.") : !projects.length
    ? h("p", { class: "empty" }, "No projects yet. Create one, then upload footage from your phone.")
    : h("div", { class: "list" }, projects.map((p) => {
        const state_ = p.pending_approvals ? chip(`${plural(p.pending_approvals, "edit")} to approve`, "warn")
          : p.failed_jobs ? chip("Needs attention", "danger") : p.active_jobs ? chip(`${p.active_jobs} in progress`, "accent")
          : p.output_count ? chip("Video ready", "ok") : !p.source_count ? chip("Add footage", "muted") : null;
        return h("a", { class: "card project", href: `#/project/${p.id}` },
          h("div", { class: "project-head" }, h("strong", {}, p.name), icon("chevron", 18)),
          p.client ? h("span", { class: "muted" }, p.client) : null,
          h("div", { class: "meta" }, state_, h("span", {}, `${plural(p.source_count, "file")} · ${plural(p.output_count, "export")} · ${ago(p.updated_at)}`)));
      }));
  shell("Menapoly Cue", [form, h("h2", { class: "section-title" }, "Projects"), list], { nav });
}

// --- one project ----------------------------------------------------------------------------------------------
async function projectPage(id, nav) {
  const [data] = await Promise.all([run(() => api(`/v1/projects/${id}`)), refreshStatus()]);
  if (!data) { shell("Project", h("p", { class: "empty" }, "This project couldn't be loaded. It may have been archived."), { back: "#/", nav }); return; }
  const { project, assets, jobs, versions } = data;
  const sources = assets.filter((a) => a.kind === "source" && a.status === "ready");
  const exports = assets.filter((a) => a.kind === "output" && a.status === "ready" && a.media_type === "video");
  const live = jobs.filter((j) => LIVE.includes(j.status));
  const finished = jobs.filter((j) => !LIVE.includes(j.status));
  const proposed = versions.filter((v) => v.status === "proposed");
  const approved = versions.filter((v) => v.status === "approved");
  const online = Boolean(state.status?.workers_online);
  const jobById = Object.fromEntries(jobs.map((j) => [j.id, j]));

  // Next step: one plain sentence about what matters now.
  const next = proposed.length ? ["warn", "sparkles", `Edit ${proposed[0].number} is ready for your review`, "Approve it to export, or reject it."]
    : live.length ? [online ? "accent" : "warn", online ? "clock" : "laptop", online ? `Your Mac is working on ${plural(live.length, "job")}` : "Waiting for your Mac",
        online ? "This page updates by itself." : "Your Mac is offline. The work starts by itself when it reconnects."]
    : !sources.length ? ["muted", "upload", "Upload footage to begin", "Original quality, straight to private storage."]
    : exports.length ? ["ok", "check", "Your video is ready", "Play it or download it below."]
    : approved.length ? ["accent", "film", "Export your approved edit", "Choose a format under Edits."]
    : ["accent", "sparkles", "Ask for a suggested edit", "Your Mac prepares an edit for you to review."];

  const uploadsBox = h("div", { class: "uploads", "aria-live": "polite" });
  const picker = h("input", { type: "file", id: "file-input", multiple: true, class: "visually-hidden",
    accept: "video/*,audio/*,image/*,.mov,.mp4,.m4a,.wav,.pdf,.txt,.md,.docx,.srt,.vtt",
    onchange: () => { for (const f of picker.files) startUpload(id, f); picker.value = ""; } });
  const resumable = ((await pendingUploads()) || []).filter((u) => u.projectId === id && u.session && ![...state.uploads.values()].some((x) => x.key === u.key));

  const versionRow = (v) => {
    const job = jobById[v.source_job_id];
    const why = job?.result?.rationale;
    const preset = h("select", { "aria-label": `Export format for edit ${v.number}`, id: `preset-${v.id}` }, PRESETS.map(([k, l]) => h("option", { value: k }, l)));
    const clipsBox = h("div", { class: "clips", id: `clips-${v.id}` });
    return h("li", { class: "row edit" },
      h("div", { class: "grow" },
        h("div", { class: "title-row" }, h("strong", {}, `Edit ${v.number}: ${v.label}`),
          chip(v.status === "proposed" ? "Needs your review" : v.status === "approved" ? "Approved" : "Rejected", v.status === "approved" ? "ok" : v.status === "rejected" ? "muted" : "warn")),
        h("span", { class: "meta" }, [job?.result?.duration ? `${dur(job.result.duration)} long` : null, job?.result?.clips ? plural(job.result.clips, "clip") : null, `proposed ${ago(v.created_at)}`].filter(Boolean).join(" · ")),
        why ? h("p", { class: "why" }, why) : null, clipsBox),
      h("div", { class: "actions" },
        button("Show clips", () => showVersion(v.id)),
        v.status === "proposed" ? ibutton("check", "Approve", () => decide(v.id, "approved"), "btn primary") : null,
        v.status === "proposed" ? ibutton("x", "Reject", () => decide(v.id, "rejected")) : null,
        v.status === "approved" ? preset : null,
        v.status === "approved" ? ibutton("film", "Export", () => submitJob(id, { type: "render", version_id: v.id, preset: preset.value }), "btn primary") : null));
  };
  const jobRow = (j) => {
    const [label, tone] = STATUS[j.status] || [j.status, "muted"];
    const running = ["leased", "running"].includes(j.status);
    return h("li", { class: "row job", "data-status": j.status },
      h("div", { class: "grow" },
        h("div", { class: "title-row" }, h("strong", {}, JOB_LABEL[j.type] || j.type), chip(label, tone)),
        running || j.status === "queued" ? h("span", { class: "meta" }, j.stage && j.status !== "queued" ? j.stage : (online ? "Next in line on your Mac" : "Your Mac is offline. This starts when it reconnects.")) : null,
        running ? progressBar(j.progress, `${JOB_LABEL[j.type]} progress`) : null,
        running && j.progress != null ? h("span", { class: "meta" }, `${Math.round(j.progress * 100)}% of this step, measured on your Mac`) : null,
        h("span", { class: "meta" }, j.started_at ? `${running ? "Running for" : "Took"} ${dur((running ? Date.now() / 1000 : j.finished_at || Date.now() / 1000) - j.started_at)}` : `Requested ${ago(j.created_at)}`,
          j.attempts > 1 ? ` · try ${j.attempts} of ${j.max_attempts}` : ""),
        j.error ? h("span", { class: "error" }, j.error) : null),
      h("div", { class: "actions" },
        LIVE.includes(j.status) ? button("Cancel", () => run(() => api(`/v1/jobs/${j.id}/cancel`, { method: "POST" }), "Cancelled").then(() => route())) : null,
        ["failed", "dead", "cancelled"].includes(j.status) ? ibutton("refresh", "Retry", () => run(() => api(`/v1/jobs/${j.id}/retry`, { method: "POST" }), "Queued again").then(() => route())) : null));
  };
  const assetRow = (a) => h("li", { class: "row" },
    h("span", { class: "thumb", "aria-hidden": "true" }, icon(a.media_type === "video" ? "film" : a.media_type === "audio" ? "wave" : "doc", 20)),
    h("div", { class: "grow" }, h("strong", { class: "name" }, a.name), h("span", { class: "meta" }, `${a.media_type} · ${fmtBytes(a.size)} · ${ago(a.created_at)}`)),
    ["video", "audio"].includes(a.media_type) ? h("div", { class: "actions" },
      ibutton("play", "Preview", () => preview(a)),
      button("Transcribe", () => submitJob(id, { type: "transcribe", asset_id: a.id })),
      ibutton("sparkles", "Suggest edit", () => submitJob(id, { type: "auto_edit", asset_id: a.id }), "btn primary")) : null);
  const exportRow = (a) => h("li", { class: "row" },
    h("span", { class: "thumb ok", "aria-hidden": "true" }, icon("film", 20)),
    h("div", { class: "grow" }, h("strong", { class: "name" }, a.name), h("span", { class: "meta" }, `${fmtBytes(a.size)} · ${ago(a.created_at)} · checksum verified`)),
    h("div", { class: "actions" }, ibutton("play", "Play", () => preview(a)), ibutton("download", "Download", () => download(a), "btn primary")));

  const ok = shell(project.name, [
    h("section", { class: `next ${next[0]}` }, icon(next[1], 22), h("div", {}, h("strong", {}, next[2]), h("span", {}, next[3]))),
    proposed.length ? sec("Needs your review", h("ul", { class: "rows" }, proposed.map(versionRow))) : null,
    live.length ? sec("In progress", h("ul", { class: "rows" }, live.map(jobRow))) : null,
    sec("Footage",
      h("label", { for: "file-input", class: "btn primary block" }, icon("upload", 20), h("span", {}, "Upload from this phone")), picker,
      h("p", { class: "meta" }, "Original quality, straight to private storage. Keep this screen open while it uploads; if it stops, choose the same file again."),
      resumable.length ? h("div", { class: "notice" }, h("strong", {}, "Unfinished uploads"),
        ...resumable.map((u) => h("p", {}, `${u.name} (${fmtBytes(u.size)}): choose the same file again to continue.`))) : null,
      uploadsBox,
      sources.length ? h("ul", { class: "rows" }, sources.map(assetRow)) : null),
    exports.length ? sec("Finished videos", h("ul", { class: "rows" }, exports.map(exportRow))) : null,
    approved.length || versions.some((v) => v.status === "rejected") ? sec("Edits", h("ul", { class: "rows" }, versions.filter((v) => v.status !== "proposed").map(versionRow))) : null,
    finished.length ? h("details", { class: "card fold" }, h("summary", {}, h("span", {}, `Finished work (${finished.length})`), icon("chevron", 18)),
      h("ul", { class: "rows" }, finished.slice(0, 20).map(jobRow))) : null,
    h("section", { class: "card quiet" },
      h("a", { class: "btn block", href: `#/ask/${id}` }, icon("sparkles", 18), h("span", {}, "Ask Cue about this project")),
      h("p", { class: "meta" }, `AI spending: $${project.spent_usd.toFixed(2)} of $${project.budget_usd.toFixed(2)}. Your Mac's pipeline makes no paid AI calls; cloud processing is off.`),
      state.me?.role === "owner" ? archiveControl(project) : null),
  ], { back: "#/", nav });
  if (!ok) return;
  renderUploads(id);
  if (live.length || state.uploads.size) poll(() => route(), 4000); else poll(() => route(), 30000);
}

function archiveControl(project) {
  const box = h("div", { class: "confirm" });
  const ask = () => box.replaceChildren(h("p", {}, `Archive ${project.name}? It leaves your list and queued work stops. Stored files stay in private storage.`),
    h("div", { class: "actions" }, button("Keep it", () => box.replaceChildren(open)),
      ibutton("archive", "Archive", async () => { if (await run(() => api(`/v1/projects/${project.id}/archive`, { method: "POST" }), "Archived")) location.hash = "#/"; }, "btn danger")));
  const open = ibutton("archive", "Archive project", ask, "btn ghost");
  box.append(open);
  return box;
}

async function submitJob(projectId, body) {
  const job = await run(() => api(`/v1/projects/${projectId}/jobs`, { method: "POST", idempotencyKey: `job-${crypto.randomUUID()}`, body }),
    state.status?.workers_online ? "Sent to your Mac" : "Queued. It starts when your Mac reconnects.");
  if (job) route();
}
async function decide(versionId, decision) {
  if (await run(() => api(`/v1/versions/${versionId}/decision`, { method: "POST", body: { decision } }), decision === "approved" ? "Approved. Choose a format to export." : "Rejected")) route();
}
async function showVersion(id) {
  const v = await run(() => api(`/v1/versions/${id}`));
  const box = document.getElementById(`clips-${id}`);
  if (!v || !box) return;
  const clips = v.timeline.clips || [];
  const total = clips.reduce((s, c) => s + (c.end - c.start), 0);
  box.replaceChildren(h("p", { class: "meta" }, `${plural(clips.length, "clip")}, ${dur(total)} in total`),
    h("ol", { class: "cliplist" }, clips.slice(0, 40).map((c) => h("li", {}, `${c.label ? c.label + ": " : ""}${c.start.toFixed(1)}s – ${c.end.toFixed(1)}s`))));
}
async function preview(asset) {
  const r = await run(() => api(`/v1/assets/${asset.id}/url`));
  if (!r) return;
  const media = h(asset.media_type === "audio" ? "audio" : "video", { src: r.url, controls: true, playsinline: true, preload: "metadata" });
  dialog(asset.name, media, h("p", { class: "meta" }, "Private link, valid for 10 minutes."));
}
async function download(asset) {
  const r = await run(() => api(`/v1/assets/${asset.id}/url?download=1`));
  if (r) { toast("Downloading. It saves to your Downloads folder."); location.href = r.url; }
}
function dialog(title, ...content) {
  const d = h("dialog", { class: "sheet", "aria-label": title },
    h("div", { class: "sheet-head" }, h("h2", {}, title), ibutton("x", "Close", () => d.close(), "btn ghost")), ...content);
  d.addEventListener("close", () => { d.querySelectorAll("video,audio").forEach((m) => m.pause()); d.remove(); });
  document.body.append(d);
  d.showModal();
}

// --- uploads ----------------------------------------------------------------------------------------------------
function startUpload(projectId, file) {
  const id = crypto.randomUUID();
  const u = { id, key: `${projectId}:${file.name}:${file.size}:${file.lastModified}`, projectId, file, phase: "checking", fraction: 0, message: "Starting" };
  state.uploads.set(id, u);
  u.resume = () => {
    u.controller = new AbortController();
    u.phase = "checking"; u.error = null; u.pausedForSignIn = false;
    uploadFile(projectId, file, (s) => { if (!u.controller.signal.aborted) { Object.assign(u, s); renderUploads(projectId); } }, u.controller.signal)
      .then(() => { u.phase = "done"; toast(`${file.name} uploaded`); setTimeout(() => { state.uploads.delete(id); if (location.hash === `#/project/${projectId}`) route(); }, 1200); })
      .catch((e) => {
        u.phase = e.name === "AbortError" || e.status === 401 ? "paused" : "error";
        u.error = u.phase === "error" ? e.message : null;
        if (e.status === 401) u.pausedForSignIn = true;
        renderUploads(projectId);
      });
  };
  u.resume();
  renderUploads(projectId);
}
function renderUploads(projectId) {
  const box = document.querySelector(".uploads");
  if (!box) return;
  const mine = [...state.uploads.values()].filter((u) => u.projectId === projectId);
  box.replaceChildren(...mine.map((u) => h("div", { class: "upload", "data-phase": u.phase },
    h("div", { class: "title-row" }, h("strong", { class: "name" }, u.file.name), h("span", { class: "meta" }, fmtBytes(u.file.size))),
    progressBar(u.phase === "done" ? 1 : u.fraction, `Upload of ${u.file.name}`),
    h("span", { class: "meta" }, u.phase === "paused" ? (u.pausedForSignIn ? "Paused until you sign in again" : "Paused") : u.phase === "error" ? `Stopped: ${u.error}` :
      `${u.message || ""}${u.fraction != null && u.phase !== "done" ? ` · ${Math.floor(u.fraction * 100)}%` : ""}`),
    h("div", { class: "actions" },
      ["uploading", "checking", "waiting"].includes(u.phase) ? button("Pause", () => u.controller.abort()) : null,
      ["paused", "error"].includes(u.phase) && !state.expired ? ibutton("upload", "Resume", () => u.resume(), "btn primary") : null))));
}

// --- Ask Cue ----------------------------------------------------------------------------------------------------
function loadChat() { try { return JSON.parse(safe.get("cue-chat") || "[]"); } catch { return []; } }
function saveChat(msgs) { safe.set("cue-chat", JSON.stringify(msgs.slice(-30))); }

async function askPage(nav, projectId) {
  const [actions, projects] = await Promise.all([run(() => api("/v1/actions")), run(() => api("/v1/projects")), refreshStatus()]);
  const scoped = projectId ? (projects || []).find((p) => p.id === projectId) : null;
  const msgs = loadChat();
  const thread = h("div", { class: "thread", "aria-live": "polite" });
  const input = h("input", { id: "ask-input", name: "message", maxlength: "500", autocomplete: "off", required: true,
    placeholder: scoped ? `Ask about ${scoped.name}…` : "Ask Cue anything about your projects…", value: safe.get("cue-ask-draft") || "",
    oninput: (e) => safe.set("cue-ask-draft", e.target.value) });
  const pending = (actions || []).filter((a) => a.status === "pending");

  const actionCard = (a) => h("div", { class: `action ${a.status}`, "data-action": a.id },
    h("div", { class: "title-row" }, h("span", { class: "eyebrow" }, icon("sparkles", 14), "Proposed action"),
      chip(a.status === "pending" ? "Waiting for you" : a.status === "approved" ? "Done" : a.status === "failed" ? "Couldn't run" : "Rejected",
        a.status === "approved" ? "ok" : a.status === "failed" ? "danger" : a.status === "pending" ? "warn" : "muted")),
    h("strong", {}, a.summary), a.error ? h("span", { class: "error" }, a.error) : null,
    a.status === "pending" ? h("div", { class: "actions" },
      ibutton("check", "Approve", () => decideAction(a.id, "approve"), "btn primary"), ibutton("x", "Reject", () => decideAction(a.id, "reject"))) : null);

  const bubble = (m) => m.role === "you" ? h("div", { class: "msg you" }, m.text)
    : h("div", { class: "msg cue" }, h("span", { class: "who" }, icon("sparkles", 16), "Cue"), h("p", {}, m.text),
        m.items?.length ? h("ul", { class: "answers" }, m.items.map((it) => h("li", {},
          it.href ? h("a", { href: it.href }, h("strong", {}, it.label), it.detail ? h("span", {}, it.detail) : null, icon("chevron", 16))
            : button(it.label, () => { input.value = it.label; send(); }, "suggestion")))) : null,
        m.action ? actionCard((actions || []).find((a) => a.id === m.action.id) || m.action) : null);
  const draw = () => {
    thread.replaceChildren(...(msgs.length ? msgs.map(bubble) : [h("div", { class: "msg cue" }, h("span", { class: "who" }, icon("sparkles", 16), "Cue"),
      h("p", {}, "Ask about your projects, or tell me what to do next. Anything that changes your work comes back as a proposal for you to approve."),
      h("ul", { class: "answers" }, ["What needs my attention?", "Is my Mac online?", scoped ? `Suggest an edit for ${scoped.name}` : "New project Spring promo"]
        .map((q) => h("li", {}, button(q, () => { input.value = q; send(); }, "suggestion")))))]));
  };
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    msgs.push({ role: "you", text });
    input.value = ""; safe.del("cue-ask-draft");
    draw();
    const r = await run(() => api("/v1/ask", { method: "POST", body: { message: text, project_id: projectId || undefined } }));
    if (r) msgs.push({ role: "cue", text: r.reply, items: r.items, action: r.action });
    else msgs.push({ role: "cue", text: "I couldn't answer that just now. Your message is above; try again in a moment." });
    saveChat(msgs);
    draw();
    thread.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
  }
  async function decideAction(id, decision) {
    const r = await run(() => api(`/v1/actions/${id}/${decision}`, { method: "POST" }));
    if (r?.status === "approved") { toast("Done"); if (r.href && r.href !== location.hash) { location.hash = r.href; return; } }
    else if (r?.status === "rejected") toast("Rejected");
    route();
  }
  draw();
  const ok = shell(scoped ? `Ask Cue · ${scoped.name}` : "Ask Cue", [
    h("div", { class: "ask-head" }, chip("Built-in planner", "accent"), h("span", { class: "meta" }, "Claude isn't connected. Cue answers from your projects and only proposes.")),
    pending.length ? sec(`Waiting for your approval (${pending.length})`, ...pending.map(actionCard)) : null,
    thread,
    h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); send(); } },
      h("label", { for: "ask-input", class: "visually-hidden" }, "Message"), input,
      h("button", { class: "btn primary icon-only", type: "submit", "aria-label": "Send" }, icon("send", 20))),
    msgs.length ? button("Clear conversation", () => { safe.del("cue-chat"); route(); }, "btn ghost small") : null,
  ], { back: projectId ? `#/project/${projectId}` : null, nav });
  if (ok && pending.length) poll(() => route(), 20000);
}

// --- inbox ------------------------------------------------------------------------------------------------------
async function inboxPage(nav) {
  const [data] = await Promise.all([run(() => api("/v1/notifications")), refreshStatus()]);
  const list = !data ? h("p", { class: "empty" }, "The inbox couldn't be loaded.") : !data.items.length
    ? h("p", { class: "empty" }, "Nothing new. Finished jobs, failures and uploads show up here.")
    : h("div", { class: "list" }, data.items.map((n) => h("a", { class: "card note" + (n.read_at ? "" : " unread"), href: n.href || "#/" },
        h("span", { class: `thumb ${n.kind === "job_failed" ? "danger" : n.kind === "job_done" ? "ok" : ""}`, "aria-hidden": "true" },
          icon(n.kind === "job_failed" ? "alert" : n.kind === "upload_complete" ? "upload" : n.kind === "job_done" ? "check" : "inbox", 18)),
        h("div", { class: "grow" }, h("strong", {}, n.title), n.body ? h("span", {}, n.body) : null, h("span", { class: "meta" }, ago(n.created_at))))));
  const ok = shell("Inbox", [data?.unread ? h("div", { class: "actions end" }, button("Mark all read", () => run(() => api("/v1/notifications/read", { method: "POST" })).then(() => route()))) : null, list], { nav });
  if (ok) poll(() => route(), 15000);
}

// --- settings -----------------------------------------------------------------------------------------------------
async function settingsPage(nav) {
  const me = state.me || {};
  const [costs] = await Promise.all([run(() => api("/v1/costs")), refreshStatus()]);
  const status = state.status;
  const standalone = matchMedia("(display-mode: standalone)").matches;
  const sections = [
    sec("Account", h("p", {}, `Signed in as ${me.email || "?"} (${me.role || "?"}).`),
      me.environment === "development" ? h("p", { class: "notice" }, "Local test mode: sign-in is simulated on this computer only.")
        : h("a", { class: "btn", href: "/cdn-cgi/access/logout" }, icon("lock", 18), h("span", {}, "Sign out"))),
    sec("This phone",
      h("p", {}, standalone ? "Menapoly Cue is installed as an app on this phone." : "Install Menapoly Cue to open it from your home screen, full-screen."),
      !standalone && state.installPrompt ? ibutton("download", "Install app", async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice.catch(() => {}); state.installPrompt = null; route(); }, "btn primary") : null,
      !standalone && !state.installPrompt ? h("p", { class: "meta" }, "In Chrome: tap ⋮, then Install app (or Add to Home screen).") : null),
  ];
  if (costs) sections.push(sec(`Costs for ${costs.month}`,
    costs.by_kind.length ? h("ul", { class: "rows" }, costs.by_kind.map((k) => h("li", { class: "row" }, h("span", { class: "grow" }, k.kind), h("strong", {}, `$${k.usd.toFixed(2)}`))))
      : h("p", {}, "No recorded spending this month."),
    h("p", { class: "meta" }, `Stored media: ${costs.storage_gb.toFixed(2)} GB (about $${costs.storage_estimate_usd_month.toFixed(2)} a month at R2 prices; the first 10 GB are free).`),
    h("p", { class: "meta" }, `Cloud processing: ${costs.cloud_rendering === "enabled" ? "on (each paid job still needs your authorization)" : "off"}.`)));
  if (me.role === "owner") {
    const workers = await run(() => api("/v1/workers"));
    const name = h("input", { id: "worker-name", placeholder: "e.g. Studio iMac", maxlength: "80", required: true });
    const tokenBox = h("div", { "aria-live": "polite" });
    sections.push(sec("Mac workers",
      h("p", { class: "muted" }, "Your Mac connects out to Menapoly Cue. Nothing on your network is opened to the internet."),
      (workers || []).filter((w) => !w.revoked_at).length ? h("ul", { class: "rows" }, (workers || []).filter((w) => !w.revoked_at).map((w) => {
        const box = h("div", { class: "actions" });
        const removeBtn = button("Remove", () => box.replaceChildren(h("span", { class: "meta" }, "Its token stops working at once."),
          button("Keep", () => box.replaceChildren(removeBtn)),
          button("Remove", () => run(() => api(`/v1/workers/${w.id}`, { method: "DELETE" }), "Removed").then(() => route()), "btn danger")));
        box.append(removeBtn);
        return h("li", { class: "row" }, h("span", { class: `thumb ${w.online ? "ok" : ""}`, "aria-hidden": "true" }, icon("laptop", 18)),
          h("div", { class: "grow" }, h("div", { class: "title-row" }, h("strong", {}, w.name), chip(w.online ? "Online" : "Offline", w.online ? "ok" : "warn")),
            h("span", { class: "meta" }, `Last check-in ${ago(w.last_seen_at)}${w.version ? ` · v${w.version}` : ""}`)), box);
      })) : h("p", { class: "empty" }, "No Mac connected yet."),
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        const w = await run(() => api("/v1/workers", { method: "POST", body: { name: name.value } }));
        if (w) tokenBox.replaceChildren(h("p", { class: "notice" }, "Copy this token into the Mac worker setup now. It won't be shown again."),
          h("input", { class: "copy", readonly: true, value: w.token, "aria-label": "Worker token", onfocus: (ev) => ev.target.select() }),
          button("Copy token", () => navigator.clipboard.writeText(w.token).then(() => toast("Copied"), () => toast("Select the token and copy it", "err"))));
      } }, h("label", { for: "worker-name" }, "Add a Mac"), name, h("button", { class: "btn", type: "submit" }, "Create worker token")), tokenBox));
  }
  if (status) sections.push(sec("Pilot safety",
    h("ul", { class: "facts" },
      h("li", {}, icon("lock", 16), "Client review links: ", h("strong", {}, status.public_review === "enabled" ? "on" : "off")),
      h("li", {}, icon("laptop", 16), "Cloud processing: ", h("strong", {}, status.cloud_rendering === "enabled" ? "on" : "off")),
      h("li", {}, icon("inbox", 16), "Text messages (SMS): ", h("strong", {}, "off"))),
    h("p", { class: "meta" }, `Environment: ${status.environment}. Jobs: ${Object.entries(status.jobs).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}.`)));
  shell("Settings", sections, { nav });
}

// --- router -------------------------------------------------------------------------------------------------------
async function route() {
  if (state.expired) return renderBanners();
  const hash = location.hash || "#/";
  clearTimeout(state.timer);
  state.route = hash;
  const nav = ++state.nav;
  let m = /^#\/project\/(prj_[0-9a-f]{16})$/.exec(hash);
  if (m) return projectPage(m[1], nav);
  m = /^#\/ask(?:\/(prj_[0-9a-f]{16}))?$/.exec(hash);
  if (m) return askPage(nav, m[1]);
  if (hash === "#/inbox") return inboxPage(nav);
  if (hash === "#/settings") return settingsPage(nav);
  return projectsPage(nav);
}

async function boot() {
  try {
    state.me = await api("/v1/me");
  } catch (e) {
    $app.replaceChildren(h("main", { class: "center" }, h("span", { class: "logo big", "aria-hidden": "true" }, icon("logo", 28)), h("h1", {}, "Menapoly Cue"),
      h("p", { role: "alert" }, e.status === 403 ? "This account is not allowed in Menapoly Cue." : e.message),
      e.status === 403 ? h("p", { class: "muted" }, "This account isn't on the list of people allowed in.")
        : button(e.status === 401 ? "Sign in" : "Try again", () => location.reload(), "btn primary")));
    return;
  }
  // Coming back from sign-in: return to where you were.
  const back = safe.get("cue-return");
  if (back && back !== location.hash && /^#\/[\w/]*$/.test(back)) { safe.del("cue-return"); location.hash = back; }
  else safe.del("cue-return");
  addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || state.expired) return;
    try { await api("/v1/me"); route(); } catch { /* an expired session raises its own banner */ }
  });
  route();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
