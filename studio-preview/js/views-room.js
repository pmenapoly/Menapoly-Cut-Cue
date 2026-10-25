// Project Workspace and the Editing Room (one per video).
// State per video (tab, version, playhead) is remembered so actions and Maven never lose the viewer's place.
import { h, icon, toast, sheet, empty, ago, avatar, statusTone, demoBadge, fmtDate, bytes, kindIcon, copyText } from "./ui.js";
import { svc } from "./service.js";
import { REQUEST_TYPES, EXPORT_PRESETS, CHECKLIST_SECTIONS } from "./data.js";
import { createPlayer, fmtTime, setSources } from "./player.js";
import { openMaven } from "./maven.js";
import { composer } from "./views-home.js";

const typeLabel = (id) => REQUEST_TYPES.find((t) => t.id === id)?.label || id;
const presetLabel = (id) => EXPORT_PRESETS.find((p) => p.id === id);
const STAGES = ["Submitted", "Assigned", "In progress", "In review", "Approved"];
// Per person and video: { tab, version, time, filter, mine, allVersions }. Switching people never inherits another's view.
const store = new Map();
const key = (vid) => `${svc.me().id}:${vid}`;
const memo = { get: (vid) => store.get(key(vid)) };
const remember = (vid, patch) => store.set(key(vid), { ...(store.get(key(vid)) || {}), ...patch });
const plain = { "Ready for review": "Ready for you to review", "Changes requested": "Back with the editor for changes", "Approved": "Approved and ready to use",
  "Being edited": "The editor is working on it", "Waiting to start": "Waiting for the editor to start" };

/* ============================== Project Workspace ============================== */
export async function projectView(out, [pid], ctx) {
  const me = svc.me();
  const [p, videos] = await Promise.all([svc.project(pid), svc.videos()]);
  const vids = videos.filter((v) => v.projectId === pid);
  const editors = svc.users().filter((u) => u.role === "editor");
  const people = svc.users().filter((u) => u.role === "admin" || p.editorIds.includes(u.id) || (u.role === "client" && u.workspaceIds.includes(p.ws)));
  const stage = Math.max(0, ...p.requests.map((r) => STAGES.indexOf(r.status === "Revision" ? "In progress" : r.status)));
  out.append(
    h("a", { href: "#studio", class: "small back-link" }, icon("back", 16), "Media Studio"),
    h("header", { class: "stack", style: "gap:6px" }, h("span", { class: "eyebrow" }, p.workspace), h("h1", {}, p.name),
      h("div", { class: "row" }, h("span", { class: `chip ${statusTone(p.status)}` }, p.status), h("span", { class: "chip" }, icon("clock", 14), `Due ${fmtDate(p.due)}`),
        h("span", { class: "chip" }, `${p.revisionLimit} revisions included`))),
    h("ol", { class: "stepper", "aria-label": "Project progress" }, STAGES.map((s, i) => h("li", { class: i < stage ? "done" : i === stage ? "now" : "" }, h("span", {}, s)))),
    h("section", { class: "stack" }, h("div", { class: "section-head" }, h("h2", {}, `Videos (${vids.length})`),
      me.role !== "editor" ? h("a", { class: "btn sm", href: `#request-new-${p.id}` }, icon("plus", 16), "Request a video") : null),
      vids.length ? h("div", { class: "tiles" }, vids.map((v) => h("a", { class: "tile", href: `#video-${v.id}` },
        h("span", { class: "poster" }, h("img", { src: v.poster, alt: "", loading: "lazy" }), h("span", { class: "chip" }, v.versions ? `v${v.versions}` : "Original")),
        h("b", {}, v.title), h("span", {}, `${v.status} · ${v.done}/${v.tasks} tasks`))))
        : empty("No videos yet", "Videos appear here once footage is uploaded for this project.")),
    h("div", { class: "split" },
      h("section", { class: "stack", style: "gap:14px" }, h("h2", {}, "Editing requests"),
        p.requests.length ? p.requests.map((r) => requestCard(r, p, me, editors, ctx)) : empty("No requests yet", "Ask for an edit to get started.")),
      h("aside", { class: "stack", style: "gap:14px" },
        h("section", { class: "card" }, h("h2", {}, "Collaborators"), h("ul", { class: "list" }, people.map((u) => h("li", { class: "item" }, avatar(u.name, true),
          h("span", { class: "grow" }, h("span", { class: "title small" }, u.name), h("span", { class: "tiny faint" }, u.role === "client" ? "Client" : u.role === "editor" ? "Editor" : "Menapoly producer")))))),
        h("section", { class: "card" }, h("h2", {}, "Files"), p.assets.length ? h("ul", { class: "list" }, p.assets.map((a) => h("li", {}, h("a", { class: "item", href: a.videoId ? `#video-${a.videoId}` : `#asset-${a.id}` },
          h("span", { class: "thumb" }, a.mediaInfo?.poster ? h("img", { src: a.mediaInfo.poster, alt: "" }) : icon(kindIcon(a.kind), 22)),
          h("span", { class: "grow" }, h("span", { class: "title small" }, a.name), h("span", { class: "tiny faint" }, `${bytes(a.size)} · ${ago(a.at)}`))))))
          : h("p", { class: "muted small" }, "No files yet.")),
        h("section", { class: "card" }, h("h2", {}, "Brief"), h("p", { class: "small" }, p.brief)))));
}

function requestCard(r, p, me, editors, ctx) {
  const assign = h("select", { id: `assign-${r.id}`, "aria-label": "Assign editor", style: "width:auto;flex:1 1 160px" },
    h("option", { value: "" }, "Choose editor"), editors.map((e) => h("option", { value: e.id, selected: e.id === r.assigneeId }, e.name)));
  return h("article", { class: "card" },
    h("div", { class: "section-head" }, h("h3", {}, r.title), h("span", { class: `chip ${statusTone(r.status)}` }, r.status)),
    h("p", { class: "small faint" }, `${typeLabel(r.type)} · ${r.aspect || "—"} · ${r.length || "—"} · ${svc.userName(r.by)} · ${ago(r.at)}`),
    h("p", { class: "small" }, r.brief),
    h("p", { class: "tiny faint" }, `Revisions used: ${r.revisionsUsed} of ${p.revisionLimit}`),
    h("div", { class: "actions" },
      me.role === "admin" ? [assign, h("button", { class: "btn sm", onclick: async () => { try { await svc.assignRequest(r.id, assign.value); toast("Editor assigned"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Assign")] : null,
      me.role === "editor" && r.assigneeId === me.id && /assigned|submitted|revision/i.test(r.status) ? h("button", { class: "btn primary sm", onclick: async () => {
        try { await svc.startRequest(r.id); toast("Marked in progress"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Start editing") : null));
}

/* ============================== Editing Room ============================== */
export async function roomView(out, [vid], ctx) {
  const v = await svc.video(vid), me = svc.me();
  const m = memo.get(vid) || {};
  let version = Math.min(m.version ?? v.versions.length - 1, v.versions.length - 1), tab = m.tab || (v.status === "Ready for review" ? "comments" : "instructions");
  let active = null;
  const cur = () => v.versions[version];
  const commentsFor = () => v.comments.filter((c) => (m.allVersions ? true : c.version === cur().n));

  const player = createPlayer({ media: cur(), label: `${v.title}, ${cur().label}`,
    markers: () => v.comments.filter((c) => c.version === cur().n).map((c) => ({ id: c.id, t: c.t, resolved: c.resolved, label: `Comment at ${fmtTime(c.t)}: ${c.body}` })),
    onMarker: (cid) => focusComment(cid), onTime: (t) => remember(vid, { time: t }) });
  player.annotate.showShapes((t) => v.comments.filter((c) => c.version === cur().n && c.shape && (Math.abs(c.t - t) < 0.6 || c.id === active)).map((c) => ({ shape: c.shape, active: c.id === active })));
  if (m.time) player.video.addEventListener("loadedmetadata", () => { player.video.currentTime = m.time; }, { once: true });

  // ---- header ----
  const header = h("header", { class: "room-head" },
    h("a", { href: `#project-${v.projectId}`, class: "small back-link" }, icon("back", 16), v.projectName),
    h("div", { class: "row nowrap", style: "align-items:flex-start" },
      h("div", { class: "stack", style: "gap:4px;flex:1;min-width:0" }, h("h1", { class: "room-title" }, v.title),
        h("p", { class: "small faint" }, `${v.workspace} · ${v.projectName}`)),
      h("button", { class: "iconbtn", "aria-label": "More actions", onclick: () => actionsSheet(v, ctx) }, icon("more", 24))),
    h("div", { class: "row" }, h("span", { class: `chip ${statusTone(v.status)}`, "data-status": v.status }, v.status),
      h("span", { class: "chip" }, avatar(v.editorName, true), `Editor: ${v.editorName}`)));

  // ---- under the player ----
  const versionSel = h("select", { id: "version-select", "aria-label": "Version", style: "width:auto;flex:1 1 180px" },
    v.versions.map((x, i) => h("option", { value: String(i), selected: i === version }, x.n === 0 ? x.label : `${x.label}${i === v.versions.length - 1 ? " (latest)" : ""}`)));
  versionSel.addEventListener("change", () => { version = Number(versionSel.value); remember(vid, { version }); player.setMedia(cur(), `${v.title}, ${cur().label}`); drawTab(); player.refresh(); });
  const tools = h("div", { class: "row" }, versionSel,
    v.versions.length > 1 ? h("button", { class: "btn sm", onclick: () => compareSheet(v, version) }, icon("compare", 16), "Compare with original") : null,
    h("button", { class: "btn sm", onclick: () => sheet("Transcript", h("div", { class: "state" }, icon("doc", 28), h("h3", {}, "No transcript for this video"),
      h("p", { class: "muted small" }, "This demo clip has no speech. When a real video is processed, the transcript appears here with timecodes you can tap.")),
      h("p", { class: "tiny faint" }, "Transcripts come from the editing engine; the preview never invents one.")) }, icon("doc", 16), "Transcript"));

  // ---- status / decision card ----
  const statusCard = h("section", { class: "card status-card" });
  function drawStatus() {
    statusCard.replaceChildren(h("div", { class: "row" }, h("span", { class: "eyebrow" }, "Where it stands"), h("span", { class: `chip ${statusTone(v.status)}` }, v.status)),
      h("p", {}, plain[v.status] || v.status));
    if (v.status === "Ready for review" && v.can["review.decide"]) {
      const note = h("textarea", { id: "changes-note", placeholder: "What should be different in the next version?", maxlength: "2000" });
      const form = h("div", { class: "stack", hidden: true }, h("label", { for: "changes-note" }, "What should change?"), note,
        h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: async () => {
          try { await svc.decide(v.reviewId, "changes", note.value); toast("Changes requested. The editor has been told."); ctx.refresh(); } catch (e) { toast(e.message, "err"); note.focus(); } } }, "Send to the editor"),
          h("button", { class: "btn ghost", onclick: () => openMaven(ctx, "Help me request changes") }, icon("spark", 16), "Help me write it")));
      statusCard.append(h("p", { class: "small faint" }, `Revisions used: ${v.revisionsUsed} of ${v.revisionLimit}`),
        h("div", { class: "actions" },
          h("button", { class: "btn ok", onclick: async () => { try { await svc.decide(v.reviewId, "approve"); toast("Approved. It's ready to share."); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } },
            icon("check", 18), "Approve video"),
          h("button", { class: "btn", onclick: () => { form.hidden = !form.hidden; if (!form.hidden) note.focus(); } }, icon("message", 18), "Request changes")), form);
    } else if (v.status === "Approved") {
      const d = v.decisions.filter((x) => /approved/i.test(x.action)).pop();
      statusCard.append(d ? h("p", { class: "small faint" }, `Approved ${ago(d.at)} by ${d.byName}`) : null,
        h("h3", {}, "What's next"), nextActions(v, ctx, true));
    } else if (v.can["review.upload_version"]) {
      const vn = h("input", { id: "version-note", placeholder: "What changed in this version?" });
      statusCard.append(h("label", { for: "version-note" }, "Submit a new version"), vn,
        h("button", { class: "btn", onclick: async () => { try { await svc.uploadVersion(v.reviewId, vn.value); remember(vid, { version: undefined }); toast("New version submitted (simulated)"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } },
          icon("upload", 18), "Upload new version"), h("p", { class: "tiny" }, demoBadge(), " The preview reuses a demo clip; nothing is uploaded or rendered."));
    }
    const done = v.checklist.filter((t) => t.done).length;
    statusCard.append(h("div", { class: "row small faint" }, `Checklist: ${done} of ${v.checklist.length} done`),
      h("div", { class: "progress", "aria-label": `${done} of ${v.checklist.length} checklist tasks done` }, h("span", { style: `width:${(done / Math.max(1, v.checklist.length)) * 100}%` })));
  }

  // ---- tabs ----
  const TABS = [["instructions", "Instructions"], ["comments", `Comments (${v.comments.filter((c) => !c.resolved).length})`], ["versions", `Versions (${v.versions.length})`], ["files", "Files"], ["activity", "Activity"]];
  const tabBar = h("div", { class: "tabs room-tabs", role: "tablist", "aria-label": "Editing Room" });
  const panel = h("div", { class: "stack room-panel", role: "tabpanel" });
  function drawTab() {
    remember(vid, { tab });
    tabBar.replaceChildren(...TABS.map(([k, l]) => h("button", { class: "tab", role: "tab", id: `tab-${k}`, "aria-selected": String(tab === k), onclick: () => { tab = k; drawTab(); } }, l)));
    panel.setAttribute("aria-labelledby", `tab-${tab}`);
    panel.replaceChildren(...({ instructions, comments, versions, files, activity }[tab])());
  }

  function instructions() {
    const i = v.instructions;
    const mine = memo.get(vid)?.mine;
    const tasks = v.checklist.filter((t) => !mine || t.owner === me.id);
    return [
      h("section", { class: "card" }, h("h2", {}, "The brief"), h("p", {}, i.brief),
        h("h3", {}, "Brand guidelines"), h("ul", { class: "bullets" }, i.brand.map((b) => h("li", {}, b))),
        h("h3", {}, "Deliverables"), h("ul", { class: "bullets" }, i.deliverables.map((d) => h("li", {}, h("b", {}, d.label), h("span", { class: "small faint" }, ` · ${presetLabel(d.preset)?.spec || ""}`)))),
        h("div", { class: "grid-2" }, h("div", {}, h("h3", {}, "Look"), h("p", { class: "small" }, i.visual)), h("div", {}, h("h3", {}, "Sound"), h("p", { class: "small" }, i.audio))),
        h("h3", {}, "Captions"), h("p", { class: "small" }, i.captions),
        h("button", { class: "btn sm ghost", onclick: () => openMaven(ctx, "Explain the editing instructions") }, icon("spark", 16), "Explain this in plain words")),
      h("section", { class: "card" },
        h("div", { class: "section-head" }, h("h2", {}, "Editing checklist"), h("span", { class: "small faint" }, `${v.checklist.filter((t) => t.done).length} of ${v.checklist.length} done`)),
        v.checklist.some((t) => t.owner === me.id) ? h("label", { class: "check", for: "mine-only" }, h("input", { type: "checkbox", id: "mine-only", checked: Boolean(mine),
          onchange: (e) => { remember(vid, { mine: e.target.checked }); drawTab(); } }), "Only my tasks") : null,
        v.can["checklist.update"] ? null : h("p", { class: "small muted", id: "task-ro" }, "The editing team ticks these off. You can follow progress and leave a note on any task."),
        ...CHECKLIST_SECTIONS.map((sec) => { const items = tasks.filter((t) => t.section === sec); return items.length ? h("div", { class: "stack" }, h("h3", { class: "task-section" }, sec), items.map(taskRow)) : null; })),
    ];
  }
  function taskRow(t) {
    const noteBox = h("form", { class: "row nowrap", hidden: true, onsubmit: async (e) => { e.preventDefault();
      try { await svc.noteTask(vid, t.id, noteBox.querySelector("input").value); toast("Note added"); ctx.refresh(); } catch (err) { toast(err.message, "err"); } } },
      h("input", { id: `note-${t.id}`, placeholder: "Add a note", "aria-label": `Note on: ${t.text}` }), h("button", { class: "btn sm", type: "submit" }, "Add"));
    return h("div", { class: `task ${t.done ? "done" : ""}`, "data-task": t.id },
      h("label", { class: "task-main", for: `task-${t.id}` },
        h("input", { type: "checkbox", id: `task-${t.id}`, checked: t.done, disabled: !v.can["checklist.update"], "aria-describedby": v.can["checklist.update"] ? null : "task-ro",
          onchange: async (e) => { try { await svc.toggleTask(vid, t.id, e.target.checked); toast(e.target.checked ? "Task done" : "Task reopened"); ctx.refresh(); } catch (err) { e.target.checked = !e.target.checked; toast(err.code === 403 ? "Only the editing team can tick tasks." : err.message, "err"); } } }),
        h("span", { class: "grow" }, h("span", { class: "task-text" }, t.text),
          h("span", { class: "tiny faint" }, [`${t.ownerName}`, t.src ? `source ${t.src}` : null, t.out ? `output ${t.out}` : null, t.done ? `done by ${t.doneByName} ${ago(t.doneAt)}` : null].filter(Boolean).join(" · ")))),
      t.notes.length ? h("div", { class: "replies" }, t.notes.map((n) => h("div", { class: "small" }, h("b", {}, n.byName), ` ${n.body}`))) : null,
      v.can["checklist.comment"] ? h("button", { class: "btn ghost sm", onclick: () => { noteBox.hidden = !noteBox.hidden; if (!noteBox.hidden) noteBox.querySelector("input").focus(); } }, icon("message", 14), t.notes.length ? `Notes (${t.notes.length})` : "Add note") : null,
      noteBox);
  }

  // comments + annotation composer
  const body = h("textarea", { id: "annotation-body", placeholder: "What should change at this moment?", maxlength: "2000" });
  const where = h("p", { class: "small" });
  const composerBox = h("div", { class: "card composer-card", hidden: true });
  const toolBtn = (k, label, ic) => h("button", { class: "tool", "aria-pressed": "false", "data-tool": k, onclick: (e) => {
    const on = player.annotate.tool() === k ? null : k; player.annotate.setTool(on);
    composerBox.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === on)));
    if (on) toast(on === "rect" ? "Drag on the video to mark an area" : "Draw on the video"); void e; } }, icon(ic, 20), label);
  const updateWhere = () => where.replaceChildren(icon("clock", 16), ` At ${fmtTime(player.time())} on ${cur().label}`, player.annotate.draft() ? " · area marked" : "");
  player.el.addEventListener("draft", updateWhere);
  composerBox.append(h("h3", {}, "Add a comment"), where,
    h("div", { class: "tools", role: "group", "aria-label": "Mark the frame" }, toolBtn("rect", "Box", "box"), toolBtn("pen", "Draw", "pen"),
      h("button", { class: "tool", onclick: () => { player.annotate.clear(); updateWhere(); } }, icon("x", 20), "Clear")),
    h("label", { for: "annotation-body", class: "sr" }, "Comment"), body,
    h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: async () => {
      try {
        const c = await svc.addComment(v.reviewId, { version: cur().n, t: player.time(), shape: player.annotate.draft(), body: body.value });
        player.annotate.clear(); player.annotate.setTool(null); remember(vid, { tab: "comments", time: player.time() }); active = c.id; toast("Comment added"); ctx.refresh();
      } catch (e) { toast(e.message, "err"); } } }, icon("send", 18), "Send comment"),
      h("button", { class: "btn ghost", onclick: () => { composerBox.hidden = true; player.annotate.setTool(null); player.annotate.clear(); } }, "Cancel")));
  const openComposer = () => { player.pause(); tab = "comments"; drawTab(); composerBox.hidden = false; updateWhere(); body.focus({ preventScroll: true }); player.el.scrollIntoView({ block: "start" }); };

  function comments() {
    const f = memo.get(vid)?.filter || "open";
    const list = commentsFor().filter((c) => f === "all" || (f === "open" ? !c.resolved : f === "resolved" ? c.resolved : c.assigneeId === me.id)).sort((a, b) => a.version - b.version || a.t - b.t);
    return [
      v.can["review.comment"] ? h("button", { class: "btn primary block", onclick: openComposer }, icon("message", 18), `Comment at ${fmtTime(player.time())}`) : null,
      h("div", { class: "tabs", role: "group", "aria-label": "Filter comments" }, [["open", "Open"], ["resolved", "Resolved"], ["mine", "Assigned to me"], ["all", "All"]].map(([k, l]) =>
        h("button", { class: `tab ${f === k ? "on" : ""}`, "aria-pressed": String(f === k), onclick: () => { remember(vid, { filter: k }); drawTab(); } }, l))),
      h("label", { class: "check", for: "all-versions" }, h("input", { type: "checkbox", id: "all-versions", checked: Boolean(memo.get(vid)?.allVersions),
        onchange: (e) => { remember(vid, { allVersions: e.target.checked }); m.allVersions = e.target.checked; drawTab(); } }), "Show comments from every version"),
      ...(list.length ? list.map(commentCard) : [h("p", { class: "muted small" }, f === "open" ? "No open comments on this version." : "Nothing here.")]),
    ];
  }
  function commentCard(c) {
    const reply = h("input", { id: `reply-${c.id}`, placeholder: "Reply", "aria-label": `Reply to ${c.byName}` });
    const assign = v.can["review.assign"] ? h("select", { id: `assign-c-${c.id}`, "aria-label": "Assign this feedback", style: "width:auto;flex:1 1 150px",
      onchange: async (e) => { try { await svc.assignComment(v.reviewId, c.id, e.target.value); toast(e.target.value ? "Feedback assigned" : "Unassigned"); ctx.refresh(); } catch (err) { toast(err.message, "err"); } } },
      h("option", { value: "" }, "Not assigned"), v.team.map((u) => h("option", { value: u.id, selected: u.id === c.assigneeId }, u.name))) : null;
    const mayResolve = me.role === "admin" || (me.role === "editor" && v.can["review.upload_version"]) || c.by === me.id;
    const vLabel = c.version === 0 ? "Original" : `v${c.version}`;
    return h("article", { class: `note ${c.id === active ? "active" : ""} ${c.resolved ? "resolved" : ""}`, "data-id": c.id },
      h("div", { class: "row" }, avatar(c.byName, true), h("b", { class: "small" }, c.byName),
        h("button", { class: "ts", onclick: () => focusComment(c.id), "aria-label": `Go to ${fmtTime(c.t)} on ${vLabel}` }, fmtTime(c.t)),
        h("span", { class: "chip" }, vLabel), c.shape ? h("span", { class: "chip" }, icon(c.shape.type === "rect" ? "box" : "pen", 13), "marked") : null,
        c.resolved ? h("span", { class: "chip ok" }, "Resolved") : null),
      h("p", {}, c.body),
      c.assigneeName ? h("p", { class: "tiny" }, h("span", { class: "chip info" }, `For ${c.assigneeName}`)) : null,
      c.replies.length ? h("div", { class: "replies" }, c.replies.map((x) => h("div", { class: "small" }, h("b", {}, x.byName), ` ${x.body}`))) : null,
      h("form", { class: "row nowrap", onsubmit: async (e) => { e.preventDefault();
        try { await svc.reply(v.reviewId, c.id, reply.value); toast("Reply added"); ctx.refresh(); } catch (err) { toast(err.message, "err"); } } }, reply, h("button", { class: "btn sm", type: "submit" }, "Reply")),
      h("div", { class: "actions" }, assign,
        mayResolve ? h("button", { class: "btn sm", onclick: async () => { try { await svc.resolve(v.reviewId, c.id, !c.resolved); toast(c.resolved ? "Reopened" : "Resolved"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } },
          icon(c.resolved ? "refresh" : "check", 16), c.resolved ? "Reopen" : "Resolve") : null));
  }
  function focusComment(cid) {
    const c = v.comments.find((x) => x.id === cid); if (!c) return;
    const vi = v.versions.findIndex((x) => x.n === c.version);
    if (vi >= 0 && vi !== version) { version = vi; versionSel.value = String(vi); player.setMedia(cur(), `${v.title}, ${cur().label}`); player.video.addEventListener("loadedmetadata", () => player.seek(c.t), { once: true }); }
    active = cid; player.seek(c.t); tab = "comments"; drawTab();
    panel.querySelector(`[data-id="${cid}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function versions() {
    return [
      h("section", { class: "card" }, h("h2", {}, "Versions"), h("ul", { class: "list" }, [...v.versions].reverse().map((x) => {
        const i = v.versions.indexOf(x);
        return h("li", { class: "item" }, h("span", { class: "thumb" }, h("img", { src: x.poster, alt: "" })),
          h("span", { class: "grow" }, h("span", { class: "title small" }, x.label, i === v.versions.length - 1 ? " · latest" : ""),
            h("span", { class: "tiny faint" }, x.n === 0 ? x.note : `${x.note || ""} · ${x.byName} · ${ago(x.at)}${x.simulated ? " · simulated" : ""}`)),
          i === version ? h("span", { class: "chip accent" }, "Watching") : h("button", { class: "btn sm", onclick: () => { version = i; versionSel.value = String(i); remember(vid, { version }); player.setMedia(cur(), `${v.title}, ${cur().label}`); drawTab(); } }, "Watch"));
      }))),
      h("section", { class: "card" }, h("h2", {}, "Approval"), h("p", {}, h("span", { class: `chip ${statusTone(v.status)}` }, v.status)),
        v.decisions.length ? h("ul", { class: "list" }, [...v.decisions].reverse().map((d) => h("li", { class: "item small" }, h("span", { class: "grow" },
          h("span", {}, h("b", {}, d.byName), ` ${d.action.toLowerCase()}`, d.detail ? `: ${d.detail}` : ""), h("span", { class: "tiny faint" }, ago(d.at))))))
          : h("p", { class: "muted small" }, "No decisions yet.")),
    ];
  }
  function files() {
    return [h("section", { class: "card" }, h("h2", {}, "Files"), v.files.length ? h("ul", { class: "list" }, v.files.map((f) => h("li", { class: "item" },
      h("span", { class: "thumb" }, f.mediaInfo?.poster ? h("img", { src: f.mediaInfo.poster, alt: "" }) : icon(kindIcon(f.kind), 22)),
      h("span", { class: "grow" }, h("span", { class: "title small" }, f.name), h("span", { class: "tiny faint" }, `${f.projectId ? "Project file" : "Brand file"} · ${bytes(f.size)} · ${ago(f.at)}`)),
      h("button", { class: "btn sm", disabled: true, title: "Downloads are off in the preview" }, icon("download", 14), "Download")))) : h("p", { class: "muted small" }, "No files."),
      h("p", { class: "tiny faint" }, "Downloads are switched off in the preview."))];
  }
  function activity() {
    return [h("section", { class: "card" }, h("h2", {}, "Activity"), h("ul", { class: "list" }, v.activity.map((a) => h("li", { class: "item small" },
      h("span", { class: "grow" }, h("span", {}, h("b", {}, a.byName), ` ${a.action}`, a.detail ? `: ${a.detail}` : ""), h("span", { class: "tiny faint" }, new Date(a.at).toLocaleString()))))))];
  }

  drawStatus(); drawTab();
  out.append(header, h("div", { class: "room" },
    // The comment composer sits right under the player so the drawing tools and the frame stay together on a phone.
    h("div", { class: "room-main stack" }, player.el, composerBox, tools, statusCard),
    h("div", { class: "room-side stack" }, tabBar, panel)));
  const onChanged = () => { if (location.hash === `#video-${vid}`) ctx.refresh(); };
  document.addEventListener("cue:changed", onChanged, { once: true });
}

/* ---------- contextual actions ---------- */
function actionList(v, ctx) {
  const approved = v.reviewStatus === "Approved";
  const later = "Available once the video is approved.";
  return [
    { k: "cue", title: "Create with Cue", text: "Get ideas for new content from this video.", show: true, run: () => openMaven(ctx, "Turn this video into a content idea") },
    { k: "another", title: "Make another version", text: "Ask the editor for a different cut, length or format.", show: v.can["video.another"], run: () => anotherSheet(v, ctx) },
    { k: "translate", title: "Translate video", text: "Request captions in another language. An editor or translator makes them; the preview can't translate.", show: v.can["video.translate"], run: () => translateSheet(v, ctx) },
    { k: "library", title: "Add to sharing library", text: "Make it available to share across your team.", show: v.can["video.library"], off: !approved && later,
      run: async () => { try { await svc.videoAction(v.id, "library"); toast("Added to the sharing library"); } catch (e) { toast(e.message, "err"); } } },
    { k: "social", title: "Share on social", text: "Draft captions for each channel. Nothing is posted from the preview.", show: v.can["video.share"], off: !approved && later,
      run: () => { const a = v.files.find((f) => f.videoId === v.id && f.channel) || v.files.find((f) => f.videoId === v.id); composer({ id: v.ws }, ctx, { assetId: a?.id }); } },
    { k: "feed", title: "Add to feed", text: "Post it to your workspace feed so the team sees it.", show: v.can["video.feed"], run: () => feedSheet(v, ctx) },
    { k: "link", title: "Copy video link", text: "Private links arrive with the live version of Cue. The preview has no shareable address yet.", show: true, off: "Not available in the preview." },
    { k: "template", title: "Make a template", text: "Save these instructions and settings to reuse. Footage and client details are never included.", show: v.can["template.create"], run: () => templateSheet(v, ctx) },
    { k: "download", title: "Download", text: "Save the video file.", show: v.can["video.download"], off: "Downloads are switched off in the preview." },
  ].filter((a) => a.show);
}
function actionTile(a, close) {
  return h("button", { class: "action-tile", disabled: Boolean(a.off), "data-action": a.k, onclick: () => { close?.(); a.run?.(); } },
    h("b", {}, a.title), h("span", {}, a.off ? `${a.text} ${a.off}` : a.text));
}
function nextActions(v, ctx) {
  return h("div", { class: "action-grid" }, actionList(v, ctx).filter((a) => ["social", "library", "another", "template"].includes(a.k)).map((a) => actionTile(a)),
    h("button", { class: "action-tile", onclick: () => actionsSheet(v, ctx) }, h("b", {}, "All actions"), h("span", {}, "Translate, add to feed, copy link and more.")));
}
function actionsSheet(v, ctx) {
  const d = sheet("What you can do with this video", h("div", { class: "action-grid" }, actionList(v, ctx).map((a) => actionTile(a, () => d.close()))));
}

function anotherSheet(v, ctx) {
  const change = h("textarea", { id: "another-change", placeholder: "e.g. A 30-second vertical cut for Reels", maxlength: "2000" });
  const fmt = h("select", { id: "another-format" }, ["9:16", "16:9", "1:1", "4:5"].map((a) => h("option", {}, a)));
  const d = sheet("Make another version", h("div", { class: "field" }, h("label", { for: "another-change" }, "What should be different?"), change),
    h("div", { class: "field" }, h("label", { for: "another-format" }, "Shape"), fmt),
    h("button", { class: "btn primary", onclick: async () => {
      try { const r = await svc.videoAction(v.id, "another", { change: change.value.trim() || "see notes", aspect: fmt.value }); d.close(); toast(`Requested: ${r.title}`); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Send request"));
}
function translateSheet(v, ctx) {
  const lang = h("select", { id: "translate-lang" }, ["Spanish", "French", "Portuguese", "German", "Arabic"].map((l) => h("option", {}, l)));
  const d = sheet("Translate video", h("p", { class: "small muted" }, "Automatic translation isn't available yet. This sends a request for translated captions to the editing team."),
    h("div", { class: "field" }, h("label", { for: "translate-lang" }, "Language"), lang),
    h("button", { class: "btn primary", onclick: async () => {
      try { const r = await svc.videoAction(v.id, "translate", { language: lang.value }); d.close(); toast(`Requested: ${r.title}`); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Request translated captions"));
}
function feedSheet(v, ctx) {
  const text = h("textarea", { id: "feed-text", maxlength: "500" }, `${v.title} is ready. Have a look!`);
  const d = sheet("Add to feed", h("div", { class: "field" }, h("label", { for: "feed-text" }, "Message"), text),
    h("button", { class: "btn primary", onclick: async () => { try { await svc.videoAction(v.id, "feed", { text: text.value }); d.close(); toast("Added to the feed"); } catch (e) { toast(e.message, "err"); } } }, "Add to feed"));
}
function templateSheet(v, ctx) {
  const name = h("input", { id: "template-name", placeholder: "e.g. Product launch hero", maxlength: "80" });
  const parts = [["instructions", "Editing instructions (look, sound, captions)"], ["outputs", "Output formats"], ["brand", "Brand settings"], ["checklist", "Checklist"]];
  const checks = Object.fromEntries(parts.map(([k]) => [k, h("input", { type: "checkbox", id: `tpl-${k}`, checked: true })]));
  const preview = h("div", { class: "card flat small" });
  const draw = () => preview.replaceChildren(h("b", {}, "Will be saved"), h("ul", { class: "bullets" },
    checks.instructions.checked ? h("li", {}, `Look: ${v.instructions.visual}`) : null, checks.instructions.checked ? h("li", {}, `Sound: ${v.instructions.audio}`) : null,
    checks.outputs.checked ? h("li", {}, `Outputs: ${v.instructions.deliverables.map((d) => presetLabel(d.preset)?.label).join(", ")}`) : null,
    checks.brand.checked ? h("li", {}, `Brand: ${v.instructions.brand.length} rules`) : null,
    checks.checklist.checked ? h("li", {}, `Checklist: ${v.checklist.length} tasks (not their progress)`) : null),
    h("p", { class: "tiny faint" }, `Never saved: footage, files, comments, or the names “${v.workspace}” and “${v.projectName}” (replaced with neutral words).`));
  Object.values(checks).forEach((c) => c.addEventListener("change", draw)); draw();
  const d = sheet("Make a template", h("div", { class: "field" }, h("label", { for: "template-name" }, "Template name"), name),
    h("fieldset", { class: "stack", style: "border:0;padding:0;margin:0" }, h("legend", { style: "font-weight:600;font-size:14px" }, "Include"),
      parts.map(([k, l]) => h("label", { class: "check", for: `tpl-${k}` }, checks[k], l))), preview,
    h("button", { class: "btn primary", onclick: async () => {
      try { await svc.saveTemplate(v.id, { name: name.value, include: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.checked])) });
        d.close(); toast("Template saved. Find it in Media Studio → Templates."); } catch (e) { toast(e.message, "err"); name.focus(); } } }, "Save template"));
  setTimeout(() => name.focus(), 50);
}

function compareSheet(v, version) {
  const a = v.versions[0], b = v.versions[version > 0 ? version : v.versions.length - 1];
  const va = h("video", { playsinline: true, muted: true, preload: "metadata", "aria-label": a.label }), vb = h("video", { playsinline: true, muted: true, preload: "metadata", "aria-label": b.label });
  setSources(va, a); setSources(vb, b);
  const both = (fn) => [va, vb].forEach(fn);
  sheet(`Compare: ${a.label} and ${b.label}`, h("div", { class: "compare" }, [[va, a], [vb, b]].map(([el, x]) => h("figure", { style: "margin:0;display:grid;gap:6px" }, el, h("figcaption", { class: "small faint" }, x.label)))),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", onclick: () => { const t = va.currentTime; both((x) => { x.currentTime = t; x.play().catch(() => {}); }); } }, icon("play", 18), "Play both"),
      h("button", { class: "btn", onclick: () => both((x) => x.pause()) }, icon("pause", 18), "Pause"),
      h("button", { class: "btn", onclick: () => both((x) => { x.pause(); x.currentTime = 0; }) }, "Restart")));
}
