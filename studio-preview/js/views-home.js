// Home (dashboard + content feed + composer) and Inbox.
import { h, icon, toast, sheet, empty, ago, avatar, kindIcon, statusTone, statusBadge, demoBadge, fmtDate } from "./ui.js";
import { svc } from "./service.js";
import { PLATFORMS } from "./data.js";
import { openMaven } from "./maven.js";

const remember = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch { return null; } return v; };

export function wsPicker(onChange) {
  const list = svc.workspaces(), cur = svc.currentWs();
  if (list.length < 2) return cur ? h("span", { class: "chip" }, icon("users", 14), cur.name) : null;
  const sel = h("select", { id: "ws-picker", "aria-label": "Workspace", style: "width:auto;min-height:44px", onchange: (e) => { svc.setWs(e.target.value); onChange(); } },
    list.map((w) => h("option", { value: w.id, selected: w.id === cur?.id }, w.name)));
  return sel;
}

/** Upload filters shared by Home and the Library: All uploads / My uploads / Others, plus a searchable uploader picker. */
export function uploaderFilter({ key, who, pick, me, uploaders, ctx }) {
  return h("div", { class: "row" },
    h("div", { class: "seg", role: "group", "aria-label": "Whose uploads" }, [["all", "All uploads"], ["mine", "My uploads"], ["others", "Others"]].map(([k, l]) =>
      h("button", { class: `tab ${who === k ? "on" : ""}`, "aria-pressed": String(who === k), onclick: () => { remember(`${key}-uploads`, k); ctx.refresh(); } }, l))),
    who !== "mine" ? h("select", { id: key === "cue" ? "uploader" : `${key}-uploader`, "aria-label": "Uploaded by", style: "width:auto;flex:1 1 150px",
      onchange: (e) => { remember(`${key}-uploader`, e.target.value); ctx.refresh(); } },
      h("option", { value: "" }, "Anyone"), uploaders.filter((u) => who !== "others" || u.id !== me.id).map((u) => h("option", { value: u.id, selected: u.id === pick }, u.name))) : null);
}
export function filterUploads(list, { who, pick, me }) {
  let out = who === "mine" ? list.filter((a) => a.by === me.id) : who === "others" ? list.filter((a) => a.by !== me.id) : list;
  if (pick && who !== "mine") out = out.filter((a) => a.by === pick);
  return out;
}

export async function homeView(out, _p, ctx) {
  const me = svc.me(), ws = svc.currentWs();
  if (!ws) { out.append(h("h1", {}, `Hi, ${me.name.split(" ")[0]}`), empty("No workspace yet", "You'll see work here once you're assigned to a project.")); return; }
  const who = remember("cue-uploads") || "all", pick = remember("cue-uploader") || "";
  const [reviews, notes, feed, notices, spot, uploaders, videos, projects, allUploads] = await Promise.all([svc.reviews(), svc.notifications(), svc.feed(ws.id), svc.announcements(),
    svc.spotlight(), svc.uploaders(ws.id), svc.videos({ ws: ws.id }), svc.projects(), svc.assets({ ws: ws.id })]);
  const uploads = filterUploads(allUploads, { who, pick, me });
  const board = me.role === "admin" ? (await svc.production()).rows : [];
  const unassigned = board.filter((r) => !r.assigneeId && !/approved/i.test(r.status)), overdue = board.filter((r) => r.overdue);
  const vidStatus = Object.fromEntries(videos.map((v) => [v.id, v.status]));
  const toReview = reviews.filter((r) => r.ws === ws.id && r.status === "In review");
  const openComments = reviews.filter((r) => r.ws === ws.id).reduce((n, r) => n + r.open, 0);
  const soon = projects.filter((p) => p.ws === ws.id && p.due && (new Date(p.due) - Date.now()) / 864e5 <= 7 && !/approved|delivered/i.test(p.status));
  const mine = videos.filter((v) => /edit|waiting|changes/i.test(v.status) && (me.role !== "editor" || v.editor === me.name));
  const hour = new Date().getHours(), first = me.name.split(" ")[0];
  const waiting = me.role === "editor" ? mine.length : toReview.length + (openComments ? 1 : 0) + soon.length + (unassigned.length ? 1 : 0);
  const greet = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}, `;

  // 1 · What needs me? (amber, compact, one obvious action)
  let attention;
  if (me.role !== "editor" && toReview.length) {
    const r = toReview[0];
    attention = h("section", { class: "attention o-attn", "aria-label": "Needs your attention" },
      h("a", { class: "lead", href: `#video-${r.videoId}` }, r.poster ? h("img", { src: r.poster, alt: "" }) : null,
        h("span", { style: "min-width:0" }, h("span", { class: "eyebrow" }, icon("clock", 14), "Ready for your review"), h("b", {}, `${r.title} · version ${r.latest.n}`))),
      h("ul", {}, toReview.length > 1 ? h("li", {}, `${toReview.length - 1} more video(s) waiting for review`) : null,
        openComments ? h("li", {}, `${openComments} open comment(s) across your videos`) : null,
        unassigned.length ? h("li", {}, h("a", { href: "#studio-board" }, `${unassigned.length} request(s) need an editor`)) : null,
        overdue.length ? h("li", {}, h("a", { href: "#studio-board" }, `${overdue.length} overdue`)) : null,
        soon.map((p) => h("li", {}, h("a", { href: `#project-${p.id}` }, p.name), ` · due ${fmtDate(p.due)}`))),
      h("a", { class: "btn primary lg block", href: `#video-${r.videoId}` }, "Review now"));
  } else if (me.role === "admin" && unassigned.length) {
    attention = h("section", { class: "attention o-attn", "aria-label": "Needs your attention" },
      h("span", { class: "eyebrow" }, icon("clock", 14), "Needs an editor"), h("b", { style: "font-family:var(--display);font-size:19px" }, unassigned[0].title),
      h("ul", {}, h("li", {}, `${unassigned.length} request(s) waiting for an editor`), overdue.length ? h("li", {}, `${overdue.length} overdue`) : null),
      h("a", { class: "btn primary lg block", href: "#studio-board" }, "Open the production board"));
  } else if (me.role === "editor" && mine.length) {
    const v = mine[0];
    attention = h("section", { class: "attention o-attn", style: "background:var(--sky)", "aria-label": "Your editing queue" },
      h("a", { class: "lead", href: `#video-${v.id}` }, v.poster ? h("img", { src: v.poster, alt: "" }) : null,
        h("span", { style: "min-width:0" }, h("span", { class: "eyebrow", style: "color:var(--sky-ink)" }, icon("pen", 14), v.status), h("b", {}, v.title))),
      h("ul", { style: "color:var(--sky-ink)" }, h("li", {}, `${v.done} of ${v.tasks} checklist tasks done`), mine.length > 1 ? h("li", {}, `${mine.length - 1} more in your queue`) : null),
      h("a", { class: "btn primary lg block", href: `#video-${v.id}` }, "Open the Editing Room"));
  } else {
    attention = h("section", { class: "attention calm o-attn", "aria-label": "Needs your attention" },
      h("span", { class: "eyebrow" }, icon("check", 14), "All caught up"), h("p", {}, "Nothing is waiting on you. A good moment to make something new."));
  }

  // 2 · What can I create?
  const create = h("nav", { class: "create o-create", "aria-label": "Create" },
    h("a", { class: "sky", href: "#library" }, icon("upload", 24), h("span", {}, "Upload footage")),
    me.role !== "editor" ? h("a", { class: "mint", href: "#request-new" }, icon("plus", 24), h("span", {}, "New editing request")) : h("a", { class: "mint", href: "#studio" }, icon("studio", 24), h("span", {}, "My projects")),
    me.role !== "editor" ? h("button", { class: "peach", onclick: () => composer(ws, ctx) }, icon("pen", 24), h("span", {}, "Draft a post")) : null,
    h("button", { class: "lilac", onclick: () => openMaven(ctx) }, icon("spark", 24), h("span", {}, "Ideas with Maven")));

  // 4 · What's new: the approved 14-day spotlight, and dismissible discovery
  const spotlight = spot ? h("section", { class: "spotlight o-spot", "aria-label": "Thought leadership spotlight" },
    h("div", { class: "art", "aria-hidden": "true" }, h("span", { class: "quote" }, "“"), h("span", { class: "chip" }, icon("spark", 13), "Spotlight")),
    h("div", { class: "body" },
      h("p", { class: "meta" }, h("b", { style: "color:var(--accent-strong)" }, "Thought leadership"), ` · changes every 14 days · featured until ${fmtDate(spot.until)}`),
      h("h2", {}, spot.title), h("p", { class: "muted" }, spot.body), h("p", { class: "small faint" }, spot.author),
      h("div", { class: "actions" },
        me.role !== "editor" ? h("button", { class: "btn dark", onclick: () => { remember("cue-request-draft", JSON.stringify({ type: "short", title: `Content from “${spot.title}”`,
          brief: `A short video built on this idea: ${spot.title}. ${spot.body}`, aspect: "9:16" })); ctx.go("request-new"); } }, icon("spark", 16), "Create something from this") : null,
        spot.lessonId ? h("a", { class: "btn ghost", href: `#lesson-${spot.lessonId}` }, icon("cap", 16), "Read more") : null),
      me.role === "admin" && spot.next ? h("span", { class: "tiny faint" }, `Next: “${spot.next.title}” on ${fmtDate(spot.next.start)}`) : null)) : null;
  const discover = notices.length ? h("section", { class: "discover o-discover", "aria-label": "Announcements" }, notices.map((n) => h("div", { class: "announce", "data-id": n.id, "data-kind": n.kind },
    h("a", { class: "announce-body", href: `#${n.link}` }, h("span", { class: "eyebrow" }, n.kind === "Tutorial" ? "Tutorial" : n.kind),
      h("b", {}, n.title), h("span", { class: "small muted" }, n.body), h("span", { class: "go" }, n.kind === "Tutorial" ? "Watch tutorial →" : "Explore idea →")),
    h("button", { class: "iconbtn", "aria-label": `Dismiss: ${n.title}`, onclick: async () => { await svc.dismiss(n.id); ctx.refresh(); } }, icon("x", 18))))) : null;

  // 5 · Where Maven can help (a suggestion, never an action)
  const approved = videos.find((v) => v.status === "Approved");
  const maven = me.role !== "editor" && approved ? h("section", { class: "maven-card o-maven", "aria-label": "Maven suggestion" },
    h("span", { class: "eyebrow" }, icon("spark", 14), "Maven suggests · nothing changes until you approve"),
    h("b", {}, `Turn “${approved.title}” into more posts`), h("p", { class: "small muted" }, "It's approved, so it can be reused. Maven lists ideas; you decide what gets requested."),
    h("button", { class: "btn sm", style: "justify-self:start;background:var(--surface)", onclick: () => openMaven(ctx, "Repurposing ideas") }, "See ideas")) : null;

  // 3 · What's happening with my content (media first)
  const recent = h("section", { class: "stack o-recent", "aria-label": "Recent content", style: "gap:12px" },
    h("div", { class: "section-head" }, h("h2", {}, "Recent content"), h("span", { class: "small faint" }, `${uploads.length} file(s)`)),
    uploaderFilter({ key: "cue", who, pick, me, uploaders, ctx }),
    uploads.length ? h("div", { class: "tiles" }, uploads.slice(0, 8).map((a) => mediaTile(a, vidStatus[a.videoId])))
      : empty(who === "mine" ? "You haven't uploaded anything" : "No uploads match", who === "mine" ? "Add footage in the Library." : "Try another filter.",
        h("a", { class: "btn", href: "#library" }, icon("upload", 18), "Open Library")));

  out.append(h("div", { class: "home" },
    h("header", { class: "home-head" },
      h("div", { class: "row", style: "justify-content:space-between;align-items:flex-end" },
        h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, ws.name),
          h("h1", {}, greet, h("em", {}, `${first}.`))),
        svc.workspaces().length > 1 ? wsPicker(() => ctx.rerenderShell()) : null),
      h("p", { class: "sub" }, waiting ? `${waiting} thing${waiting === 1 ? "" : "s"} need${waiting === 1 ? "s" : ""} you today.` : "You're all caught up."),
      h("button", { class: "btn search-launch", onclick: ctx.search }, icon("search", 18), "Search videos, projects, files and tutorials")),
    h("div", { class: "home-grid" },
      h("div", { class: "col" }, attention, create, spotlight, recent,
        h("section", { class: "stack o-feed", "aria-label": "Feed" }, h("div", { class: "section-head" }, h("h2", {}, "Feed"), h("span", { class: "small faint" }, `${feed.length} updates`)),
          feed.length ? h("div", { class: "feed" }, feed.map((f) => feedPost(f, ctx))) : empty("Quiet so far", "Uploads, deliverables and approvals will appear here."))),
      h("aside", { class: "col" }, maven, discover,
        h("section", { class: "card o-progress" }, h("h2", {}, "Videos in progress"),
          videos.length ? h("ul", { class: "list" }, videos.map((v) => h("li", {}, h("a", { class: "item", href: `#video-${v.id}` },
            h("span", { class: "thumb" }, v.poster ? h("img", { src: v.poster, alt: "" }) : icon("film", 22)),
            h("span", { class: "grow" }, h("span", { class: "title small" }, v.title), h("span", { class: "row", style: "gap:6px" }, statusBadge(v.status, v.status), h("span", { class: "tiny faint" }, `${v.done}/${v.tasks} tasks`))), icon("chevron", 18)))))
            : h("p", { class: "muted small" }, "No videos you can see yet.")),
        h("section", { class: "card o-notes" }, h("div", { class: "section-head" }, h("h2", {}, "Notifications"), h("a", { href: "#inbox", class: "small" }, "Inbox")),
          notes.slice(0, 3).length ? h("ul", { class: "list" }, notes.slice(0, 3).map((n) => h("li", {}, h("a", { class: "item", href: `#${n.link}` },
            h("span", { class: "grow" }, h("span", { class: "title small", style: n.read ? "font-weight:500" : "" }, n.text), h("span", { class: "tiny faint" }, ago(n.at)))))))
            : h("p", { class: "muted small" }, "You're all caught up."))))));
}

export function mediaTile(a, status) {
  const poster = a.mediaInfo?.poster;
  const badge = status ? statusBadge(status, status) : a.channel ? statusBadge("Approved", "Approved") : h("span", { class: "chip" }, a.videoId ? "Footage" : "Working file");
  return h("a", { class: "tile", href: a.videoId ? `#video-${a.videoId}` : `#asset-${a.id}` },
    h("span", { class: "poster" }, poster ? h("img", { src: poster, alt: "", loading: "lazy" }) : icon(kindIcon(a.kind), 34),
      h("span", { class: "chip" }, icon(kindIcon(a.kind), 13), a.kind[0].toUpperCase() + a.kind.slice(1))),
    h("span", { class: "tile-body" }, h("b", {}, a.name), badge, h("span", {}, `${a.byName || "Unknown"} · ${a.projectName || "Workspace library"}`), h("span", {}, ago(a.at))));
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
    f.asset?.mediaInfo?.poster ? h("a", { class: "post-media", href: f.asset.videoId ? `#video-${f.asset.videoId}` : `#asset-${f.asset.id}`, "aria-label": `Open ${f.asset.name}` },
      h("img", { src: f.asset.mediaInfo.poster, alt: `Preview of ${f.asset.name}`, loading: "lazy" })) : null,
    f.comments.length ? h("div", { class: "stack" }, f.comments.map((c) => h("div", { class: "comment" }, avatar(c.byName, true),
      h("div", { class: "bubble" }, h("b", { class: "small" }, c.byName), h("div", { class: "small" }, c.body))))) : null,
    h("div", { class: "post-actions" },
      h("button", { class: "btn ghost sm", onclick: () => { commentBox.hidden = !commentBox.hidden; if (!commentBox.hidden) input.focus(); } }, icon("message", 18), "Comment"),
      h("button", { class: "btn ghost sm", "aria-pressed": String(f.saved), onclick: async () => { try { await svc.toggleSave(f.id); toast(f.saved ? "Removed from saved" : "Saved"); ctx.refresh(); } catch (e) { toast(e.message, "err"); } } },
        icon("bookmark", 18), f.saved ? "Saved" : "Save"),
      f.asset ? h("a", { class: "btn ghost sm", href: f.asset.videoId ? `#video-${f.asset.videoId}` : `#asset-${f.asset.id}` }, icon("studio", 18), f.asset.videoId ? "Open Editing Room" : "Open file") : null,
      f.lessonId ? h("a", { class: "btn ghost sm", href: `#lesson-${f.lessonId}` }, icon("cap", 18), "Open tutorial") : null),
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
