// Menapoly Cue Studio preview: shell, navigation and router.
// Views are addressed by plain hash tokens (#home, #review-rv_launch, …) so links, deep links and the back button work.
import { h, icon, markSvg, sheet, toast, avatar, skeleton, errorState, ago } from "./ui.js";
import { svc } from "./service.js";
import { homeView, inboxView } from "./views-home.js";
import { studioView, assetView, libraryView, requestFormView } from "./views-studio.js";
import { reviewListView } from "./views-review.js";
import { projectView, roomView } from "./views-room.js";
import { socialView, visibilityView, askView, lessonView, clientsView, teamView, settingsView } from "./views-more.js";
import { mavenButton } from "./maven.js";

const NAV = [
  { token: "home", label: "Home", icon: "home", group: "Workspace" },
  { token: "studio", label: "Media Studio", short: "Studio", icon: "studio", group: "Workspace" },
  { token: "review", label: "Review", icon: "review", group: "Workspace" },
  { token: "social", label: "Social Sharing", icon: "share", group: "Workspace", roles: ["admin", "client"] },
  { token: "visibility", label: "AI Visibility", icon: "chart", group: "Workspace", roles: ["admin", "client"] },
  { token: "ask", label: "Ask Cue", icon: "spark", group: "Workspace" },
  { token: "library", label: "Library", icon: "grid", group: "Resources" },
  { token: "inbox", label: "Inbox", icon: "inbox", group: "Resources" },
  { token: "clients", label: "Clients", icon: "users", group: "Menapoly", roles: ["admin"] },
  { token: "team", label: "Team", icon: "team", group: "Menapoly", roles: ["admin"] },
  { token: "settings", label: "Settings", icon: "gear", group: "Menapoly" },
];
const BAR = ["home", "studio", "review", "ask"];
const allowed = (n) => !n.roles || n.roles.includes(svc.me().role);

const ROUTES = [
  [/^home$/, homeView], [/^studio$/, studioView], [/^request-new(?:-(p_[\w]+))?$/, requestFormView], [/^project-(p_[\w]+)$/, projectView],
  [/^video-(v_[\w]+)$/, roomView], [/^asset-(a_[\w]+)$/, assetOrRoom], [/^library$/, libraryView], [/^review$/, reviewListView], [/^review-(rv_[\w]+)$/, reviewToRoom],
  [/^social$/, socialView], [/^visibility(?:-([a-z]+))?$/, visibilityView], [/^ask$/, askView],
  [/^lesson-(l_[\w]+)$/, lessonView], [/^inbox$/, inboxView], [/^clients$/, clientsView], [/^team$/, teamView], [/^settings$/, settingsView],
];

const root = document.getElementById("app");
let nav = 0;
export const go = (token) => { if (location.hash.slice(1) === token) render(); else location.hash = token; };
export const ctx = { go, refresh: () => render(), rerenderShell: () => { buildShell(); render(); }, search: () => searchSheet() };

function current() { return location.hash.slice(1) || "home"; }
function section(token) { return token.split("-")[0].replace(/^asset$|^project$|^request$|^video$/, "studio").replace(/^lesson$/, "home"); }

// Older links (review rooms, video files) open the video's Editing Room; replace() keeps the back button clean.
async function reviewToRoom(out, [rid]) {
  const vid = svc.videoForReview(rid);
  if (!vid) { const e = new Error("That review doesn't exist."); e.code = 404; throw e; }
  location.replace(`#video-${vid}`);
}
async function assetOrRoom(out, [aid], ctx) {
  const vid = svc.videoForAsset(aid);
  if (vid) { location.replace(`#video-${vid}`); return; }
  return assetView(out, [aid], ctx);
}

function roleSheet() {
  const me = svc.me();
  const d = sheet("Switch demo role",
    h("p", { class: "muted small" }, "The preview has five fictional people. Each sees only what their role allows; the same rules will run on the server."),
    h("ul", { class: "list" }, svc.users().map((u) => h("li", {}, h("button", { class: "item", style: "width:100%;background:none;border:0;color:inherit;text-align:left;cursor:pointer;min-height:56px",
      "aria-current": u.id === me.id ? "true" : null, onclick: () => { svc.switchUser(u.id); d.close(); toast(`Viewing as ${u.name} (${u.role})`); ctx.rerenderShell(); } },
      avatar(u.name), h("span", { class: "grow" }, h("span", { class: "title" }, u.name), h("span", { class: "small faint" }, `${u.role[0].toUpperCase() + u.role.slice(1)} · ${u.title}`)),
      u.id === me.id ? h("span", { class: "chip accent" }, "Current") : icon("chevron", 18))))));
  return d;
}

export function searchSheet() {
  const results = h("div", { class: "stack" });
  const input = h("input", { id: "global-search", type: "search", placeholder: "Search projects, media, reviews, lessons", autocomplete: "off", "aria-label": "Search everything" });
  let timer;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(async () => {
    const q = input.value.trim();
    if (!q) { results.replaceChildren(); return; }
    results.replaceChildren(skeleton(2));
    try {
      const hits = await svc.search(q);
      results.replaceChildren(hits.length ? h("ul", { class: "list" }, hits.map((x) => h("li", {}, h("a", { class: "item", href: `#${x.link}`, onclick: () => d.close() },
        h("span", { class: "thumb" }, icon({ Project: "studio", Media: "film", Video: "film", Review: "review", Tutorial: "cap" }[x.type] || "doc", 22)),
        h("span", { class: "grow" }, h("span", { class: "title" }, x.title), h("span", { class: "small faint" }, `${x.type} · ${x.sub}`)), icon("chevron", 18)))))
        : h("div", { class: "state" }, icon("search", 26), h("h3", {}, "No matches"), h("p", { class: "muted small" }, `Nothing you can access matches “${q}”.`)));
    } catch (e) { results.replaceChildren(errorState(e)); }
  }, 180); });
  const d = sheet("Search", h("div", { class: "search" }, icon("search", 18), input), results);
  setTimeout(() => input.focus(), 50);
  return d;
}

function moreSheet() {
  const d = sheet("More", h("ul", { class: "list" }, NAV.filter((n) => !BAR.includes(n.token) && allowed(n)).map((n) =>
    h("li", {}, h("a", { class: "item", href: `#${n.token}`, onclick: () => d.close() }, h("span", { class: "thumb" }, icon(n.icon, 22)),
      h("span", { class: "grow" }, h("span", { class: "title" }, n.label)), icon("chevron", 18))))));
}

function buildShell() {
  const me = svc.me(), unread = svc.unread(), ws = svc.currentWs();
  const tok = section(current());
  root.replaceChildren(
    h("nav", { class: "rail", "aria-label": "Main" },
      h("a", { class: "brand", href: "#home" }, h("span", { class: "mark" }, markSvg()), h("span", {}, h("b", {}, "Menapoly Cue"), h("small", {}, "Studio preview"))),
      ...["Workspace", "Resources", "Menapoly"].flatMap((g) => {
        const items = NAV.filter((n) => n.group === g && allowed(n));
        return items.length ? [h("div", { class: "group" }, g), ...items.map((n) => h("a", { href: `#${n.token}`, class: tok === n.token ? "on" : "", "aria-current": tok === n.token ? "page" : null },
          icon(n.icon, 20), n.label, n.token === "inbox" && unread ? h("span", { class: "count" }, unread) : null))] : [];
      })),
    h("div", { class: "app" },
      h("header", { class: "top" },
        h("div", { class: "top-inner" },
          h("a", { class: "brand", href: "#home", "aria-label": "Menapoly Cue home" }, h("span", { class: "mark" }, markSvg()), h("span", { class: "brand-text" }, h("b", {}, "Cue"))),
          h("div", { class: "grow" }),
          h("button", { class: "top-search btn ghost", style: "justify-content:flex-start;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--faint)", onclick: searchSheet },
            icon("search", 18), "Search projects, media, reviews…"),
          mavenButton(ctx),
          h("button", { class: "iconbtn search-btn", "aria-label": "Search", onclick: searchSheet }, icon("search", 22)),
          h("a", { class: "iconbtn", href: "#inbox", "aria-label": unread ? `Inbox, ${unread} unread` : "Inbox" }, icon("bell", 22), unread ? h("span", { class: "dot" }) : null),
          h("button", { class: "role-chip", onclick: roleSheet, "aria-label": `Signed in as ${me.name}, ${me.role}. Switch demo role` }, avatar(me.name),
            h("span", { class: "who" }, h("b", {}, me.name.split(" ")[0]), h("span", {}, me.role === "admin" ? "Admin" : me.role === "editor" ? "Editor" : ws?.name || "Client")))),
        h("div", { class: "demo-strip", role: "note" }, icon("alert", 16), "Preview · fictional data · nothing leaves this device",
          h("button", { onclick: () => go("settings") }, "Details"))),
      h("main", { id: "main", tabindex: "-1" }),
      h("nav", { class: "bar", "aria-label": "Main" },
        ...BAR.map((t) => { const n = NAV.find((x) => x.token === t);
          return h("a", { href: `#${t}`, class: tok === t ? "on" : "", "aria-current": tok === t ? "page" : null }, icon(n.icon, 22), h("span", {}, n.short || n.label)); }),
        h("button", { class: BAR.includes(tok) ? "" : "on", onclick: moreSheet, "aria-label": "More sections" }, icon("more", 22), h("span", {}, "More")))));
}

let lastToken = null;
async function render() {
  const token = current(), my = ++nav;
  // Moving to another page (including the back button) closes open sheets; refreshing the same page keeps them.
  if (token !== lastToken) document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  lastToken = token;
  const main = document.getElementById("main") || (buildShell(), document.getElementById("main"));
  buildShellMarkers();
  const navItem = NAV.find((n) => n.token === section(token));
  if (navItem && !allowed(navItem)) {
    main.replaceChildren(errorState({ code: 403 }));
    return;
  }
  const match = ROUTES.find(([re]) => re.test(token));
  if (!match) { main.replaceChildren(errorState({ code: 404, message: "That page doesn't exist in the preview." }), h("a", { class: "btn", href: "#home" }, "Go home")); return; }
  const params = token.match(match[0]).slice(1);
  main.replaceChildren(skeleton(3));
  try {
    const out = h("div", { class: "stack", style: "gap:18px" });
    await match[1](out, params, { ...ctx, isCurrent: () => my === nav });
    if (my !== nav) return;
    main.replaceChildren(...out.childNodes);
    window.scrollTo({ top: 0 });
  } catch (e) {
    if (my !== nav) return;
    main.replaceChildren(errorState(e, () => render()));
  }
}

function buildShellMarkers() {
  const tok = section(current());
  document.querySelectorAll(".rail a[href^='#'], .bar a").forEach((a) => {
    const on = a.getAttribute("href") === `#${tok}`;
    a.classList.toggle("on", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const more = document.querySelector(".bar button"); if (more) more.classList.toggle("on", !BAR.includes(tok));
  const unread = svc.unread(), dot = document.querySelector(".top a[href='#inbox']");
  if (dot) { dot.querySelector(".dot")?.remove(); if (unread) dot.append(h("span", { class: "dot" })); }
}

window.addEventListener("hashchange", render);
buildShell();
render();
export { ago };
