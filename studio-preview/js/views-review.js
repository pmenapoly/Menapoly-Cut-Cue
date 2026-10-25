// Review: list and the review room (timestamped, frame-anchored annotations, threads, versions, compare, decisions, audit).
import { h, icon, toast, sheet, empty, ago, avatar, statusTone, demoBadge } from "./ui.js";
import { svc, fmtT } from "./service.js";
import { can } from "./policy.js";

export async function reviewListView(out) {
  const reviews = await svc.reviews();
  const filter = (() => { try { return sessionStorage.getItem("cue-review-filter") || "open"; } catch { return "open"; } })();
  const shown = reviews.filter((r) => filter === "all" || (filter === "open" ? r.status !== "Approved" : r.status === "Approved"));
  out.append(h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "Review"), h("h1", {}, "Cuts to review")),
    h("div", { class: "tabs", role: "tablist", "aria-label": "Filter reviews" }, [["open", "Open"], ["approved", "Approved"], ["all", "All"]].map(([k, l]) =>
      h("button", { class: "tab", role: "tab", "aria-selected": String(filter === k), onclick: () => { try { sessionStorage.setItem("cue-review-filter", k); } catch { /* ignore */ } dispatchEvent(new HashChangeEvent("hashchange")); } }, l))),
    shown.length ? h("div", { class: "tiles" }, shown.map((r) => h("a", { class: "tile", href: `#review-${r.id}` },
      h("span", { class: "poster" }, r.poster ? h("img", { src: r.poster, alt: "" }) : icon("film", 30), h("span", { class: "chip" }, `v${r.latest.n}`)),
      h("b", {}, r.title), h("span", {}, `${r.status} · ${r.open} open comment(s)`))))
      : empty(filter === "open" ? "Nothing to review" : "No reviews here", filter === "open" ? "New cuts land here when an editor submits them." : "Approved cuts appear here."));
}

export async function reviewRoomView(out, [rid], ctx) {
  const me = svc.me();
  let r = await svc.review(rid);
  const project = { ws: r.ws, editorIds: [] }; // decision rights come from the service; the UI only mirrors them
  const mayDecide = can(me, "review.decide", { ws: r.ws, project: { ...project, ws: r.ws } });
  const mayUpload = me.role === "admin" || me.role === "editor";
  let version = r.versions.length, tool = null, draft = null, active = null, filter = "all";

  const video = h("video", { playsinline: true, preload: "metadata", controls: true, "aria-label": `${r.title}, version ${version}` });
  const canvas = h("canvas", { "aria-hidden": "true", style: "pointer-events:none" });
  const player = h("div", { class: "player" }, video, canvas);
  const timeline = h("div", { class: "timeline", role: "slider", tabindex: "0", "aria-label": "Timeline with comment pins", "aria-valuemin": "0" });
  const tc = h("span", { class: "mono small", "aria-live": "off" }, "0:00.0");
  const list = h("div", { class: "thread" });
  const composerBox = h("div", { class: "card", hidden: true });
  const versionTabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Versions" });

  function setVersion(n) {
    version = n; const v = r.versions[n - 1];
    video.src = v.src; video.poster = v.poster; video.setAttribute("aria-label", `${r.title}, version ${n}`);
    versionTabs.replaceChildren(...r.versions.map((x) => h("button", { class: "tab", role: "tab", "aria-selected": String(x.n === n), onclick: () => setVersion(x.n) }, `Version ${x.n}`)));
    draw(); drawList(); drawTimeline();
  }
  const comments = () => r.comments.filter((c) => c.version === version);

  // ---- drawing overlay ----
  function sizeCanvas() { const b = video.getBoundingClientRect(); const dpr = devicePixelRatio || 1; canvas.width = Math.round(b.width * dpr); canvas.height = Math.round(b.height * dpr); draw(); }
  function paint(g, shape, color, W, H) {
    g.strokeStyle = color; g.lineWidth = 3 * (devicePixelRatio || 1); g.lineJoin = g.lineCap = "round";
    if (shape.type === "rect") g.strokeRect(shape.x * W, shape.y * H, shape.w * W, shape.h * H);
    else if (shape.type === "pen" && shape.points?.length) { g.beginPath(); shape.points.forEach(([x, y], i) => i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)); g.stroke(); }
  }
  function draw() {
    const g = canvas.getContext("2d"); if (!g) return; const W = canvas.width, H = canvas.height; g.clearRect(0, 0, W, H);
    const t = video.currentTime || 0;
    comments().filter((c) => c.shape && (Math.abs(c.t - t) < 0.6 || c.id === active)).forEach((c) => paint(g, c.shape, c.id === active ? "rgb(168 140 255)" : "rgb(210 196 255)", W, H));
    if (draft) paint(g, draft, "rgb(244 195 90)", W, H);
  }
  let start = null;
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))]; };
  canvas.addEventListener("pointerdown", (e) => { if (!tool) return; canvas.setPointerCapture(e.pointerId); start = pos(e);
    draft = tool === "rect" ? { type: "rect", x: start[0], y: start[1], w: 0, h: 0 } : { type: "pen", points: [start] }; draw(); });
  canvas.addEventListener("pointermove", (e) => { if (!start || !draft) return; const [x, y] = pos(e);
    if (draft.type === "rect") Object.assign(draft, { x: Math.min(x, start[0]), y: Math.min(y, start[1]), w: Math.abs(x - start[0]), h: Math.abs(y - start[1]) });
    else if (draft.points.length < 400) draft.points.push([+x.toFixed(4), +y.toFixed(4)]);
    draw(); });
  canvas.addEventListener("pointerup", () => { start = null; if (draft?.type === "rect" && (draft.w < 0.02 || draft.h < 0.02)) draft = null; draw(); updateComposer(); });

  // ---- timeline with pins ----
  function drawTimeline() {
    const dur = video.duration || r.versions[version - 1].duration || 1;
    timeline.setAttribute("aria-valuemax", String(Math.round(dur))); timeline.setAttribute("aria-valuenow", String(Math.round(video.currentTime || 0)));
    timeline.replaceChildren(h("span", { class: "played", style: `width:${((video.currentTime || 0) / dur) * 100}%` }),
      ...comments().map((c) => h("button", { class: `pin ${c.resolved ? "resolved" : ""}`, style: `left:${(c.t / dur) * 100}%`, "aria-label": `Comment at ${fmtT(c.t)}: ${c.body}`,
        onclick: (e) => { e.stopPropagation(); focusComment(c.id); } })));
  }
  const seekTo = (clientX) => { const b = timeline.getBoundingClientRect(); const dur = video.duration || 1; video.currentTime = Math.min(dur, Math.max(0, ((clientX - b.left) / b.width) * dur)); };
  timeline.addEventListener("pointerdown", (e) => { if (e.target.classList.contains("pin")) return; video.pause(); seekTo(e.clientX); });
  timeline.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") video.currentTime = Math.min(video.duration || 0, video.currentTime + 1); if (e.key === "ArrowLeft") video.currentTime = Math.max(0, video.currentTime - 1); });
  video.addEventListener("timeupdate", () => { tc.textContent = fmtT(video.currentTime); drawTimeline(); draw(); });
  video.addEventListener("loadedmetadata", () => { sizeCanvas(); drawTimeline(); });
  new ResizeObserver(sizeCanvas).observe(player);

  function focusComment(cid) {
    const c = r.comments.find((x) => x.id === cid); if (!c) return;
    active = cid; video.pause(); video.currentTime = c.t; draw(); drawList();
    list.querySelector(`[data-id="${cid}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---- composer ----
  const body = h("textarea", { id: "annotation-body", placeholder: "What should change at this moment?", maxlength: "2000" });
  const composerInfo = h("p", { class: "small" });
  const toolBtn = (k, label, ic) => h("button", { class: "tool", "aria-pressed": "false", "data-tool": k, onclick: () => setTool(tool === k ? null : k) }, icon(ic, 20), label);
  const tools = h("div", { class: "tools", role: "group", "aria-label": "Annotation tools" }, toolBtn("rect", "Box", "box"), toolBtn("pen", "Draw", "pen"),
    h("button", { class: "tool", onclick: () => { draft = null; draw(); updateComposer(); } }, icon("x", 20), "Clear"));
  function setTool(k) { tool = k; canvas.style.pointerEvents = k ? "auto" : "none"; video.controls = !k;
    tools.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === k)));
    if (k) toast(k === "rect" ? "Drag on the video to mark an area" : "Draw on the video"); }
  function updateComposer() { composerInfo.replaceChildren(icon("clock", 16), ` At ${fmtT(video.currentTime)} on version ${version}`, draft ? " · with a marked area" : ""); }
  composerBox.append(h("h2", {}, "Add feedback"), composerInfo, tools,
    h("label", { for: "annotation-body", class: "sr" }, "Comment"), body,
    h("div", { class: "actions" },
      h("button", { class: "btn primary", onclick: async () => {
        try { const c = await svc.addComment(r.id, { version, t: video.currentTime, shape: draft, body: body.value });
          r = await svc.review(r.id); body.value = ""; draft = null; setTool(null); composerBox.hidden = true; active = c.id; drawList(); drawTimeline(); draw(); toast("Comment added"); }
        catch (e) { toast(e.message, "err"); } } }, icon("send", 18), "Send comment"),
      h("button", { class: "btn ghost", onclick: () => { composerBox.hidden = true; draft = null; setTool(null); draw(); } }, "Cancel")));
  // Keep the whole frame drawable: bring the player (not the form) to the top, below the sticky header.
  const openComposer = () => { video.pause(); composerBox.hidden = false; updateComposer(); body.focus({ preventScroll: true }); player.scrollIntoView({ block: "start" }); };

  // ---- comment list ----
  function drawList() {
    const items = comments().filter((c) => filter === "all" || (filter === "open" ? !c.resolved : c.resolved)).sort((a, b) => a.t - b.t);
    list.replaceChildren(
      h("div", { class: "tabs", role: "tablist", "aria-label": "Filter comments" }, [["all", `All (${comments().length})`], ["open", "Open"], ["resolved", "Resolved"]].map(([k, l]) =>
        h("button", { class: "tab", role: "tab", "aria-selected": String(filter === k), onclick: () => { filter = k; drawList(); } }, l))),
      ...(items.length ? items.map(noteCard) : [h("p", { class: "muted small" }, version === r.versions.length ? "No comments on this version yet. Pause on a frame and add one." : "No comments on this version.")]));
  }
  function noteCard(c) {
    const reply = h("input", { id: `reply-${c.id}`, placeholder: "Reply", "aria-label": `Reply to ${c.byName}` });
    const mayResolve = can(me, "review.resolve", { ws: r.ws, resource: c, project: { ws: r.ws, editorIds: me.role === "editor" ? [me.id] : [] } });
    return h("article", { class: `note ${c.id === active ? "active" : ""} ${c.resolved ? "resolved" : ""}`, "data-id": c.id },
      h("div", { class: "row" }, avatar(c.byName, true), h("b", { class: "small" }, c.byName),
        h("button", { class: "ts", onclick: () => focusComment(c.id), "aria-label": `Go to ${fmtT(c.t)}` }, fmtT(c.t)),
        c.shape ? h("span", { class: "chip" }, icon(c.shape.type === "rect" ? "box" : "pen", 13), "marked") : null,
        c.resolved ? h("span", { class: "chip ok" }, "Resolved") : null, h("span", { class: "tiny faint", style: "margin-left:auto" }, ago(c.at))),
      h("p", {}, c.body),
      c.replies.length ? h("div", { class: "replies" }, c.replies.map((x) => h("div", { class: "small" }, h("b", {}, x.byName), " ", x.body))) : null,
      h("form", { class: "row nowrap", onsubmit: async (e) => { e.preventDefault();
        try { await svc.reply(r.id, c.id, reply.value); r = await svc.review(r.id); drawList(); toast("Reply added"); } catch (err) { toast(err.message, "err"); } } },
        reply, h("button", { class: "btn sm", type: "submit" }, "Reply")),
      mayResolve ? h("div", { class: "actions" }, h("button", { class: "btn sm", onclick: async () => {
        try { await svc.resolve(r.id, c.id, !c.resolved); r = await svc.review(r.id); drawList(); drawTimeline(); toast(c.resolved ? "Reopened" : "Resolved"); } catch (e) { toast(e.message, "err"); } } },
        icon(c.resolved ? "refresh" : "check", 16), c.resolved ? "Reopen" : "Resolve")) : null);
  }

  // ---- decisions ----
  const changeNote = h("textarea", { id: "changes-note", placeholder: "What should be different in the next version?" });
  const decide = h("section", { class: "card" }, h("h2", {}, "Decision"));
  if (r.status === "Approved") decide.append(h("p", { class: "row" }, h("span", { class: "chip ok" }, icon("check", 14), "Approved"), "This cut is in Channel Media and ready to share."),
    me.role !== "editor" ? h("a", { class: "btn", href: "#social" }, icon("share", 18), "Prepare social posts") : null);
  else {
    if (mayDecide) decide.append(h("p", { class: "small muted" }, `Revisions used: ${r.revisionsUsed} of ${r.revisionLimit}.`),
      h("div", { class: "actions" }, h("button", { class: "btn ok", onclick: async () => {
        try { await svc.decide(r.id, "approve"); toast("Approved. It's now in Channel Media."); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } }, icon("check", 18), `Approve version ${r.versions.length}`)),
      h("label", { for: "changes-note" }, "Or request changes"), changeNote,
      h("button", { class: "btn", onclick: async () => {
        try { await svc.decide(r.id, "changes", changeNote.value); toast("Changes requested. The editor has been notified."); ctx.refresh(); } catch (e) { toast(e.message, "err"); changeNote.focus(); } } }, icon("message", 18), "Request changes"));
    else decide.append(h("p", { class: "small muted" }, me.role === "editor" ? "The client or a Menapoly administrator approves cuts. You can upload a new version." : "You can comment on this cut."));
    if (mayUpload) { const note = h("input", { id: "version-note", placeholder: "What changed in this version?" });
      decide.append(h("label", { for: "version-note" }, "Submit a new version"), note,
        h("button", { class: "btn", onclick: async () => { try { await svc.uploadVersion(r.id, note.value); toast("New version submitted (simulated)"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } },
          icon("upload", 18), "Upload new version"), h("p", { class: "tiny" }, demoBadge(), " The preview reuses a demo clip; no file is uploaded or rendered.")); }
  }

  out.append(
    h("a", { href: "#review", class: "small" }, "← All reviews"),
    h("div", { class: "section-head" }, h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, r.projectName), h("h1", {}, r.title)),
      h("span", { class: `chip ${statusTone(r.status)}` }, r.status)),
    versionTabs,
    h("div", { class: "split" },
      h("div", { class: "stack", style: "gap:12px" }, player, timeline,
        h("div", { class: "row", style: "justify-content:space-between" }, tc,
          h("div", { class: "actions" },
            r.versions.length > 1 ? h("button", { class: "btn sm", onclick: () => compare(r) }, icon("compare", 18), "Compare") : null)),
        h("button", { class: "btn primary block", style: "min-height:52px", onclick: openComposer }, icon("message", 20), "Pause & comment"),
        composerBox),
      h("div", { class: "stack", style: "gap:14px" },
        h("section", { class: "card" }, h("h2", {}, "Comments"), list),
        decide,
        h("details", { class: "card" }, h("summary", { class: "audit-toggle" }, `Audit trail (${r.audit.length})`),
          h("ul", { class: "list" }, [...r.audit].reverse().map((a) => h("li", { class: "item" }, h("span", { class: "grow" },
            h("span", { class: "small" }, h("b", {}, a.byName), ` ${a.action}`, a.detail ? `: ${a.detail}` : ""), h("span", { class: "tiny faint" }, new Date(a.at).toLocaleString()))))))),
    ));
  setVersion(version);
}

function compare(r) {
  const vids = r.versions.slice(-2).map((v) => h("video", { src: v.src, poster: v.poster, playsinline: true, muted: true, preload: "metadata", "aria-label": `Version ${v.n}` }));
  const sync = (fn) => vids.forEach(fn);
  sheet(`Compare versions ${r.versions.length - 1} and ${r.versions.length}`,
    h("div", { class: "compare" }, vids.map((v, i) => h("figure", { style: "margin:0;display:grid;gap:6px" }, v,
      h("figcaption", { class: "small faint" }, `Version ${r.versions[r.versions.length - 2 + i].n} · ${r.versions[r.versions.length - 2 + i].note || ""}`)))),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", onclick: () => { const t = vids[0].currentTime; sync((v) => { v.currentTime = t; v.play().catch(() => {}); }); } }, icon("play", 18), "Play both"),
      h("button", { class: "btn", onclick: () => sync((v) => v.pause()) }, icon("pause", 18), "Pause"),
      h("button", { class: "btn", onclick: () => sync((v) => { v.pause(); v.currentTime = 0; }) }, "Restart")));
}
