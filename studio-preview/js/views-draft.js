// Upload-first (Phase 2): "Upload & brief" and the draft Editing Room, the room a file opens before any editing request.
// A draft room is private to the client side: no request, no editor, no revision rounds, no production notifications.
// Files stay in this browser. Where it can, the preview keeps them on this device (IndexedDB) so they play after a
// refresh; otherwise they last for this session only and the room says so. Nothing is ever uploaded to a server.
import { h, icon, toast, sheet, ago, bytes, kindIcon, busy } from "./ui.js";
import { svc } from "./service.js";
import { createPlayer } from "./player.js";
import { deviceStore } from "./local-media.js";
import { acceptedFile } from "./rooms.js";

const KEEP_LIMIT = 500 * 1024 ** 2; // the preview keeps files up to 500 MB on the device; larger ones stay for the session
const device = deviceStore();
const playable = (f) => /^(video|audio|image)\//.test(f.type);
const newOpId = () => `op_${(globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60);
const STAGE_HELP = { Uploaded: "Your footage is here. Next, explain what you'd like made from it.", "Preparing instructions": "You've started your instructions. Finish them whenever you're ready." };

/** Keeps the picked file on this device when possible and records where it lives. Returns a warning, or null. */
async function keepLocally(asset, file) {
  if (!playable(file)) return null;
  if (file.size > KEEP_LIMIT) {
    const why = `Over ${bytes(KEEP_LIMIT)}, so the preview keeps it for this session only. Add it again after a refresh.`;
    await svc.setRetention(asset.id, "session", why); return why;
  }
  const r = await device.put(asset.id, file);
  if (r.ok) { await svc.setRetention(asset.id, "device"); return null; }
  await svc.setRetention(asset.id, "session", r.message); return r.message;
}

/**
 * Uploads files as stable operations: every file gets an operation id once, so a retry (or a double tap) repeats the
 * same operation instead of creating another file or room. together=true puts all files in one room (the first file is
 * the main footage); otherwise each file opens its own room. Rooms are never merged by name or content.
 */
async function uploadAll({ files, projectId, roomId, together, title, ops, onProgress }) {
  const results = [], warnings = [];
  let target = roomId || null;
  for (const [i, f] of files.entries()) {
    if (!ops.has(f)) ops.set(f, newOpId());
    onProgress?.(f, "working");
    const url = playable(f) ? URL.createObjectURL(f) : null;
    const res = await svc.registerUpload({ opId: ops.get(f), projectId, roomId: target, title: i === 0 || !together ? title : undefined,
      file: { name: f.name, size: f.size, type: f.type, url } });
    if (res.replayed) { if (url) URL.revokeObjectURL(url); }
    else { const w = await keepLocally(res.asset, f); if (w) warnings.push(`${f.name}: ${w}`); }
    if (together && !target) target = res.room.id;
    onProgress?.(f, "done");
    results.push(res);
  }
  return { results, warnings };
}

/**
 * "Upload & brief": choose files and the project they belong to, then the Editing Room opens. From the Library the
 * person may instead keep files in the library only (no room), as before. roomId adds files to an existing draft room.
 */
export async function uploadSheet(ctx, { files: preset = [], projectId, roomId, libraryOption = false, folderId = null } = {}) {
  const ws = svc.currentWs();
  const projects = roomId ? [] : (await svc.projects()).filter((p) => p.ws === ws?.id);
  let files = preset.filter((f) => acceptedFile(f.name, f.type));
  const ops = new Map(); // file → operation id, kept for retries while this sheet is open
  const picker = h("input", { id: "up-file", type: "file", multiple: true, class: "sr", accept: "video/*,audio/*,image/*,.pdf,.doc,.docx,.txt,.srt,.vtt,.zip", "aria-label": "Choose files" });
  const list = h("ul", { class: "list", "aria-label": "Chosen files" });
  const project = roomId ? null : h("select", { id: "up-project" },
    projects.map((p) => h("option", { value: p.id, selected: p.id === projectId }, p.name)),
    libraryOption ? h("option", { value: "" }, "Library only (no Editing Room)") : null);
  if (project) project.value = projectId || projects[0]?.id || "";
  const title = h("input", { id: "up-title", maxlength: "120", placeholder: "e.g. Roastery floor" });
  const mode = h("fieldset", { class: "stack", style: "border:0;padding:0;margin:0;gap:6px", hidden: true },
    h("legend", { style: "font-weight:650;font-size:14px;margin-bottom:6px" }, "These files are"),
    h("label", { class: "check" }, h("input", { type: "radio", name: "up-mode", value: "together", checked: true }), "For one video: open one Editing Room with all of them"),
    h("label", { class: "check" }, h("input", { type: "radio", name: "up-mode", value: "separate" }), "Separate videos: open an Editing Room for each file"));
  const titleField = h("div", { class: "field" }, h("label", { for: "up-title" }, "Video title (optional)"), title);
  const go = h("button", { class: "btn primary", id: "up-go" }, icon("upload", 18), roomId ? "Add to this room" : "Upload & open Editing Room");
  const draw = () => {
    list.replaceChildren(...files.map((f) => h("li", { class: "item small", "data-file": f.name }, h("span", { class: "thumb" }, icon(kindIcon(f.type.split("/")[0]), 20)),
      h("span", { class: "grow" }, h("b", {}, f.name), h("span", { class: "tiny faint" }, ` ${bytes(f.size)}`)), h("span", { class: "tiny faint", "data-progress": "" }, "Ready"))));
    const roomish = !roomId && (!project || project.value);
    mode.hidden = !(roomish && files.length > 1);
    titleField.hidden = !roomish || (files.length > 1 && mode.querySelector("input:checked")?.value === "separate");
    go.disabled = !files.length;
    go.lastChild.textContent = roomId ? "Add to this room" : roomish ? (files.length > 1 && mode.querySelector("input:checked").value === "separate" ? "Upload & open Editing Rooms" : "Upload & open Editing Room") : "Add to the library";
  };
  picker.addEventListener("change", () => {
    const picked = [...picker.files]; picker.value = "";
    picked.filter((f) => !acceptedFile(f.name, f.type)).forEach((f) => toast(`${f.name}: that file type isn't accepted. Use video, audio, image or document files.`, "err"));
    files = [...files, ...picked.filter((f) => acceptedFile(f.name, f.type))]; draw();
  });
  project?.addEventListener("change", draw);
  mode.addEventListener("change", draw);
  const d = sheet(roomId ? "Add a file to this room" : "Upload & brief",
    h("p", { class: "small muted" }, roomId ? "The file joins this draft Editing Room." : "Your footage opens its own Editing Room straight away. Nothing goes to the editing team until you submit an editing request."),
    h("label", { for: "up-file", class: "btn", role: "button", tabindex: "0", onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } } }, icon("plus", 18), files.length ? "Choose more files" : "Choose files"),
    picker, list,
    project ? h("div", { class: "field" }, h("label", { for: "up-project" }, "Project"), project) : null,
    mode, roomId ? null : titleField,
    h("p", { class: "tiny faint" }, "Simulated upload: files stay in this browser. Where the browser allows, they're kept on this device so they still play after a refresh."),
    go);
  go.addEventListener("click", busy(async () => {
    const pid = roomId ? projectId : project.value;
    const mark = (f, s) => { const el = [...list.children].find((li) => li.dataset.file === f.name)?.querySelector("[data-progress]"); if (el) el.textContent = s === "done" ? "Done" : "Adding…"; };
    try {
      if (!pid) { // Library only: the previous behaviour, no room
        for (const f of files) { await svc.addLocalFile({ name: f.name, size: f.size, type: f.type, url: playable(f) ? URL.createObjectURL(f) : null }, ws.id, null, folderId); toast(`${f.name} added`); }
        d.close(); ctx.refresh(); return;
      }
      const together = roomId ? true : mode.hidden || mode.querySelector("input:checked").value === "together";
      const { results, warnings } = await uploadAll({ files, projectId: pid, roomId, together, title: title.value.trim(), ops, onProgress: mark });
      d.close();
      const rooms = [...new Set(results.map((r) => r.room.id))];
      warnings.forEach((w) => toast(w, "err"));
      toast(roomId ? "Added to this room" : rooms.length > 1 ? `${rooms.length} Editing Rooms opened. Find them under Drafts.` : "Editing Room opened. It's a draft until you submit a request.");
      ctx.go(`video-${rooms[0]}`);
    } catch (e) { toast(e.message, "err"); } // the same operation ids are reused if they try again
  }));
  draw();
  return d;
}

/** A draft room in a list (Studio, project page, Library): where it stands and a way back in. */
export function draftItem(d, { showProject = true } = {}) {
  return h("li", { "data-draft-room": d.id }, h("a", { class: "item", href: `#video-${d.id}` },
    h("span", { class: "thumb" }, icon("film", 22)),
    h("span", { class: "grow" }, h("span", { class: "title small" }, d.title),
      h("span", { class: "tiny faint" }, [showProject ? d.projectName : null, d.stage, `${d.assets.length} file(s)`, `started ${ago(d.createdAt)}`].filter(Boolean).join(" · "))),
    h("span", { class: "status", "data-tone": "draft" }, "Draft"),
    h("span", { class: "chip wide-only" }, "Continue preparing"), icon("chevron", 18)));
}

/* ============================== Draft Editing Room ============================== */
const selected = new Map(); // room id → the file being previewed (per tab)

/** A file kept on this device but not yet loaded in this tab is restored before the room draws. */
async function restoreFromDevice(rm) {
  for (const a of rm.assets.filter((x) => x.storage === "device" && !x.storageInfo.available)) {
    const r = await device.get(a.id);
    if (r.ok && r.value) await svc.attachLocalFile(a.id, { url: URL.createObjectURL(r.value) }, { restored: true });
  }
}

export async function draftRoomView(out, [rid], ctx) {
  let rm = await svc.room(rid);
  if (rm.assets.some((a) => a.storage === "device" && !a.storageInfo.available)) { await restoreFromDevice(rm); rm = await svc.room(rid); }
  const me = svc.me(), canEdit = me.role === "admin" || me.role === "client";
  const others = (await svc.drafts({ projectId: rm.projectId })).filter((x) => x.id !== rm.id);
  const saved = svc.persistence();
  const assets = rm.assets;
  let pick = assets.find((a) => a.id === selected.get(rid)) || assets.find((a) => a.id === rm.mainAssetId) || assets[0];

  const stageBox = h("div", { class: "draft-stage-wrap" });
  const drawStage = () => stageBox.replaceChildren(previewFor(pick, rm, ctx));
  const strip = assets.length > 1 ? h("div", { class: "file-strip", role: "group", "aria-label": "Files in this room" }, assets.map((a) =>
    h("button", { class: "file-chip", "aria-pressed": String(a.id === pick.id), "data-asset": a.id, onclick: (e) => {
      pick = a; selected.set(rid, a.id); strip.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); drawStage(); } },
      icon(kindIcon(a.kind), 16), h("span", {}, a.name), a.id === rm.mainAssetId ? h("span", { class: "tiny" }, "Main") : null))) : null;
  drawStage();

  const missing = rm.brief?.missing || [];
  out.append(h("div", { class: "room draft-room", "data-room": rm.id },
    h("div", { class: "room-main" },
      h("header", { class: "room-head" },
        h("a", { href: `#project-${rm.projectId}`, class: "small back-link" }, icon("back", 16), rm.projectName),
        h("h1", { class: "room-title" }, rm.title),
        h("p", { class: "small faint" }, `${rm.workspace} · ${rm.projectName}`),
        h("div", { class: "row" },
          h("span", { class: "status", "data-tone": "draft", "data-status": rm.stage }, icon(rm.stage === "Uploaded" ? "upload" : "pen", 13), rm.stage),
          h("span", { class: "chip", "data-draft": "" }, "Draft — not submitted"),
          h("span", { class: "chip" }, icon("clock", 13), `Started ${ago(rm.createdAt)} by ${rm.byName}`))),
      saved.ok ? null : h("p", { class: "notice warn", role: "alert" }, icon("alert", 16), saved.message),
      stageBox, strip),
    h("aside", { class: "room-side" },
      h("section", { class: "card status-card", "data-tone": "waiting", "aria-label": "What happens next" },
        h("span", { class: "eyebrow" }, icon("pen", 14), "Draft · not submitted"),
        h("h2", { class: "status-head editorial" }, STAGE_HELP[rm.stage] ? "Your Editing Room is ready" : rm.stage),
        h("p", { class: "small" }, STAGE_HELP[rm.stage] || ""),
        h("p", { class: "small muted" }, "Nothing has gone to Menapoly yet: no editing request, no editor and no revision rounds used. You can leave and come back to this draft any time."),
        h("ol", { class: "next-steps small" },
          h("li", {}, h("b", {}, "Prepare your instructions. "), "Writing, drawing on frames and voice notes come in the next update of this preview."),
          h("li", {}, h("b", {}, "Submit the editing request "), "when it's ready. That's when production starts."),
          h("li", {}, h("b", {}, "Menapoly assigns an editor "), "and you review the versions here, in the same room.")),
        missing.length ? h("p", { class: "tiny faint" }, `Still needed before you can submit: ${missing.join(", ").toLowerCase()}.`) : null),
      h("section", { class: "card", "aria-label": "Source files" },
        h("div", { class: "section-head" }, h("h2", {}, `Source files (${assets.length})`),
          canEdit ? h("button", { class: "btn sm", onclick: () => uploadSheet(ctx, { roomId: rm.id, projectId: rm.projectId }) }, icon("plus", 16), "Add a file") : null),
        h("ul", { class: "list" }, assets.map((a) => fileRow(a, rm, ctx)))),
      others.length ? h("section", { class: "card", "aria-label": "Other drafts in this project" }, h("h2", {}, "Other drafts in this project"),
        h("ul", { class: "list" }, others.map((o) => h("li", {}, h("a", { class: "item", href: `#video-${o.id}` }, h("span", { class: "thumb" }, icon("film", 20)),
          h("span", { class: "grow" }, h("span", { class: "title small" }, o.title), h("span", { class: "tiny faint" }, `${o.stage} · ${o.assets.length} file(s)`)), icon("chevron", 18)))))) : null,
      h("p", { class: "tiny faint" }, "Find your drafts again under Media Studio → Drafts, on the project page, or in the Library."))));
}

function fileRow(a, rm, ctx) {
  const st = a.storageInfo, avail = st.available;
  return h("li", { class: "item", "data-asset": a.id },
    h("span", { class: "thumb" }, icon(kindIcon(a.kind), 22)),
    h("span", { class: "grow" },
      h("span", { class: "title small" }, a.name, a.id === rm.mainAssetId ? h("span", { class: "tiny faint" }, " · main footage") : null),
      h("span", { class: "tiny faint" }, `${a.kind} · ${bytes(a.size)} · ${a.byName} · ${ago(a.at)}`),
      h("span", { class: "tiny", "data-storage": st.storage }, st.label),
      a.retention?.reason ? h("span", { class: "tiny warn-text" }, a.retention.reason) : null),
    h("span", { class: "status", "data-tone": avail ? "done" : st.storage === "none" ? "waiting" : "changes", "data-availability": avail ? "available" : st.missing ? "missing" : "unavailable" },
      avail ? "Available" : st.missing ? "Missing" : "No preview"),
    st.missing ? againButton(a, ctx) : null);
}

/** "Add file again": only the same file (same name and size) is accepted, then kept on this device again if possible. */
function againButton(a, ctx) {
  const id = `again-${a.id}`;
  const input = h("input", { id, type: "file", class: "sr", "aria-label": `Add ${a.name} again`, onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    const url = URL.createObjectURL(f);
    try { await svc.attachLocalFile(a.id, { name: f.name, size: f.size, url }); const w = await keepLocally(a, f); toast(w || "File added again on this device"); ctx.refresh(); }
    catch (err) { URL.revokeObjectURL(url); toast(err.message, "err"); }
  } });
  return h("span", {}, h("label", { for: id, class: "btn sm", role: "button", tabindex: "0", onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } } },
    icon("refresh", 16), "Add file again"), input);
}

/** The dark stage: the player when the file can play here, otherwise an honest explanation (never a fake picture). */
function previewFor(a, rm, ctx) {
  const note = (ic, head, text, action) => h("div", { class: "vp draft-note", role: "status" }, h("div", { class: "draft-note-body" }, icon(ic, 30), h("b", {}, head), h("span", {}, text), action || null));
  if (!a) return note("film", "No file in this room", "Add footage to start.");
  const st = a.storageInfo, src = a.mediaInfo?.src;
  if (!st.available || !src) {
    if (st.missing) return note("alert", "This file isn't on this device anymore", st.message || "Add it again to play it.", againButton(a, ctx));
    return note(kindIcon(a.kind), a.name, a.kind === "document" ? "Documents don't preview here. The file's name and size are kept." : "No preview: the preview kept only this file's name and size.");
  }
  if (a.kind === "image") return h("div", { class: "vp" }, h("div", { class: "vp-stage" }, h("img", { src, alt: a.name, class: "draft-img" })));
  if (a.kind === "audio") return h("div", { class: "vp draft-note" }, h("div", { class: "draft-note-body" }, icon("wave", 30), h("b", {}, a.name), h("audio", { src, controls: true, "aria-label": a.name })));
  const player = createPlayer({ media: { src, local: true, duration: 0 }, label: `${rm.title}, ${a.name}` });
  const box = h("div", { class: "draft-player" }, player.el);
  // Formats this browser can't decode get an explanation instead of a black box.
  const cant = () => box.replaceChildren(note("alert", "This browser can't play this format", `${a.name} is kept in the room; the editing team works from the original file. Try another browser to preview it.`));
  player.video.addEventListener("error", cant);
  player.video.querySelector("source")?.addEventListener("error", cant);
  return box;
}
