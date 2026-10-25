// Media Studio: projects, editing requests, project detail, media detail, library and the request form.
import { h, icon, toast, sheet, empty, ago, bytes, kindIcon, statusTone, demoBadge, fmtDate, avatar } from "./ui.js";
import { svc } from "./service.js";
import { REQUEST_TYPES, EXPORT_PRESETS } from "./data.js";
import { mediaTile, composer, wsPicker } from "./views-home.js";

const mem = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { return null; } return v; };
const typeLabel = (id) => REQUEST_TYPES.find((t) => t.id === id)?.label || id;
const STAGES = ["Submitted", "Assigned", "In progress", "In review", "Approved"];

export async function studioView(out, _p, ctx) {
  const me = svc.me(), tab = mem("cue-studio-tab") || "projects";
  const [projects, requests] = await Promise.all([svc.projects(), svc.requests()]);
  out.append(
    h("div", { class: "section-head" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "Media Studio"), h("h1", {}, "Production")),
      me.role !== "editor" ? h("a", { class: "btn primary", href: "#request-new" }, icon("plus", 18), "New editing request") : null),
    h("div", { class: "tabs", role: "tablist", "aria-label": "Studio" }, [["projects", "Projects"], ["requests", "Requests"], ["presets", "Export presets"]].map(([k, l]) =>
      h("button", { class: "tab", role: "tab", "aria-selected": String(tab === k), onclick: () => { mem("cue-studio-tab", k); ctx.refresh(); } }, l))));
  if (tab === "projects") {
    out.append(projects.length ? h("div", { class: "grid-2" }, projects.map((p) => h("a", { class: "card", href: `#project-${p.id}`, style: "text-decoration:none;color:inherit" },
      h("div", { class: "row" }, h("span", { class: `chip ${statusTone(p.status)}` }, p.status), p.pendingReview ? h("span", { class: "chip accent" }, "Review waiting") : null),
      h("h2", {}, p.name), h("p", { class: "muted small" }, p.brief),
      h("div", { class: "row small faint" }, icon("clock", 16), `Due ${fmtDate(p.due)}`, "·", p.editors.length ? `Editor: ${p.editors.join(", ")}` : "No editor yet"))))
      : empty("No projects", me.role === "editor" ? "You'll see projects here once you're assigned." : "Send an editing request to start one."));
  } else if (tab === "requests") {
    out.append(requests.length ? h("section", { class: "card" }, h("ul", { class: "list" }, requests.map((r) => h("li", {}, h("a", { class: "item", href: `#project-${r.projectId}` },
      h("span", { class: "thumb" }, icon("pen", 22)),
      h("span", { class: "grow" }, h("span", { class: "title" }, r.title), h("span", { class: "small faint" }, `${typeLabel(r.type)} · ${r.projectName} · ${r.assignee ? r.assignee : "unassigned"}`)),
      h("span", { class: `chip ${statusTone(r.status)}` }, r.status))))))
      : empty("No requests yet", "Editing requests you can see appear here.", me.role !== "editor" ? h("a", { class: "btn primary", href: "#request-new" }, "New editing request") : null));
  } else {
    out.append(h("p", { class: "muted" }, "Presets the editing engine will export to. In the preview, choosing a preset records the delivery request; no file is rendered."),
      h("div", { class: "grid-2" }, EXPORT_PRESETS.map((p) => h("div", { class: "card" }, h("h3", {}, p.label), h("p", { class: "mono small muted" }, p.spec)))));
  }
}

export async function projectView(out, [pid], ctx) {
  const me = svc.me(), p = await svc.project(pid);
  const editors = svc.users().filter((u) => u.role === "editor");
  const head = h("div", { class: "stack", style: "gap:6px" }, h("a", { href: "#studio", class: "small" }, "← Media Studio"),
    h("span", { class: "eyebrow" }, p.workspace), h("h1", {}, p.name),
    h("div", { class: "row" }, h("span", { class: `chip ${statusTone(p.status)}` }, p.status), h("span", { class: "chip" }, icon("clock", 14), `Due ${fmtDate(p.due)}`),
      h("span", { class: "chip" }, `${p.revisionLimit} revisions included`)));
  const reqCards = p.requests.map((r) => {
    const stage = Math.max(0, STAGES.indexOf(r.status === "Revision" ? "In progress" : r.status));
    const assign = h("select", { id: `assign-${r.id}`, "aria-label": "Assign editor", style: "width:auto;flex:1 1 180px" },
      h("option", { value: "" }, "Choose editor"), editors.map((e) => h("option", { value: e.id, selected: e.id === r.assigneeId }, e.name)));
    return h("section", { class: "card" },
      h("div", { class: "section-head" }, h("h2", {}, r.title), h("span", { class: `chip ${statusTone(r.status)}` }, r.status)),
      h("p", { class: "small faint" }, `${typeLabel(r.type)} · ${r.aspect || "—"} · ${r.length || "—"} · requested by ${svc.userName(r.by)} ${ago(r.at)}`),
      h("div", { class: "stack" }, h("span", { class: "eyebrow" }, "Production brief"), h("p", {}, r.brief)),
      h("ol", { class: "steps", "aria-label": "Progress" }, STAGES.map((s, i) => h("li", { class: i < stage ? "done" : i === stage ? "now" : "" }, h("span", { class: "small" }, s)))),
      h("p", { class: "small muted" }, `Revisions used: ${r.revisionsUsed} of ${p.revisionLimit}`),
      h("div", { class: "actions" },
        me.role === "admin" ? [assign, h("button", { class: "btn", onclick: async () => { try { await svc.assignRequest(r.id, assign.value); toast("Editor assigned"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Assign")] : null,
        me.role === "editor" && /assigned|submitted|revision/i.test(r.status) && r.assigneeId === me.id ? h("button", { class: "btn primary", onclick: async () => {
          try { await svc.startRequest(r.id); toast("Marked in progress"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Start editing") : null));
  });
  const delivery = h("section", { class: "card" }, h("h2", {}, "Delivery"), h("p", { class: "small muted" }, "Choose where the approved cut should go."),
    h("div", { class: "stack" }, EXPORT_PRESETS.map((x) => h("button", { class: "btn", style: "justify-content:space-between",
      onclick: () => toast(`${x.label}: delivery request recorded (simulated, nothing rendered)`) }, h("span", {}, x.label), demoBadge()))));
  const reviewsCard = h("section", { class: "card" }, h("h2", {}, "Reviews"),
    p.reviews.length ? h("ul", { class: "list" }, p.reviews.map((r) => h("li", {}, h("a", { class: "item", href: `#review-${r.id}` },
      h("span", { class: "grow" }, h("span", { class: "title" }, r.title), h("span", { class: "small faint" }, `${r.versions.length} version(s)`)),
      h("span", { class: `chip ${statusTone(r.status)}` }, r.status))))) : h("p", { class: "muted small" }, "No cuts yet."));
  const mediaCard = h("section", { class: "card" }, h("h2", {}, "Project media"),
    p.assets.length ? h("ul", { class: "list" }, p.assets.map((a) => h("li", {}, h("a", { class: "item", href: `#asset-${a.id}` },
      h("span", { class: "thumb" }, a.mediaInfo?.poster ? h("img", { src: a.mediaInfo.poster, alt: "" }) : icon(kindIcon(a.kind), 22)),
      h("span", { class: "grow" }, h("span", { class: "title" }, a.name), h("span", { class: "small faint" }, `${bytes(a.size)} · ${ago(a.at)}`)))))) : h("p", { class: "muted small" }, "No media yet."));
  const briefCard = h("section", { class: "card" }, h("h2", {}, "Project brief"), h("p", {}, p.brief),
    h("div", { class: "row small faint" }, "Team:", p.editors.length ? p.editors.map((n) => h("span", { class: "chip" }, avatar(n, true), n)) : "No editor assigned"));
  out.append(head, h("div", { class: "split" },
    h("div", { class: "stack", style: "gap:14px" }, briefCard, ...reqCards,
      me.role !== "editor" ? h("a", { class: "btn", href: `#request-new-${p.id}` }, icon("plus", 18), "Add a request to this project") : null),
    h("aside", { class: "stack", style: "gap:14px" }, reviewsCard, mediaCard, delivery)));
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
  const [folders, assets, projects] = await Promise.all([me.role === "editor" ? Promise.resolve([]) : svc.folders(ws.id), svc.assets({ ws: ws.id, folderId: folder || null, kind, q }), svc.projects()]);
  const search = h("input", { id: "lib-search", type: "search", value: q, placeholder: "Search files, tags and projects", "aria-label": "Search the library",
    onchange: (e) => { mem("cue-lib-q", e.target.value.trim()); ctx.refresh(); } });
  const picker = h("input", { id: "lib-file", type: "file", multiple: true, class: "sr", "aria-label": "Choose files to add",
    onchange: async (e) => {
      const files = [...e.target.files]; e.target.value = "";
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
        h("label", { for: "lib-file", class: "btn primary", role: "button", tabindex: "0", onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } } }, icon("upload", 18), "Add files"), picker)),
    h("div", { class: "search" }, icon("search", 18), search),
    folders.length || me.role !== "editor" ? h("div", { class: "folders", role: "group", "aria-label": "Folders" },
      h("button", { class: `folder ${folder ? "" : "on"}`, "aria-pressed": String(!folder), onclick: () => { mem("cue-lib-folder", null); ctx.refresh(); } }, icon("grid", 18), "All files"),
      folders.map((f) => h("button", { class: `folder ${folder === f.id ? "on" : ""}`, "aria-pressed": String(folder === f.id), onclick: () => { mem("cue-lib-folder", f.id); ctx.refresh(); } }, icon("folder", 18), f.name)),
      me.role !== "editor" ? h("button", { class: "folder", onclick: () => newFolder(ws, ctx) }, icon("plus", 18), "New folder") : null) : null,
    h("div", { class: "tabs", role: "group", "aria-label": "File type" }, kinds.map(([k, l]) =>
      h("button", { class: `tab ${kind === k ? "on" : ""}`, "aria-pressed": String(kind === k), onclick: () => { mem("cue-lib-kind", k); ctx.refresh(); } }, l))),
    queue,
    h("p", { class: "small faint" }, `${assets.length} file(s)${q ? ` matching “${q}”` : ""}`),
    assets.length ? h("div", { class: "tiles" }, assets.map(mediaTile))
      : folder && !q && kind === "all" ? empty("This folder is empty", "Open a file and use Move to put it here.")
      : empty(q || kind !== "all" || folder ? "Nothing matches" : "No files yet", q || kind !== "all" || folder ? "Try another search, type or folder." : "Add footage to get started.",
        q || kind !== "all" || folder ? h("button", { class: "btn", onclick: () => { mem("cue-lib-q", null); mem("cue-lib-kind", null); mem("cue-lib-folder", null); ctx.refresh(); } }, "Clear filters") : null));
}

function newFolder(ws, ctx) {
  const name = h("input", { id: "folder-name", placeholder: "e.g. Holiday campaign", maxlength: "60" });
  const d = sheet("New folder", h("div", { class: "field" }, h("label", { for: "folder-name" }, "Folder name"), name),
    h("button", { class: "btn primary", onclick: async () => { try { const f = await svc.createFolder(ws.id, name.value); d.close(); mem("cue-lib-folder", f.id); toast("Folder created"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, "Create folder"));
  setTimeout(() => name.focus(), 50);
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
  const persist = () => mem("cue-request-draft", JSON.stringify({ type, projectId: f.project.value, title: f.title.value, brief: f.brief.value, aspect: f.aspect.value, length: f.length.value, due: f.due.value }));
  Object.values(f).forEach((el) => el.addEventListener("input", persist));
  drawTypes();
  if (!projects.length) { out.append(h("h1", {}, "New editing request"), empty("No project to attach this to", "Ask your Menapoly producer to open a project first.")); return; }
  out.append(h("a", { href: "#studio", class: "small" }, "← Media Studio"), h("h1", {}, "New editing request"),
    h("p", { class: "muted" }, "Tell the editor what to make. Your draft is kept on this device until you submit."),
    h("form", { class: "stack", style: "gap:16px", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await svc.createRequest({ projectId: f.project.value, type, title: f.title.value, brief: f.brief.value, aspect: f.aspect.value, length: f.length.value, due: f.due.value });
        mem("cue-request-draft", null); toast("Request submitted. Your producer has been notified."); ctx.go(`project-${r.projectId}`);
      } catch (err) { toast(err.message, "err"); (err.code === 400 ? (f.title.value.trim() ? f.brief : f.title) : f.title).focus(); }
    } },
      h("fieldset", { class: "stack", style: "border:0;padding:0;margin:0" }, h("legend", { style: "font-weight:600;font-size:14px;margin-bottom:8px" }, "What do you need?"), typeGrid),
      h("div", { class: "field" }, h("label", { for: "rq-project" }, "Project"), f.project),
      h("div", { class: "field" }, h("label", { for: "rq-title" }, "Title"), f.title),
      h("div", { class: "field" }, h("label", { for: "rq-brief" }, "Brief"), f.brief, h("span", { class: "hint" }, "One sentence each: goal, audience, must-keep moments, deadline, where it runs.")),
      h("div", { class: "grid-2" }, h("div", { class: "field" }, h("label", { for: "rq-aspect" }, "Aspect ratio"), f.aspect), h("div", { class: "field" }, h("label", { for: "rq-length" }, "Length"), f.length)),
      h("div", { class: "field" }, h("label", { for: "rq-due" }, "Needed by"), f.due),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit" }, icon("send", 18), "Submit request"),
        h("button", { class: "btn ghost", type: "button", onclick: () => { mem("cue-request-draft", null); ctx.refresh(); } }, "Clear draft"))));
}
