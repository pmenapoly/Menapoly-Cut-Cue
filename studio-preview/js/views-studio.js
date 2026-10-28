// Media Studio: projects, editing requests, project detail, media detail, library and the request form.
import { h, icon, toast, sheet, empty, ago, bytes, kindIcon, statusTone, statusInfo, statusBadge, demoBadge, fmtDate, avatar, initials, busy } from "./ui.js";
import { svc } from "./service.js";
import { REQUEST_TYPES, EXPORT_PRESETS } from "./data.js";
import { mediaTile, composer, wsPicker, uploaderFilter, filterUploads } from "./views-home.js";
import { uploadSheet, draftItem } from "./views-draft.js";

const mem = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { return null; } return v; };
const typeLabel = (id) => REQUEST_TYPES.find((t) => t.id === id)?.label || id;
const STAGES = ["Submitted", "Assigned", "In progress", "In review", "Approved"];

export async function studioView(out, [forced], ctx) {
  const me = svc.me();
  if (forced) mem("cue-studio-tab", forced);
  const boardLabel = me.role === "admin" ? "Production board" : me.role === "editor" ? "My queue" : null;
  let tab = mem("cue-studio-tab") || "projects"; if (tab === "board" && !boardLabel) tab = "projects";
  // Drafts (rooms with no editing request yet) belong to the client side: never shown to editors or on the board.
  const [projects, requests, videos, drafts] = await Promise.all([svc.projects(), svc.requests(), svc.videos(), me.role === "editor" ? [] : svc.drafts()]);
  out.append(
    h("div", { class: "section-head" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "Media Studio"), h("h1", {}, "Production"))),
    h("div", { class: "studio-actions" },
      me.role !== "editor" ? h("a", { class: "btn primary", href: "#request-new" }, icon("plus", 18), "New editing request") : null,
      me.role !== "editor" ? h("button", { class: "btn sky", id: "upload-brief", onclick: () => uploadSheet(ctx) }, icon("upload", 18), "Upload & brief")
        : h("a", { class: "btn sky", href: "#library", "aria-label": "Upload footage" }, icon("upload", 18), "Upload", h("span", { class: "wide-only" }, " footage"))),
    h("div", { class: "tabs wrap", role: "tablist", "aria-label": "Studio" }, [["projects", "Projects"], ...(boardLabel ? [["board", boardLabel]] : []), ["requests", "Requests"], ["templates", "Templates"], ["presets", "Export presets"]].map(([k, l]) =>
      h("button", { class: "tab", role: "tab", "aria-selected": String(tab === k), onclick: () => { mem("cue-studio-tab", k); ctx.refresh(); } }, l))));
  if (tab === "projects") {
    const q = (mem("cue-studio-q") || "").toLowerCase(), only = mem("cue-studio-status") || "all", view = mem("cue-studio-view") || "gallery";
    const info = Object.fromEntries(projects.map((p) => {
      const vids = videos.filter((v) => v.projectId === p.id), review = vids.find((v) => /review/i.test(v.status)), lead = review || vids[0];
      const st = review ? review.status : p.status, done = vids.reduce((n, v) => n + v.done, 0), tasks = vids.reduce((n, v) => n + v.tasks, 0);
      return [p.id, { st: statusInfo(st), poster: lead?.poster, done, tasks, vids }];
    }));
    const counts = {}; projects.forEach((p) => { const t = info[p.id].st.tone; counts[t] = (counts[t] || 0) + 1; });
    const shown = projects.filter((p) => (only === "all" || info[p.id].st.tone === only) && (!q || `${p.name} ${p.brief}`.toLowerCase().includes(q)))
      .sort((a, b) => (info[b.id].st.tone === "review") - (info[a.id].st.tone === "review"));
    const search = h("input", { id: "studio-search", type: "search", value: mem("cue-studio-q") || "", placeholder: "Find a project", "aria-label": "Find a project",
      onchange: (e) => { mem("cue-studio-q", e.target.value.trim()); ctx.refresh(); } });
    const toneLabel = { review: "to review", editing: "being edited", changes: "with changes", waiting: "not started", done: "completed" };
    out.append(
      drafts.length ? h("section", { class: "card", "aria-label": "Drafts, not submitted" },
        h("div", { class: "section-head" }, h("h2", {}, `Drafts · not submitted (${drafts.length})`)),
        h("p", { class: "tiny faint" }, "Editing Rooms opened by an upload. Nothing is in production until an editing request is submitted."),
        h("ul", { class: "list" }, drafts.map((d) => draftItem(d)))) : null,
      h("div", { class: "search" }, icon("search", 18), search),
      h("div", { class: "status-filters", role: "group", "aria-label": "Filter by status" },
        h("button", { "data-tone": "all", "aria-pressed": String(only === "all"), onclick: () => { mem("cue-studio-status", null); ctx.refresh(); } }, `All ${projects.length}`),
        Object.keys(toneLabel).filter((t) => counts[t]).map((t) => h("button", { "data-tone": t, "aria-pressed": String(only === t), onclick: () => { mem("cue-studio-status", only === t ? null : t); ctx.refresh(); } },
          `${counts[t]} ${toneLabel[t]}`))),
      h("div", { class: "section-head", style: "align-items:center" }, h("p", { class: "small faint" }, only === "all" && !q ? `${projects.length} project(s)` : `${shown.length} of ${projects.length} project(s)`),
        h("div", { class: "seg", role: "group", "aria-label": "View" },
          h("button", { "aria-pressed": String(view === "gallery"), onclick: () => { mem("cue-studio-view", "gallery"); ctx.refresh(); } }, icon("grid", 16), "Gallery"),
          h("button", { "aria-pressed": String(view === "list"), onclick: () => { mem("cue-studio-view", "list"); ctx.refresh(); } }, icon("layers", 16), "List"))),
      shown.length ? h("div", { class: `projects ${view === "list" ? "list" : ""}` }, shown.map((p, i) => projectCard(p, info[p.id], i === 0 && info[p.id].st.tone === "review")))
        : projects.length ? empty("No projects match", "Try another status or search.", h("button", { class: "btn", onclick: () => { mem("cue-studio-q", null); mem("cue-studio-status", null); ctx.refresh(); } }, "Clear filters"))
        : empty("No projects", me.role === "editor" ? "You'll see projects here once you're assigned." : "Send an editing request to start one."));
  } else if (tab === "board") {
    out.append(await boardView(me, ctx));
  } else if (tab === "requests") {
    out.append(requests.length ? h("section", { class: "card" }, h("ul", { class: "list" }, requests.map((r) => h("li", {}, h("a", { class: "item", href: `#project-${r.projectId}` },
      h("span", { class: "thumb" }, icon("pen", 22)),
      h("span", { class: "grow" }, h("span", { class: "title" }, r.title), h("span", { class: "small faint" }, `${typeLabel(r.type)} · ${r.projectName} · ${r.assignee ? r.assignee : "unassigned"}`)),
      h("span", { class: `chip ${statusTone(r.status)}` }, r.status))))))
      : empty("No requests yet", "Editing requests you can see appear here.", me.role !== "editor" ? h("a", { class: "btn primary", href: "#request-new" }, "New editing request") : null));
  } else if (tab === "templates") {
    const ws = svc.currentWs();
    const list = ws ? await svc.templates(ws.id).catch((e) => (e.code === 403 ? [] : Promise.reject(e))) : [];
    out.append(h("p", { class: "muted" }, "Reusable editing instructions, formats, brand settings and checklists. Make one from any video's More actions. Templates never include footage or client details."),
      list.length ? h("div", { class: "grid-2" }, list.map((t) => h("article", { class: "card" },
        h("div", { class: "section-head" }, h("h2", {}, t.name), h("span", { class: "tiny faint" }, `${t.byName} · ${ago(t.at)}`)),
        h("ul", { class: "bullets small" },
          t.instructions.visual ? h("li", {}, `Look: ${t.instructions.visual}`) : null, t.instructions.audio ? h("li", {}, `Sound: ${t.instructions.audio}`) : null,
          t.instructions.captions ? h("li", {}, `Captions: ${t.instructions.captions}`) : null,
          t.outputs.length ? h("li", {}, `Outputs: ${t.outputs.map((o) => EXPORT_PRESETS.find((x) => x.id === o)?.label).join(", ")}`) : null,
          t.brand.length ? h("li", {}, `Brand: ${t.brand.join("; ")}`) : null, t.checklist.length ? h("li", {}, `Checklist: ${t.checklist.length} tasks`) : null),
        me.role !== "editor" ? h("button", { class: "btn sm", onclick: () => { mem("cue-request-draft", JSON.stringify(templateDraft(t))); ctx.go("request-new"); } }, "Use for a new request") : null)))
        : empty("No templates yet", "Open a video and choose More actions → Make a template."));
  } else {
    out.append(h("p", { class: "muted" }, "Presets the editing engine will export to. In the preview, choosing a preset records the delivery request; no file is rendered."),
      h("div", { class: "grid-2" }, EXPORT_PRESETS.map((p) => h("div", { class: "card" }, h("h3", {}, p.label), h("p", { class: "mono small muted" }, p.spec)))));
  }
}

/** Target delivery dates are estimates. Only admins change them; the request's dueRev guards against stale overwrites. */
export function dueSheet(req, ctx) {
  const date = h("input", { id: "due-date", type: "date", value: req.due || "" });
  const why = h("input", { id: "due-reason", maxlength: "200", placeholder: "e.g. Waiting on footage from the client" });
  const d = sheet("Change target date",
    h("p", { class: "small muted" }, `“${req.title}”. Target dates are estimates, not guaranteed delivery dates. The editor and the client are told.`),
    h("div", { class: "field" }, h("label", { for: "due-date" }, "New target date"), date),
    h("div", { class: "field" }, h("label", { for: "due-reason" }, "Reason (shown in the project activity)"), why),
    (req.dueHistory || []).length ? h("details", {}, h("summary", { class: "small audit-toggle" }, `Earlier changes (${req.dueHistory.length})`),
      h("ul", { class: "list" }, [...req.dueHistory].reverse().map((x) => h("li", { class: "item small" }, `${x.from ? fmtDate(x.from) : "not set"} → ${fmtDate(x.to)} · ${x.byName || svc.userName(x.by)}${x.reason ? ` · ${x.reason}` : ""}`)))) : null,
    h("button", { class: "btn primary", onclick: busy(async () => {
      try { await svc.setDue(req.id, date.value, why.value, req.dueRev || 0); d.close(); toast("Target date changed. The editor and client have been told."); ctx.refresh(); }
      catch (e) { toast(e.message, "err"); if (e.code === 409 && /changed this date/.test(e.message)) { d.close(); ctx.refresh(); } } }) }, "Save target date"));
  setTimeout(() => date.focus(), 50);
  return d;
}

/** Admins: every request by stage, plus editor workload. Editors: their own queue. Deadlines and lateness come from the request. */
async function boardView(me, ctx) {
  const { rows, editors } = await svc.production();
  const open = rows.filter((r) => !/approved/i.test(r.status));
  const lanes = [
    ["needs", "Needs an editor", (r) => !r.assigneeId && !/approved/i.test(r.status), "waiting"],
    ["start", "Assigned, not started", (r) => r.assigneeId && /assigned|submitted/i.test(r.status), "waiting"],
    ["editing", "Being edited", (r) => /progress/i.test(r.status), "editing"],
    ["changes", "Changes requested", (r) => /revision/i.test(r.status), "changes"],
    ["review", "With the client for review", (r) => /review/i.test(r.status), "review"],
    ["done", "Approved", (r) => /approved/i.test(r.status), "done"],
  ];
  const row = (r) => h("li", { class: "board-row", "data-request": r.id }, h("a", { class: "item", href: r.videoId ? `#video-${r.videoId}` : `#project-${r.projectId}` },
    h("span", { class: "grow" }, h("span", { class: "title small" }, r.title),
      h("span", { class: "tiny faint" }, [r.workspace, r.projectName, r.assignee ? `Editor: ${r.assignee}` : "No editor", r.due ? `target ${fmtDate(r.due)}` : "no target date",
        r.tasks ? `${r.done}/${r.tasks} tasks` : null, r.open ? `${r.open} open comment(s)` : null,
        r.revisions ? `revisions ${r.revisions.used}/${r.revisions.total}` : null].filter(Boolean).join(" · "))),
    r.overdue ? h("span", { class: "status", "data-tone": "changes" }, icon("clock", 13), "Overdue") : r.atRisk ? h("span", { class: "status", "data-tone": "review" }, icon("alert", 13), "At risk") : null,
    icon("chevron", 18)),
    me.role === "admin" && !/approved/i.test(r.status) ? h("button", { class: "btn sm ghost", "aria-label": `Change target date for ${r.title}`, onclick: () => dueSheet(r, ctx) }, icon("calendar", 16), "Change date") : null);
  return h("div", { class: "stack", style: "gap:16px" },
    h("p", { class: "muted" }, me.role === "admin" ? `${open.length} open request(s) · ${open.filter((r) => r.overdue).length} overdue · ${open.filter((r) => r.atRisk).length} at risk · ${open.filter((r) => !r.assigneeId).length} waiting for an editor`
      : `${open.length} request(s) assigned to you · ${open.filter((r) => r.overdue).length} overdue · ${open.filter((r) => r.atRisk).length} at risk`),
    h("p", { class: "tiny faint" }, "Target dates are estimates. At risk = due within 3 days and not yet with the client."),
    editors.length ? h("section", { class: "card", "aria-label": "Editor workload" }, h("h2", {}, "Editor workload"),
      h("ul", { class: "list" }, editors.map((e) => h("li", { class: "item" }, avatar(e.name, true),
        h("span", { class: "grow" }, h("span", { class: "title small" }, e.name), h("span", { class: "tiny faint" }, `${e.open} open · ${e.overdue} overdue · ${e.atRisk} at risk${e.next ? ` · next target ${fmtDate(e.next)}` : ""}`)),
        h("span", { class: "status", "data-tone": e.overdue ? "changes" : e.open >= 3 || e.atRisk ? "review" : "done", "data-editor": e.id },
          e.overdue ? "Behind" : e.open >= 3 || e.atRisk ? "Busy" : "Has room"))))) : null,
    ...lanes.map(([k, label, test, tone]) => { const list = rows.filter(test); return list.length ? h("section", { class: "card", "data-lane": k },
      h("div", { class: "section-head" }, h("h2", {}, label), h("span", { class: "status", "data-tone": tone }, String(list.length))), h("ul", { class: "list" }, list.map(row))) : null; }),
    rows.length ? null : empty("Nothing in the queue", me.role === "editor" ? "New assignments appear here and in your notifications." : "New editing requests appear here."));
}

function projectCard(p, info, feature) {
  const { st, poster, done, tasks } = info, badge = () => h("span", { class: "status", "data-tone": st.tone }, icon(st.icon, 13), st.label);
  return h("a", { class: `pcard ${feature ? "feature" : ""}`, href: `#project-${p.id}`, "data-status": st.tone },
    h("span", { class: "cover" }, poster ? h("img", { src: poster, alt: "", loading: "lazy" }) : icon(st.tone === "waiting" ? "upload" : "studio", 30), badge()),
    h("span", { class: "pbody" }, badge(), h("h2", {}, p.name),
      h("span", { class: "meta" }, p.editors.length ? h("span", { class: "avatar sm", title: `Editor: ${p.editors[0]}` }, initials(p.editors[0])) : null,
        h("span", {}, `${p.editors.length ? p.editors.join(", ") : "No editor yet"} · due ${fmtDate(p.due)}`)),
      tasks ? h("span", { class: `progress ${st.tone === "done" ? "ok" : st.tone === "editing" ? "info" : ""}`, role: "img", "aria-label": `${done} of ${tasks} checklist tasks done` },
        h("span", { style: `width:${(done / tasks) * 100}%` })) : null));
}

export async function assetView(out, [aid], ctx) {
  const me = svc.me(), a = await svc.asset(aid);
  const folders = me.role === "editor" ? [] : await svc.folders(a.ws);
  const m = a.mediaInfo;
  const preview = a.kind === "video" && m ? h("div", { class: "player" }, h("video", { src: m.src, poster: m.poster || "", controls: true, playsinline: true, preload: "metadata", "aria-label": a.name }))
    : a.kind === "image" && m?.poster ? h("div", { class: "player" }, h("img", { src: m.poster, alt: a.name, style: "width:100%;display:block" }))
    : h("div", { class: "state" }, icon(kindIcon(a.kind), 36), h("h3", {}, a.name), h("p", { class: "muted small" }, a.localUrl ? "Added this session. The preview keeps only its name and size." : "Preview not available for this file type in the demo."));
  const move = h("select", { id: "move-folder", "aria-label": "Move to folder", style: "width:auto;flex:1 1 160px" }, folders.map((f) => h("option", { value: f.id, selected: f.id === a.folderId }, f.name)));
  out.append(h("a", { href: "#library", class: "small" }, "← Library"), h("h1", { style: "overflow-wrap:anywhere" }, a.name),
    h("div", { class: "split" }, preview,
      h("aside", { class: "card" },
        h("dl", { class: "stack", style: "margin:0;gap:8px" },
          ...[["Type", a.kind], ["Size", bytes(a.size)], ["Project", a.projectName || "Workspace library"], ["Added", `${ago(a.at)} by ${a.byName}`], ["Status", a.channel ? "Approved for sharing" : "Working file"]]
            .map(([k, v]) => h("div", { class: "row", style: "justify-content:space-between" }, h("dt", { class: "faint small" }, k), h("dd", { style: "margin:0;font-weight:600" }, v)))),
        h("div", { class: "row" }, a.tags.map((t) => h("span", { class: "chip" }, icon("tag", 13), t))),
        folders.length ? h("div", { class: "row" }, move, h("button", { class: "btn", onclick: async () => { try { await svc.moveAsset(a.id, move.value); toast("Moved"); } catch (e) { toast(e.message, "err"); } } }, icon("folder", 18), "Move")) : null,
        h("div", { class: "actions" },
          a.channel && me.role !== "editor" ? h("button", { class: "btn primary", onclick: () => composer({ id: a.ws }, ctx, { assetId: a.id }) }, icon("share", 18), "Draft a post") : null,
          h("button", { class: "btn", disabled: true, title: "Downloads are turned off in the preview" }, icon("download", 18), "Download (off in preview)")))));
}

export async function libraryView(out, _p, ctx) {
  const me = svc.me(), ws = svc.currentWs();
  if (!ws) { out.append(h("h1", {}, "Library"), empty("No workspace", "You'll see media once you're assigned to a project.")); return; }
  const folder = mem("cue-lib-folder") || "", kind = mem("cue-lib-kind") || "all", q = mem("cue-lib-q") || "";
  const who = mem("lib-uploads") || "all", pick = mem("lib-uploader") || "";
  const [folders, found, projects, uploaders] = await Promise.all([me.role === "editor" ? Promise.resolve([]) : svc.folders(ws.id), svc.assets({ ws: ws.id, folderId: folder || null, kind, q }), svc.projects(), svc.uploaders(ws.id)]);
  const assets = filterUploads(found, { who, pick, me });
  const search = h("input", { id: "lib-search", type: "search", value: q, placeholder: "Search files, tags and projects", "aria-label": "Search the library",
    onchange: (e) => { mem("cue-lib-q", e.target.value.trim()); ctx.refresh(); } });
  const picker = h("input", { id: "lib-file", type: "file", multiple: true, class: "sr", "aria-label": "Choose files to add",
    onchange: async (e) => {
      let files = [...e.target.files]; e.target.value = "";
      // Upload-first: video and audio open an Editing Room in a project (or stay in the library if the person chooses).
      const footage = me.role === "editor" ? [] : files.filter((f) => /^(video|audio)\//.test(f.type));
      if (footage.length) { uploadSheet(ctx, { files: footage, libraryOption: true, folderId: folder || null }); files = files.filter((f) => !footage.includes(f)); }
      if (!files.length) return;
      const errors = [];
      for (const f of files) {
        const row = h("div", { class: "card", role: "status" }, h("b", { class: "small" }, f.name), h("div", { class: "progress" }, h("span", { style: "width:0%" })), h("span", { class: "tiny faint" }, "Simulated resumable upload: nothing leaves this device"));
        queue.prepend(row);
        for (let pct = 0; pct <= 100; pct += 20) { row.querySelector(".progress span").style.width = `${pct}%`; await new Promise((r) => setTimeout(r, 90)); }
        try {
          const url = /^(video|image)\//.test(f.type) ? URL.createObjectURL(f) : null;
          await svc.addLocalFile({ name: f.name, size: f.size, type: f.type, url }, ws.id, null, folder || null);
          row.remove(); toast(`${f.name} added`);
        } catch (err) { row.remove(); errors.push(err.message); }
      }
      if (errors.length < files.length) ctx.refresh();
      errors.forEach((m) => toast(m, "err")); // errors stay on screen even when the list refreshes
    } });
  const queue = h("div", { class: "stack" });
  const kinds = [["all", "All"], ["video", "Video"], ["audio", "Audio"], ["image", "Images"], ["document", "Documents"]];
  out.append(
    h("div", { class: "section-head" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, ws.name), h("h1", {}, "Library")),
      h("div", { class: "row" }, wsPicker(() => { mem("cue-lib-folder", null); ctx.rerenderShell(); }),
        me.role !== "editor" ? h("button", { class: "btn sky", onclick: () => uploadSheet(ctx, { libraryOption: true, folderId: folder || null }) }, icon("film", 18), "Upload & brief") : null,
        h("label", { for: "lib-file", class: "btn primary", role: "button", tabindex: "0", onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } } }, icon("upload", 18), "Add files"), picker)),
    h("div", { class: "search" }, icon("search", 18), search),
    folders.length || me.role !== "editor" ? h("div", { class: "folders", role: "group", "aria-label": "Folders" },
      h("button", { class: `folder ${folder ? "" : "on"}`, "aria-pressed": String(!folder), onclick: () => { mem("cue-lib-folder", null); ctx.refresh(); } }, icon("grid", 18), "All files"),
      folders.map((f) => h("button", { class: `folder ${folder === f.id ? "on" : ""}`, "aria-pressed": String(folder === f.id), onclick: () => { mem("cue-lib-folder", f.id); ctx.refresh(); } }, icon("folder", 18), f.name)),
      me.role !== "editor" ? h("button", { class: "folder", onclick: () => newFolder(ws, ctx) }, icon("plus", 18), "New folder") : null) : null,
    h("div", { class: "tabs", role: "group", "aria-label": "File type" }, kinds.map(([k, l]) =>
      h("button", { class: `tab ${kind === k ? "on" : ""}`, "aria-pressed": String(kind === k), onclick: () => { mem("cue-lib-kind", k); ctx.refresh(); } }, l))),
    uploaderFilter({ key: "lib", who, pick, me, uploaders, ctx }),
    queue,
    h("p", { class: "small faint" }, `${assets.length} file(s)${q ? ` matching “${q}”` : ""}`),
    assets.length ? h("div", { class: "tiles" }, assets.map((a) => { const draft = a.roomId && !svc.hasVideo(a.roomId);
      return h("div", { class: "stack", style: "gap:6px", "data-asset": a.id }, mediaTile(a, draft ? "Draft · not submitted" : undefined),
        draft ? h("a", { class: "btn sm", href: `#video-${a.roomId}` }, icon("pen", 16), "Continue preparing") : null,
        folders.length ? h("button", { class: "btn sm", "aria-label": `Move ${a.name}`, onclick: () => moveSheet(a, folders, ctx) }, icon("folder", 16), "Move") : null); }))
      : folder && !q && kind === "all" ? empty("This folder is empty", "Open a file and use Move to put it here.")
      : empty(q || kind !== "all" || folder ? "Nothing matches" : "No files yet", q || kind !== "all" || folder ? "Try another search, type or folder." : "Add footage to get started.",
        q || kind !== "all" || folder || who !== "all" || pick ? h("button", { class: "btn", onclick: () => { mem("cue-lib-q", null); mem("cue-lib-kind", null); mem("cue-lib-folder", null); mem("lib-uploads", null); mem("lib-uploader", null); ctx.refresh(); } }, "Clear filters") : null));
}

function moveSheet(a, folders, ctx) {
  const sel = h("select", { id: "move-to", "aria-label": "Move to folder" }, folders.map((f) => h("option", { value: f.id, selected: f.id === a.folderId }, f.name)));
  const d = sheet(`Move ${a.name}`, h("div", { class: "field" }, h("label", { for: "move-to" }, "Folder"), sel),
    h("button", { class: "btn primary", onclick: async () => { try { await svc.moveAsset(a.id, sel.value); d.close(); toast("Moved"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Move"));
}

function newFolder(ws, ctx) {
  const name = h("input", { id: "folder-name", placeholder: "e.g. Holiday campaign", maxlength: "60" });
  const d = sheet("New folder", h("div", { class: "field" }, h("label", { for: "folder-name" }, "Folder name"), name),
    h("button", { class: "btn primary", onclick: async () => { try { const f = await svc.createFolder(ws.id, name.value); d.close(); mem("cue-lib-folder", f.id); toast("Folder created"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Create folder"));
  setTimeout(() => name.focus(), 50);
}

export function templateDraft(t) {
  const lines = [t.instructions.visual && `Look: ${t.instructions.visual}`, t.instructions.audio && `Sound: ${t.instructions.audio}`,
    t.instructions.captions && `Captions: ${t.instructions.captions}`, t.brand.length && `Brand: ${t.brand.join("; ")}`,
    t.checklist.length && `Checklist: ${t.checklist.map((c) => c.text).join("; ")}`].filter(Boolean);
  return { type: t.outputs.includes("reels") ? "short" : "promo", templateId: t.id, title: "", brief: lines.join("\n"),
    aspect: t.outputs.includes("reels") ? "9:16" : "16:9" };
}

export async function requestFormView(out, [preProject], ctx) {
  const me = svc.me();
  if (me.role === "editor") { const e = new Error("Editors can't submit editing requests."); e.code = 403; throw e; }
  const projects = (await svc.projects()).filter((p) => me.role === "admin" || p.ws === svc.currentWs()?.id);
  const draft = (() => { try { return JSON.parse(mem("cue-request-draft") || "{}"); } catch { return {}; } })();
  const val = (k, d = "") => draft[k] ?? d;
  let type = val("type", "short");
  const typeGrid = h("div", { class: "grid-2", role: "radiogroup", "aria-label": "Request type" });
  const drawTypes = () => typeGrid.replaceChildren(...REQUEST_TYPES.map((t) => h("button", { type: "button", class: "card", role: "radio", "aria-checked": String(t.id === type),
    style: `text-align:left;cursor:pointer;min-height:44px;${t.id === type ? "border-color:var(--accent);background:color-mix(in oklab,var(--accent) 14%,var(--surface))" : ""}`,
    onclick: () => { type = t.id; persist(); drawTypes(); } }, h("b", {}, t.label), h("span", { class: "small faint" }, t.hint))));
  const f = {
    project: h("select", { id: "rq-project", required: true }, projects.map((p) => h("option", { value: p.id, selected: p.id === (preProject || val("projectId")) }, `${p.name}`))),
    title: h("input", { id: "rq-title", required: true, maxlength: "120", value: val("title"), placeholder: "e.g. Three reels from the launch shoot" }),
    brief: h("textarea", { id: "rq-brief", required: true, maxlength: "4000", placeholder: "Goal, audience, must-keep moments, tone, where it will run." }, val("brief")),
    aspect: h("select", { id: "rq-aspect" }, ["16:9", "9:16", "1:1", "4:5", "16:9 + 9:16"].map((a) => h("option", { selected: a === val("aspect", "9:16") }, a))),
    length: h("input", { id: "rq-length", maxlength: "40", value: val("length"), placeholder: "e.g. 3 × 30 s" }),
    due: h("input", { id: "rq-due", type: "date", value: val("due") }),
  };
  // One key per draft: resubmitting the same draft (double tap, retry after a network blip) can't create a duplicate.
  const key = draft.key || `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let footage = new Set(draft.assetIds || []);
  const persist = () => mem("cue-request-draft", JSON.stringify({ type, projectId: f.project.value, title: f.title.value, brief: f.brief.value, aspect: f.aspect.value,
    length: f.length.value, due: f.due.value, templateId: draft.templateId || null, assetIds: [...footage], key }));
  Object.values(f).forEach((el) => el.addEventListener("input", persist));
  drawTypes();
  if (!projects.length) { out.append(h("h1", {}, "New editing request"), empty("No project to attach this to", "Ask your Menapoly producer to open a project first.")); return; }
  const ws = svc.currentWs();
  const [templates, media] = await Promise.all([ws ? svc.templates(ws.id).catch(() => []) : [], ws ? svc.assets({ ws: ws.id }) : []]);
  const usable = media.filter((a) => a.kind === "video" || a.kind === "audio" || a.kind === "image");
  const footageBox = h("fieldset", { class: "stack", style: "border:0;padding:0;margin:0;gap:6px" },
    h("legend", { style: "font-weight:650;font-size:14px;margin-bottom:6px" }, "Footage for this request"),
    usable.length ? usable.map((a) => h("label", { class: "check", for: `ft-${a.id}` }, h("input", { type: "checkbox", id: `ft-${a.id}`, checked: footage.has(a.id),
      onchange: (e) => { if (e.target.checked) footage.add(a.id); else footage.delete(a.id); persist(); } }),
      h("span", {}, h("b", {}, a.name), h("span", { class: "small faint" }, ` · ${a.kind} · ${a.byName}${a.localUrl ? " · added this session (simulated upload)" : ""}`))))
      : h("p", { class: "small muted" }, "No footage in this workspace yet. ", h("a", { href: "#library" }, "Upload it in the Library"), " first, or send the request now and add footage later."),
    h("span", { class: "hint" }, "Only files you can see in this workspace are listed."));
  const tplSel = templates.length ? h("select", { id: "rq-template", onchange: (e) => {
    const t = templates.find((x) => x.id === e.target.value); if (!t) return;
    mem("cue-request-draft", JSON.stringify({ ...templateDraft(t), projectId: f.project.value, title: f.title.value, assetIds: [...footage], key })); ctx.refresh(); toast(`Started from “${t.name}”`); } },
    h("option", { value: "" }, "No template"), templates.map((t) => h("option", { value: t.id, selected: t.id === draft.templateId }, t.name))) : null;
  out.append(h("a", { href: "#studio", class: "small" }, "← Media Studio"), h("h1", {}, "New editing request"),
    h("p", { class: "muted" }, "Tell the editor what to make. Your draft is kept on this device until you submit."),
    tplSel ? h("div", { class: "field" }, h("label", { for: "rq-template" }, "Start from a template"), tplSel) : null,
    h("form", { class: "stack", style: "gap:16px", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const btn = e.currentTarget.querySelector("[type=submit]"); if (btn.disabled) return; btn.disabled = true;
      try {
        const r = await svc.createRequest({ projectId: f.project.value, type, title: f.title.value, brief: f.brief.value, aspect: f.aspect.value, length: f.length.value, due: f.due.value,
          templateId: draft.templateId || null, assetIds: [...footage], key });
        mem("cue-request-draft", null); toast("Request submitted. Your producer has been notified."); ctx.go(`project-${r.projectId}`);
      } catch (err) { toast(err.message, "err"); (err.code === 400 ? (f.title.value.trim() ? f.brief : f.title) : f.title).focus(); } finally { btn.disabled = false; }
    } },
      h("fieldset", { class: "stack", style: "border:0;padding:0;margin:0" }, h("legend", { style: "font-weight:600;font-size:14px;margin-bottom:8px" }, "What do you need?"), typeGrid),
      h("div", { class: "field" }, h("label", { for: "rq-project" }, "Project"), f.project),
      h("div", { class: "field" }, h("label", { for: "rq-title" }, "Title"), f.title),
      h("div", { class: "field" }, h("label", { for: "rq-brief" }, "Brief"), f.brief, h("span", { class: "hint" }, "One sentence each: goal, audience, must-keep moments, deadline, where it runs.")),
      h("div", { class: "grid-2" }, h("div", { class: "field" }, h("label", { for: "rq-aspect" }, "Aspect ratio"), f.aspect), h("div", { class: "field" }, h("label", { for: "rq-length" }, "Length"), f.length)),
      h("div", { class: "field" }, h("label", { for: "rq-due" }, "Needed by"), f.due),
      footageBox,
      draft.templateId ? h("p", { class: "small" }, icon("layers", 14), ` Using the template “${templates.find((t) => t.id === draft.templateId)?.name || "saved template"}”: its checklist and instructions go into the Editing Room.`) : null,
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit" }, icon("send", 18), "Submit request"),
        h("button", { class: "btn ghost", type: "button", onclick: () => { mem("cue-request-draft", null); ctx.refresh(); } }, "Clear draft"))));
}
