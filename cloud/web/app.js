// Menapoly Cue (cloud) — mobile-first app shell. Plain modules, no build step, no third-party code.
// Honesty rules: statuses come from the server; a percentage is shown only when something was measured
// (bytes confirmed by storage, or progress the Mac measured from FFmpeg/Whisper); otherwise we show the stage text.
import { api } from "./api.js";
import { pendingUploads, uploadFile } from "./upload.js";

const $app = document.getElementById("app");
const state = { me: null, timer: null, uploads: new Map(), route: "", nav: 0 };

// --- tiny DOM helper (text is always set as text, never parsed as HTML) -------------------------------------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // CSSOM, allowed by the CSP (inline style attributes are not)
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const fmtBytes = (n) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const fmtTime = (t) => t ? new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
const ago = (t) => {
  if (!t) return "never";
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : fmtTime(t);
};
const elapsed = (from, to) => {
  const s = Math.max(0, Math.round((to || Date.now() / 1000) - from));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const JOB_LABEL = { transcribe: "Transcript", auto_edit: "Suggested edit", render: "Video export" };
const STATUS = {
  awaiting_authorization: ["Needs your authorization", "warn"], queued: ["Waiting for your Mac", "muted"],
  leased: ["Starting on your Mac", "accent"], running: ["Working on your Mac", "accent"], succeeded: ["Done", "ok"],
  failed: ["Failed", "danger"], dead: ["Stopped after retries", "danger"], cancelled: ["Cancelled", "muted"],
};
const PRESETS = [["youtube", "YouTube (1080p)"], ["podcast", "Podcast (+ WAV)"], ["reels", "Instagram Reels"],
  ["tiktok", "TikTok"], ["linkedin", "LinkedIn"], ["preview", "Quick preview"]];

function toast(message, kind = "ok") {
  const el = h("div", { class: `toast ${kind}`, role: kind === "err" ? "alert" : "status" }, message);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}
async function run(fn, okMessage) {
  try { const r = await fn(); if (okMessage) toast(okMessage); return r; }
  catch (e) { toast(e.message || String(e), "err"); return undefined; }
}
const button = (label, onclick, cls = "btn", extra = {}) => h("button", { class: cls, type: "button", onclick, ...extra }, label);
const progressBar = (fraction, label) => fraction == null ? null :
  h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(fraction * 100)), "aria-label": label },
    h("span", { style: `width:${(fraction * 100).toFixed(1)}%` }));

// --- shell ------------------------------------------------------------------------------------------------
function shell(title, content, { back, status, nav } = {}) {
  if (nav !== state.nav) return; // a newer navigation or refresh started while this page was loading
  const current = location.hash === "#/inbox" ? "#/inbox" : location.hash === "#/settings" ? "#/settings" : "#/";
  const tab = (href, label, icon) => h("a", { href, class: "tab" + (current === href ? " on" : ""), "aria-current": current === href ? "page" : null },
    h("span", { class: "tab-icon", "aria-hidden": "true" }, icon), label);
  $app.replaceChildren(
    h("header", { class: "top" },
      back ? h("a", { href: back, class: "back", "aria-label": "Back" }, "‹") : h("span", { class: "logo", "aria-hidden": "true" }, "◆"),
      h("h1", {}, title),
      h("span", { id: "worker-pill", class: "pill muted" }, "…")),
    h("main", { id: "main" }, content),
    h("nav", { class: "tabs", "aria-label": "Sections" },
      tab("#/", "Projects", "▤"), tab("#/inbox", "Inbox", "✉"), tab("#/settings", "Settings", "⚙")));
  refreshWorkerPill(status);
}

async function refreshWorkerPill(known) {
  const pill = document.getElementById("worker-pill");
  if (!pill) return;
  try {
    const s = known || await api("/v1/status");
    pill.textContent = s.workers_online ? "Mac online" : "Mac offline";
    pill.className = `pill ${s.workers_online ? "ok" : "warn"}`;
    pill.title = s.workers_online ? "A Mac worker checked in within the last 2 minutes" : "No Mac worker has checked in for 2 minutes. Jobs wait in the queue.";
  } catch { pill.textContent = "Offline"; pill.className = "pill warn"; }
}

function poll(fn, ms) {
  clearTimeout(state.timer);
  const route = state.route;
  state.timer = setTimeout(async () => {
    if (state.route !== route) return; // the user moved on; that page sets its own polling
    if (document.visibilityState === "visible") await fn(); else poll(fn, ms);
  }, ms);
}

// --- projects -------------------------------------------------------------------------------------------
async function projectsPage(nav) {
  const list = h("div", { class: "list", "aria-live": "polite" }, h("p", { class: "muted" }, "Loading projects…"));
  const name = h("input", { id: "new-project", name: "name", placeholder: "e.g. Market Mocha interview", maxlength: "120", required: true, autocomplete: "off" });
  const client = h("input", { id: "new-client", name: "client", placeholder: "Client (optional)", maxlength: "120", autocomplete: "off" });
  const form = h("form", { class: "card form", onsubmit: async (e) => {
    e.preventDefault();
    const p = await run(() => api("/v1/projects", { method: "POST", idempotencyKey: `prj-${crypto.randomUUID()}`, body: { name: name.value, client: client.value } }));
    if (p) location.hash = `#/project/${p.id}`;
  } }, h("label", { for: "new-project" }, "New project"), name, client, h("button", { class: "btn primary", type: "submit" }, "Create project"));
  shell("Menapoly Cue", [form, h("h2", {}, "Projects"), list], { nav });
  const projects = await run(() => api("/v1/projects"));
  if (!projects) return;
  list.replaceChildren(...(projects.length ? projects.map((p) => h("a", { class: "card project", href: `#/project/${p.id}` },
    h("strong", {}, p.name), p.client ? h("span", { class: "muted" }, p.client) : null,
    h("span", { class: "meta" }, `${p.source_count} file${p.source_count === 1 ? "" : "s"} · ${p.output_count} export${p.output_count === 1 ? "" : "s"}`,
      p.active_jobs ? h("span", { class: "pill accent" }, `${p.active_jobs} working`) : null),
    h("span", { class: "meta" }, `Updated ${ago(p.updated_at)}`))) : [h("p", { class: "empty" }, "No projects yet. Create one, then upload footage from your phone.")]));
}

// --- one project ------------------------------------------------------------------------------------------
async function projectPage(id, nav) {
  const [data, status] = await Promise.all([run(() => api(`/v1/projects/${id}`)), api("/v1/status").catch(() => null)]);
  if (!data) { shell("Project", h("p", { class: "empty" }, "This project could not be loaded."), { back: "#/", nav }); return; }
  const { project, assets, jobs, versions, review_links, feedback } = data;
  const sources = assets.filter((a) => a.kind === "source" && a.status === "ready");
  const exports = assets.filter((a) => a.kind === "output" && a.status === "ready" && a.media_type === "video");
  const active = jobs.some((j) => ["queued", "leased", "running", "awaiting_authorization"].includes(j.status));
  const workerOnline = Boolean(status?.workers_online);
  const reviewOn = status?.public_review === "enabled";

  const uploadsBox = h("div", { class: "uploads", "aria-live": "polite" });
  const picker = h("input", { type: "file", id: "file-input", multiple: true, class: "visually-hidden",
    accept: "video/*,audio/*,image/*,.mov,.mp4,.m4a,.wav,.pdf,.txt,.md,.docx,.srt,.vtt",
    onchange: () => { for (const f of picker.files) startUpload(id, f, uploadsBox); picker.value = ""; } });
  const resumable = ((await pendingUploads()) || []).filter((u) => u.projectId === id && u.session && ![...state.uploads.values()].some((x) => x.key === u.key));
  renderUploads(uploadsBox, id);

  const sec = (title, ...body) => h("section", { class: "card" }, h("h2", {}, title), ...body);
  const assetRow = (a) => h("li", { class: "row" },
    h("div", { class: "grow" }, h("strong", { class: "name" }, a.name), h("span", { class: "meta" }, `${a.media_type} · ${fmtBytes(a.size)} · ${ago(a.created_at)}`)),
    h("div", { class: "actions" },
      ["video", "audio"].includes(a.media_type) ? button("Preview", () => preview(a)) : null,
      ["video", "audio"].includes(a.media_type) ? button("Transcribe", () => submitJob(id, { type: "transcribe", asset_id: a.id })) : null,
      ["video", "audio"].includes(a.media_type) ? button("Suggest edit", () => submitJob(id, { type: "auto_edit", asset_id: a.id }), "btn primary") : null));

  const jobRow = (j) => {
    const [label, tone] = STATUS[j.status] || [j.status, "muted"];
    const live = ["leased", "running"].includes(j.status);
    return h("li", { class: "row job", "data-status": j.status },
      h("div", { class: "grow" },
        h("strong", {}, JOB_LABEL[j.type] || j.type, " ", h("span", { class: `pill ${tone}` }, label)),
        live || j.status === "queued" ? h("span", { class: "meta" }, j.stage || (j.status === "queued" ? (workerOnline ? "Next in line" : "Your Mac is offline. This starts when it reconnects.") : "")) : null,
        live ? progressBar(j.progress, `${JOB_LABEL[j.type]} progress`) : null,
        live && j.progress != null ? h("span", { class: "meta" }, `${Math.round(j.progress * 100)}% of this stage, measured on the Mac`) : null,
        h("span", { class: "meta" }, j.started_at ? `${live ? "Running for" : "Took"} ${elapsed(j.started_at, live ? null : j.finished_at)}` : `Requested ${ago(j.created_at)}`,
          j.attempts > 1 ? ` · attempt ${j.attempts} of ${j.max_attempts}` : ""),
        j.error ? h("span", { class: "error" }, j.error) : null),
      h("div", { class: "actions" },
        ["queued", "leased", "running", "awaiting_authorization"].includes(j.status) ? button("Cancel", () => run(() => api(`/v1/jobs/${j.id}/cancel`, { method: "POST" }), "Cancelled").then(() => route())) : null,
        ["failed", "dead", "cancelled"].includes(j.status) ? button("Retry", () => run(() => api(`/v1/jobs/${j.id}/retry`, { method: "POST" }), "Queued again").then(() => route())) : null));
  };

  const versionRow = (v) => {
    const preset = h("select", { "aria-label": `Export format for edit ${v.number}` }, PRESETS.map(([k, l]) => h("option", { value: k }, l)));
    return h("li", { class: "row" },
      h("div", { class: "grow" }, h("strong", {}, `Edit ${v.number}: ${v.label}`, " ",
        h("span", { class: `pill ${v.status === "approved" ? "ok" : v.status === "rejected" ? "muted" : "warn"}` }, v.status === "proposed" ? "Needs your approval" : v.status)),
        h("span", { class: "meta" }, `Proposed ${ago(v.created_at)}`), h("div", { class: "clips", id: `clips-${v.id}` })),
      h("div", { class: "actions" },
        button("Details", () => showVersion(v.id)),
        v.status === "proposed" ? button("Approve", () => decide(v.id, "approved"), "btn primary") : null,
        v.status === "proposed" ? button("Reject", () => decide(v.id, "rejected")) : null,
        v.status === "approved" ? preset : null,
        v.status === "approved" ? button("Export", () => submitJob(id, { type: "render", version_id: v.id, preset: preset.value }), "btn primary") : null));
  };

  const exportRow = (a) => h("li", { class: "row" },
    h("div", { class: "grow" }, h("strong", { class: "name" }, a.name), h("span", { class: "meta" }, `${fmtBytes(a.size)} · ${ago(a.created_at)} · checksum verified`)),
    h("div", { class: "actions" }, button("Play", () => preview(a)), button("Download", () => download(a)),
      reviewOn ? button("Share for review", () => shareDialog(id, a), "btn primary") : null));

  const linkRow = (l) => h("li", { class: "row" },
    h("div", { class: "grow" }, h("strong", {}, l.label), h("span", { class: "meta" },
      l.active ? `Active until ${fmtTime(l.expires_at)}${l.allow_download ? " · download allowed" : ""}` : l.revoked_at ? "Turned off" : "Expired")),
    l.active ? button("Turn off", () => run(() => api(`/v1/review-links/${l.id}`, { method: "DELETE" }), "Link turned off").then(() => route())) : null);

  const budgetLeft = Math.max(0, project.budget_usd - project.spent_usd);
  shell(project.name, [
    sec("Upload footage",
      h("p", { class: "muted" }, "Original quality, straight to private storage. Large files continue where they stopped if the connection drops."),
      h("label", { for: "file-input", class: "btn primary block" }, "Choose files"), picker,
      resumable.length ? h("div", { class: "notice" }, h("strong", {}, "Unfinished uploads"),
        ...resumable.map((u) => h("p", {}, `${u.name} (${fmtBytes(u.size)}): choose the same file again to continue.`))) : null,
      uploadsBox),
    sec("Files", sources.length ? h("ul", { class: "rows" }, sources.map(assetRow)) : h("p", { class: "empty" }, "No files yet.")),
    sec("Work", jobs.length ? h("ul", { class: "rows" }, jobs.slice(0, 15).map(jobRow)) : h("p", { class: "empty" }, "Nothing requested yet. Choose a file and tap Suggest edit.")),
    sec("Edits", versions.length ? h("ul", { class: "rows" }, versions.map(versionRow))
      : h("p", { class: "empty" }, "Suggested edits appear here for your approval. Nothing is exported until you approve it.")),
    sec("Finished videos", exports.length ? h("ul", { class: "rows" }, exports.map(exportRow)) : h("p", { class: "empty" }, "Approved edits you export appear here.")),
    review_links.length ? sec("Review links", h("ul", { class: "rows" }, review_links.map(linkRow))) : null,
    feedback.length ? sec("Client feedback", h("ul", { class: "rows" }, feedback.map((f) => h("li", { class: "row" },
      h("div", { class: "grow" }, h("strong", {}, f.author, " ", h("span", { class: `pill ${f.kind === "approved" ? "ok" : f.kind === "changes_requested" ? "warn" : "muted"}` },
        f.kind === "approved" ? "Approved" : f.kind === "changes_requested" ? "Changes requested" : "Comment")),
        f.body ? h("p", {}, f.body) : null, h("span", { class: "meta" }, `${f.at_seconds != null ? `at ${f.at_seconds.toFixed(1)}s · ` : ""}${ago(f.created_at)}`)))))) : null,
    sec("AI budget", h("p", {}, `$${project.spent_usd.toFixed(2)} spent of $${project.budget_usd.toFixed(2)} ($${budgetLeft.toFixed(2)} left).`),
      h("p", { class: "muted" }, "Your Mac's pipeline doesn't call paid AI services, so its jobs cost nothing here. Cloud processing is off.")),
  ], { back: "#/", status, nav });
  if (nav !== state.nav) return;
  if (active || state.uploads.size) poll(() => route(), 4000); else poll(() => route(), 30000);
}

async function submitJob(projectId, body) {
  const job = await run(() => api(`/v1/projects/${projectId}/jobs`, { method: "POST", idempotencyKey: `job-${crypto.randomUUID()}`, body }), "Sent to your Mac");
  if (job) route();
}
async function decide(versionId, decision) {
  await run(() => api(`/v1/versions/${versionId}/decision`, { method: "POST", body: { decision } }), decision === "approved" ? "Approved. You can export it now." : "Rejected");
  route();
}
async function showVersion(id) {
  const v = await run(() => api(`/v1/versions/${id}`));
  const box = document.getElementById(`clips-${id}`);
  if (!v || !box) return;
  const clips = v.timeline.clips || [];
  const total = clips.reduce((s, c) => s + (c.end - c.start), 0);
  box.replaceChildren(h("p", { class: "meta" }, `${clips.length} clip${clips.length === 1 ? "" : "s"}, ${elapsed(0, total)} total`),
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
  if (r) location.href = r.url;
}
function shareDialog(projectId, asset) {
  const hours = h("select", { id: "link-hours" }, [["24", "1 day"], ["72", "3 days"], ["168", "7 days"], ["336", "14 days"]].map(([v, l]) => h("option", { value: v, selected: v === "72" }, l)));
  const allow = h("input", { type: "checkbox", id: "link-download" });
  const label = h("input", { id: "link-label", value: "Client review", maxlength: "120" });
  const out = h("div", { "aria-live": "polite" });
  dialog("Share for review", h("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault();
    const link = await run(() => api(`/v1/projects/${projectId}/review-links`, { method: "POST", body: { asset_id: asset.id, hours: Number(hours.value), allow_download: allow.checked, label: label.value } }));
    if (!link) return;
    const url = new URL(link.path, location.origin).toString();
    out.replaceChildren(h("p", {}, "Anyone with this link can watch this one video and leave feedback until it expires. It's shown only now."),
      h("input", { class: "copy", readonly: true, value: url, "aria-label": "Review link", onfocus: (ev) => ev.target.select() }),
      h("div", { class: "actions" }, button("Copy link", () => navigator.clipboard.writeText(url).then(() => toast("Copied"))),
        navigator.share ? button("Share…", () => navigator.share({ title: "Video for review", url }).catch(() => {})) : null));
  } }, h("label", { for: "link-label" }, "Name"), label, h("label", { for: "link-hours" }, "Expires after"), hours,
    h("label", { class: "check" }, allow, " Allow the client to download"), h("button", { class: "btn primary", type: "submit" }, "Create link"), out));
}
function dialog(title, ...content) {
  const d = h("dialog", { class: "sheet", "aria-label": title },
    h("div", { class: "sheet-head" }, h("h2", {}, title), button("Close", () => d.close(), "btn ghost")), ...content);
  d.addEventListener("close", () => { d.querySelectorAll("video,audio").forEach((m) => m.pause()); d.remove(); });
  document.body.append(d);
  d.showModal();
}

// --- uploads UI -------------------------------------------------------------------------------------------
function startUpload(projectId, file, box) {
  const id = crypto.randomUUID();
  const u = { id, key: `${projectId}:${file.name}:${file.size}:${file.lastModified}`, projectId, file, phase: "checking", fraction: 0, message: "Starting", controller: new AbortController() };
  state.uploads.set(id, u);
  const go = () => {
    u.controller = new AbortController();
    u.phase = "checking"; u.error = null;
    uploadFile(projectId, file, (s) => { Object.assign(u, s); renderUploads(document.querySelector(".uploads"), projectId); }, u.controller.signal)
      .then(() => { u.phase = "done"; toast(`${file.name} uploaded`); setTimeout(() => { state.uploads.delete(id); if (location.hash === `#/project/${projectId}`) route(); }, 1200); })
      .catch((e) => { u.phase = e.name === "AbortError" ? "paused" : "error"; u.error = e.name === "AbortError" ? null : e.message; renderUploads(document.querySelector(".uploads"), projectId); });
  };
  u.resume = go;
  go();
  renderUploads(box, projectId);
}
function renderUploads(box, projectId) {
  if (!box) return;
  const mine = [...state.uploads.values()].filter((u) => u.projectId === projectId);
  box.replaceChildren(...mine.map((u) => h("div", { class: "upload", "data-phase": u.phase },
    h("div", { class: "row" }, h("strong", { class: "name grow" }, u.file.name), h("span", { class: "meta" }, fmtBytes(u.file.size))),
    progressBar(u.phase === "done" ? 1 : u.fraction, `Upload of ${u.file.name}`),
    h("span", { class: "meta" }, u.phase === "paused" ? "Paused" : u.phase === "error" ? `Stopped: ${u.error}` :
      `${u.message || ""}${u.fraction != null && u.phase !== "done" ? ` · ${Math.floor(u.fraction * 100)}%` : ""}`),
    h("div", { class: "actions" },
      ["uploading", "checking", "waiting"].includes(u.phase) ? button("Pause", () => u.controller.abort()) : null,
      ["paused", "error"].includes(u.phase) ? button("Resume", () => u.resume(), "btn primary") : null))));
}

// --- inbox ------------------------------------------------------------------------------------------------
async function inboxPage(nav) {
  const list = h("div", { class: "list", "aria-live": "polite" }, h("p", { class: "muted" }, "Loading…"));
  shell("Inbox", [h("div", { class: "actions end" }, button("Mark all read", () => run(() => api("/v1/notifications/read", { method: "POST" })).then(() => route()))), list], { nav });
  const data = await run(() => api("/v1/notifications"));
  if (!data) return;
  list.replaceChildren(...(data.items.length ? data.items.map((n) => h("a", { class: "card note" + (n.read_at ? "" : " unread"), href: n.href || "#/" },
    h("strong", {}, n.title), n.body ? h("span", {}, n.body) : null, h("span", { class: "meta" }, ago(n.created_at), n.emailed_at ? " · emailed" : "")))
    : [h("p", { class: "empty" }, "Nothing new. You'll see finished jobs, failures and client feedback here.")]));
  poll(() => route(), 15000);
}

// --- settings ---------------------------------------------------------------------------------------------
async function settingsPage(nav) {
  const me = state.me || {};
  const sections = [h("section", { class: "card" }, h("h2", {}, "Account"), h("p", {}, `Signed in as ${me.email || "?"} (${me.role || "?"}).`),
    me.environment === "development" ? h("p", { class: "notice" }, "Local development mode: sign-in is simulated on this computer only.") : null)];
  const status = await run(() => api("/v1/status"));
  const costs = await run(() => api("/v1/costs"));
  if (costs) sections.push(h("section", { class: "card" }, h("h2", {}, `Costs for ${costs.month}`),
    costs.by_kind.length ? h("ul", { class: "rows" }, costs.by_kind.map((k) => h("li", { class: "row" }, h("span", { class: "grow" }, k.kind), h("strong", {}, `$${k.usd.toFixed(2)}`))))
      : h("p", {}, "No recorded spending this month."),
    h("p", { class: "meta" }, `Stored media: ${costs.storage_gb.toFixed(2)} GB (about $${costs.storage_estimate_usd_month.toFixed(2)}/month at R2 list prices; first 10 GB free).`),
    h("p", { class: "meta" }, `Cloud processing: ${costs.cloud_rendering === "enabled" ? "enabled (each paid job still needs your authorization)" : "off"}.`)));
  if (me.role === "owner") {
    const workers = await run(() => api("/v1/workers"));
    const name = h("input", { id: "worker-name", placeholder: "e.g. Studio iMac", maxlength: "80", required: true });
    const tokenBox = h("div", { "aria-live": "polite" });
    sections.push(h("section", { class: "card" }, h("h2", {}, "Mac workers"),
      h("p", { class: "muted" }, "Your Mac connects out to Menapoly Cue. Nothing on your network is opened to the internet."),
      h("ul", { class: "rows" }, (workers || []).filter((w) => !w.revoked_at).map((w) => h("li", { class: "row" },
        h("div", { class: "grow" }, h("strong", {}, w.name, " ", h("span", { class: `pill ${w.online ? "ok" : "warn"}` }, w.online ? "Online" : "Offline")),
          h("span", { class: "meta" }, `Last check-in ${ago(w.last_seen_at)}${w.version ? ` · v${w.version}` : ""}`)),
        button("Remove", () => confirm(`Remove ${w.name}? Its token stops working immediately.`) && run(() => api(`/v1/workers/${w.id}`, { method: "DELETE" }), "Removed").then(() => route()))))),
      h("form", { class: "form", onsubmit: async (e) => {
        e.preventDefault();
        const w = await run(() => api("/v1/workers", { method: "POST", body: { name: name.value } }));
        if (w) tokenBox.replaceChildren(h("p", { class: "notice" }, "Copy this token into the Mac worker setup now. It won't be shown again."),
          h("input", { class: "copy", readonly: true, value: w.token, "aria-label": "Worker token", onfocus: (ev) => ev.target.select() }),
          button("Copy token", () => navigator.clipboard.writeText(w.token).then(() => toast("Copied"))));
      } }, h("label", { for: "worker-name" }, "Add a Mac"), name, h("button", { class: "btn", type: "submit" }, "Create worker token")), tokenBox));
  }
  if (status) sections.push(h("section", { class: "card" }, h("h2", {}, "System"),
    h("p", { class: "meta" }, `Client review links: ${status.public_review === "enabled" ? "on" : "off"}.`),
    h("p", { class: "meta" }, `Environment: ${status.environment}. Jobs: ${Object.entries(status.jobs).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}.`)));
  shell("Settings", sections, { nav });
}

// --- router -------------------------------------------------------------------------------------------------
async function route() {
  const hash = location.hash || "#/";
  clearTimeout(state.timer);
  state.route = hash;
  const nav = ++state.nav;
  const m = /^#\/project\/(prj_[0-9a-f]{16})$/.exec(hash);
  if (m) return projectPage(m[1], nav);
  if (hash === "#/inbox") return inboxPage(nav);
  if (hash === "#/settings") return settingsPage(nav);
  return projectsPage(nav);
}

async function boot() {
  try {
    state.me = await api("/v1/me");
  } catch (e) {
    $app.replaceChildren(h("main", { class: "center" }, h("h1", {}, "Menapoly Cue"), h("p", { role: "alert" }, e.message),
      e.status === 403 ? h("p", { class: "muted" }, "This account isn't on the list of people allowed in.") : button("Try again", () => location.reload(), "btn primary")));
    return;
  }
  addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") route(); });
  route();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
