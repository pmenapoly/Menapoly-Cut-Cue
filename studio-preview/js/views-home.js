// Home (dashboard + content feed + composer) and Inbox.
import { h, icon, toast, sheet, empty, ago, avatar, kindIcon, statusTone, demoBadge, fmtDate } from "./ui.js";
import { svc } from "./service.js";
import { PLATFORMS } from "./data.js";

const remember = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch { return null; } return v; };

export function wsPicker(onChange) {
  const list = svc.workspaces(), cur = svc.currentWs();
  if (list.length < 2) return cur ? h("span", { class: "chip" }, icon("users", 14), cur.name) : null;
  const sel = h("select", { id: "ws-picker", "aria-label": "Workspace", style: "width:auto;min-height:44px", onchange: (e) => { svc.setWs(e.target.value); onChange(); } },
    list.map((w) => h("option", { value: w.id, selected: w.id === cur?.id }, w.name)));
  return sel;
}

export async function homeView(out, _p, ctx) {
  const me = svc.me(), ws = svc.currentWs();
  if (!ws) { out.append(h("h1", {}, `Hi, ${me.name.split(" ")[0]}`), empty("No workspace yet", "You'll see work here once you're assigned to a project.")); return; }
  const tab = remember("cue-home-tab") || "home";
  const [projects, reviews, requests, notes, feed] = await Promise.all([svc.projects(), svc.reviews(), svc.requests(), svc.notifications(), svc.feed(ws.id)]);
  const wsProjects = projects.filter((p) => p.ws === ws.id);
  const toReview = reviews.filter((r) => r.ws === ws.id && r.status === "In review");
  const hour = new Date().getHours();

  out.append(
    h("section", { class: "stack", style: "gap:14px" },
      h("div", { class: "section-head" },
        h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, ws.name),
          h("h1", {}, `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}, ${me.name.split(" ")[0]}`)),
        wsPicker(() => ctx.rerenderShell())),
      h("button", { class: "btn search-launch", onclick: ctx.search },
        icon("search", 18), "Search projects, media, reviews and lessons")),
    h("div", { class: "tabs", role: "tablist", "aria-label": "Home content" },
      [["home", "Home"], ["channel", "Channel Media"], ["mine", "My Media"], ["coaching", "Coaching"]].map(([k, l]) =>
        h("button", { class: "tab", role: "tab", "aria-selected": String(tab === k), onclick: () => { remember("cue-home-tab", k); ctx.refresh(); } }, l))));

  if (tab === "channel" || tab === "mine") {
    const assets = await svc.assets({ ws: ws.id, channel: tab === "channel", mine: tab === "mine" });
    out.append(h("p", { class: "muted small" }, tab === "channel" ? "Approved media, ready to share." : "Files you added."),
      assets.length ? h("div", { class: "tiles" }, assets.map(mediaTile))
        : empty(tab === "channel" ? "No approved media yet" : "You haven't added files", tab === "channel" ? "Approved deliverables appear here." : "Add footage in the Library.",
          h("a", { class: "btn", href: "#library" }, icon("upload", 18), "Open Library")));
    return;
  }
  if (tab === "coaching") {
    const lessons = await svc.lessons();
    out.append(h("div", { class: "grid-3" }, lessons.slice(0, 6).map((l) => h("a", { class: "card", href: `#lesson-${l.id}`, style: "text-decoration:none;color:inherit" },
      h("span", { class: "eyebrow" }, l.track), h("h3", {}, l.title), h("span", { class: "small faint" }, `${l.minutes} min · ${l.kind === "video" ? "Video" : "Guide"}`),
      h("div", { class: "progress", "aria-label": `${l.progress}% complete` }, h("span", { style: `width:${l.progress}%` }))))),
      h("a", { class: "btn", href: "#coaching" }, "All coaching"));
    return;
  }

  // ---- Home tab ----
  const nextStep = toReview.length && me.role !== "editor"
    ? { title: `${toReview[0].title} is ready for your review`, text: `Version ${toReview[0].latest.n} · ${toReview[0].open} open comment(s)`, link: `review-${toReview[0].id}`, cta: "Review now" }
    : me.role === "editor" ? (() => { const r = requests.find((x) => x.assigneeId === me.id && /assigned|submitted|revision/i.test(x.status));
        return r ? { title: `Start: ${r.title}`, text: r.brief, link: `project-${r.projectId}`, cta: "Open brief" } : null; })()
    : { title: "Send your next editing request", text: "Pick footage, describe the result, and we'll take it from there.", link: "request-new", cta: "New request" };
  out.append(
    nextStep ? h("section", { class: "card hero" }, h("span", { class: "eyebrow" }, "Suggested next step"), h("h2", {}, nextStep.title),
      h("p", { class: "muted" }, nextStep.text), h("div", { class: "actions" }, h("a", { class: "btn primary", href: `#${nextStep.link}` }, nextStep.cta))) : null,
    h("section", { class: "stats", "aria-label": "Production status" },
      stat(toReview.length, "awaiting review"), stat(requests.filter((r) => r.ws === ws.id && /progress|assigned/i.test(r.status)).length, "in production"),
      stat(requests.filter((r) => r.ws === ws.id && r.status === "Submitted").length, "new requests"), stat(wsProjects.length, "projects")),
    h("section", { class: "stack" }, h("h2", {}, "Quick actions"), h("div", { class: "actions" },
      me.role !== "editor" ? h("a", { class: "btn primary", href: "#request-new" }, icon("plus", 18), "Editing request") : null,
      h("a", { class: "btn", href: "#library" }, icon("upload", 18), "Add media"),
      me.role !== "editor" ? h("button", { class: "btn", onclick: () => composer(ws, ctx) }, icon("pen", 18), "Draft a post") : null,
      h("a", { class: "btn", href: "#ask" }, icon("spark", 18), "Ask Cue"))),
    h("div", { class: "split" },
      h("section", { class: "stack" }, h("div", { class: "section-head" }, h("h2", {}, "Activity"), h("span", { class: "small faint" }, `${feed.length} updates`)),
        feed.length ? h("div", { class: "feed" }, feed.map((f) => feedPost(f, ctx))) : empty("Quiet so far", "Uploads, deliverables and approvals will appear here.")),
      h("aside", { class: "stack" },
        h("section", { class: "card" }, h("h2", {}, "Pending approvals"),
          toReview.length ? h("ul", { class: "list" }, toReview.map((r) => h("li", {}, h("a", { class: "item", href: `#review-${r.id}` },
            h("span", { class: "thumb" }, r.poster ? h("img", { src: r.poster, alt: "" }) : icon("film")),
            h("span", { class: "grow" }, h("span", { class: "title" }, r.title), h("span", { class: "small faint" }, `v${r.latest.n} · ${r.open} open`)), icon("chevron", 18)))))
            : h("p", { class: "muted small" }, "Nothing waiting.")),
        h("section", { class: "card" }, h("h2", {}, "Recent projects"),
          wsProjects.length ? h("ul", { class: "list" }, wsProjects.map((p) => h("li", {}, h("a", { class: "item", href: `#project-${p.id}` },
            h("span", { class: "grow" }, h("span", { class: "title" }, p.name), h("span", { class: "small faint" }, `Due ${fmtDate(p.due)}`)),
            h("span", { class: `chip ${statusTone(p.status)}` }, p.status)))))
            : h("p", { class: "muted small" }, "No projects you can see in this workspace.")),
        h("section", { class: "card" }, h("div", { class: "section-head" }, h("h2", {}, "Notifications"), h("a", { href: "#inbox", class: "small" }, "Inbox")),
          notes.slice(0, 3).length ? h("ul", { class: "list" }, notes.slice(0, 3).map((n) => h("li", {}, h("a", { class: "item", href: `#${n.link}` },
            h("span", { class: "grow" }, h("span", { class: "title", style: n.read ? "font-weight:500" : "" }, n.text), h("span", { class: "small faint" }, ago(n.at)))))))
            : h("p", { class: "muted small" }, "You're all caught up.")))));
}

const stat = (n, label) => h("div", { class: "stat" }, h("b", {}, String(n)), h("span", {}, label));

export function mediaTile(a) {
  const poster = a.mediaInfo?.poster;
  return h("a", { class: "tile", href: `#asset-${a.id}` },
    h("span", { class: "poster" }, poster ? h("img", { src: poster, alt: "", loading: "lazy" }) : icon(kindIcon(a.kind), 30),
      h("span", { class: "chip" }, icon(kindIcon(a.kind), 13), a.kind)),
    h("b", {}, a.name), h("span", {}, `${a.projectName || "Workspace library"} · ${ago(a.at)}`));
}

function feedPost(f, ctx) {
  const kinds = { deliverable: ["New deliverable", "accent"], approved: ["Approved", "ok"], upload: ["Upload", ""], coaching: ["Coaching", "info"] };
  const [label, tone] = kinds[f.kind] || ["Update", ""];
  const commentBox = h("div", { class: "stack", hidden: true });
  const input = h("input", { id: `c-${f.id}`, placeholder: "Write a comment", "aria-label": "Comment" });
  commentBox.append(h("form", { class: "row nowrap", onsubmit: async (e) => { e.preventDefault();
    try { await svc.commentFeed(f.id, input.value); toast("Comment added"); ctx.refresh(); } catch (err) { toast(err.message, "err"); } } },
    input, h("button", { class: "btn primary", type: "submit", "aria-label": "Send comment" }, icon("send", 18))));
  return h("article", { class: "card post" },
    h("div", { class: "post-head" }, avatar(f.byName), h("div", { class: "grow" }, h("b", {}, f.byName), h("div", { class: "small faint" }, ago(f.at))),
      h("span", { class: `chip ${tone}` }, label)),
    h("p", {}, f.text),
    f.asset?.mediaInfo?.poster ? h("a", { class: "post-media", href: f.reviewId ? `#review-${f.reviewId}` : `#asset-${f.asset.id}`, "aria-label": `Open ${f.asset.name}` },
      h("img", { src: f.asset.mediaInfo.poster, alt: `Preview of ${f.asset.name}`, loading: "lazy" })) : null,
    f.comments.length ? h("div", { class: "stack" }, f.comments.map((c) => h("div", { class: "comment" }, avatar(c.byName, true),
      h("div", { class: "bubble" }, h("b", { class: "small" }, c.byName), h("div", { class: "small" }, c.body))))) : null,
    h("div", { class: "post-actions" },
      h("button", { class: "btn ghost sm", onclick: () => { commentBox.hidden = !commentBox.hidden; if (!commentBox.hidden) input.focus(); } }, icon("message", 18), "Comment"),
      h("button", { class: "btn ghost sm", "aria-pressed": String(f.saved), onclick: async () => { try { await svc.toggleSave(f.id); toast(f.saved ? "Removed from saved" : "Saved"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } },
        icon("bookmark", 18), f.saved ? "Saved" : "Save"),
      f.asset ? h("a", { class: "btn ghost sm", href: `#asset-${f.asset.id}` }, icon("studio", 18), "Open in Studio") : null,
      f.lessonId ? h("a", { class: "btn ghost sm", href: `#lesson-${f.lessonId}` }, icon("cap", 18), "Open lesson") : null),
    commentBox);
}

/** Post composer: drafts only. Nothing is connected to any social network in the preview. */
export async function composer(ws, ctx, preset = {}) {
  const approved = (await svc.assets({ ws: ws.id, channel: true }));
  if (!approved.length) { toast("Approve a deliverable in Review before drafting a post.", "err"); return; }
  const chosen = new Set(preset.platforms || ["linkedin", "instagram"]);
  const media = h("select", { id: "post-media", "aria-label": "Media" }, approved.map((a) => h("option", { value: a.id, selected: a.id === preset.assetId }, a.name)));
  const caption = h("textarea", { id: "post-caption", placeholder: "Write the caption. You can adjust it per channel in Social Sharing.", maxlength: "3000" }, preset.caption || "");
  const count = h("span", { class: "hint" });
  const limit = () => Math.min(...[...chosen].map((p) => PLATFORMS.find((x) => x.id === p).limit));
  const upd = () => { count.textContent = `${caption.value.length} / ${chosen.size ? limit() : "—"} characters (shortest limit of the chosen channels)`; };
  caption.addEventListener("input", upd);
  const date = h("input", { id: "post-date", type: "date", "aria-label": "Planned date" });
  const channels = h("div", { class: "actions", role: "group", "aria-label": "Channels" }, PLATFORMS.map((p) =>
    h("button", { type: "button", class: `tab ${chosen.has(p.id) ? "on" : ""}`, "aria-pressed": String(chosen.has(p.id)), onclick: (e) => {
      chosen.has(p.id) ? chosen.delete(p.id) : chosen.add(p.id); e.currentTarget.classList.toggle("on"); e.currentTarget.setAttribute("aria-pressed", String(chosen.has(p.id))); upd(); } }, p.label)));
  upd();
  const save = async (submit) => {
    try {
      const captions = Object.fromEntries([...chosen].map((p) => [p, caption.value.trim()]));
      const p = await svc.savePost({ assetId: media.value, platforms: [...chosen], captions, scheduledFor: date.value || null });
      if (submit) await svc.submitPost(p.id);
      d.close(); toast(submit ? "Draft sent for approval" : "Draft saved"); ctx.go("social");
    } catch (e) { toast(e.message, "err"); }
  };
  const d = sheet("Draft a post",
    h("p", { class: "small" }, demoBadge("Preparation only"), " Nothing is posted. Accounts aren't connected in the preview."),
    h("div", { class: "field" }, h("label", { for: "post-media" }, "Approved media"), media),
    h("div", { class: "field" }, h("label", { for: "post-caption" }, "Caption"), caption, count),
    h("div", { class: "field" }, h("span", { style: "font-weight:600;font-size:14px" }, "Channels"), channels),
    h("div", { class: "field" }, h("label", { for: "post-date" }, "Planned date (optional)"), date),
    h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: () => save(true) }, "Send for approval"), h("button", { class: "btn", onclick: () => save(false) }, "Save draft")));
}

export async function inboxView(out, _p, ctx) {
  const notes = await svc.notifications();
  out.append(h("div", { class: "section-head" }, h("h1", {}, "Inbox"),
    notes.some((n) => !n.read) ? h("button", { class: "btn sm", onclick: async () => { await svc.markAllRead(); toast("All caught up"); ctx.rerenderShell(); } }, icon("check", 18), "Mark all read") : null),
    notes.length ? h("section", { class: "card" }, h("ul", { class: "list" }, notes.map((n) => h("li", {}, h("a", { class: "item", href: `#${n.link}` },
      h("span", { class: "thumb" }, icon(n.read ? "bell" : "spark", 20)),
      h("span", { class: "grow" }, h("span", { class: "title", style: n.read ? "font-weight:500" : "" }, n.text), h("span", { class: "small faint" }, ago(n.at))),
      n.read ? null : h("span", { class: "chip accent" }, "New"))))))
      : empty("No notifications", "Approvals, assignments and new versions will show up here."));
}
