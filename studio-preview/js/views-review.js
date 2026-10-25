// Review: the list of videos waiting for review. Each one opens its Editing Room (views-room.js).
import { h, icon, empty } from "./ui.js";
import { svc } from "./service.js";

export async function reviewListView(out) {
  const reviews = await svc.reviews();
  const filter = (() => { try { return sessionStorage.getItem("cue-review-filter") || "open"; } catch { return "open"; } })();
  const shown = reviews.filter((r) => filter === "all" || (filter === "open" ? r.status !== "Approved" : r.status === "Approved"));
  out.append(h("div", { class: "stack", style: "gap:4px" }, h("span", { class: "eyebrow" }, "Review"), h("h1", {}, "Cuts to review")),
    h("div", { class: "tabs", role: "tablist", "aria-label": "Filter reviews" }, [["open", "Open"], ["approved", "Approved"], ["all", "All"]].map(([k, l]) =>
      h("button", { class: "tab", role: "tab", "aria-selected": String(filter === k), onclick: () => { try { sessionStorage.setItem("cue-review-filter", k); } catch { /* ignore */ } dispatchEvent(new HashChangeEvent("hashchange")); } }, l))),
    shown.length ? h("div", { class: "tiles" }, shown.map((r) => h("a", { class: "tile", href: `#video-${r.videoId}` },
      h("span", { class: "poster" }, r.poster ? h("img", { src: r.poster, alt: "" }) : icon("film", 30), h("span", { class: "chip" }, r.latest.n ? `v${r.latest.n}` : "Original")),
      h("b", {}, r.title), h("span", {}, `${r.status} · ${r.open} open comment(s)`))))
      : empty(filter === "open" ? "Nothing to review" : "No reviews here", filter === "open" ? "New cuts land here when an editor submits them." : "Approved cuts appear here."));
}
