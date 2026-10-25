// Small UI toolkit: element builder, icons, toasts, sheets, states and SVG charts. No dependencies.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // only ever used with constant markup
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const P = {
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V21h14V9.5", "M10 21v-6h4v6"],
  studio: ["M4 5h16v14H4z", "M10 9.5v5l4-2.5z"],
  review: ["M3 12s3.5-6.5 9-6.5S21 12 21 12s-3.5 6.5-9 6.5S3 12 3 12z", "M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"],
  share: ["M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M8.6 13.5l6.8 4", "M15.4 6.5l-6.8 4"],
  chart: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
  spark: ["M12 2.5l2 5.6 5.6 2-5.6 2-2 5.6-2-5.6-5.6-2 5.6-2z", "M19 15.5l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z"],
  cap: ["M2 9l10-5 10 5-10 5z", "M6 11v5c3 2 9 2 12 0v-5"],
  grid: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  bell: ["M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8", "M10 20a2 2 0 0 0 4 0"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M22 21v-2a4 4 0 0 0-3-3.9", "M16 3.1a4 4 0 0 1 0 7.8"],
  team: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"],
  gear: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"],
  plus: ["M12 5v14", "M5 12h14"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  back: ["M15 18l-6-6 6-6"],
  chevron: ["M9 18l6-6-6-6"],
  play: ["M7 4l13 8-13 8z"],
  pause: ["M7 4h4v16H7z", "M14 4h4v16h-4z"],
  upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M17 8l-5-5-5 5", "M12 3v12"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  film: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M7 3v18", "M17 3v18", "M3 8h4", "M3 16h4", "M17 8h4", "M17 16h4"],
  wave: ["M2 12h2", "M6 8v8", "M10 5v14", "M14 9v6", "M18 7v10", "M22 12h-2"],
  image: ["M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5L5 21"],
  doc: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6", "M8 13h8", "M8 17h5"],
  check: ["M20 6 9 17l-5-5"],
  message: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  pen: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
  box: ["M4 4h16v16H4z"],
  bookmark: ["M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  calendar: ["M3 5h18v16H3z", "M16 3v4", "M8 3v4", "M3 10h18"],
  send: ["M22 2 11 13", "M22 2l-7 20-4-9-9-4z"],
  compare: ["M3 4h8v16H3z", "M13 4h8v16h-8z"],
  refresh: ["M21 12a9 9 0 1 1-3-6.7L21 8", "M21 3v5h-5"],
  layers: ["M12 2 2 7l10 5 10-5z", "M2 17l10 5 10-5", "M2 12l10 5 10-5"],
  tag: ["M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z", "M7 7h.01"],
  volume: ["M11 5 6 9H2v6h4l5 4z", "M15.5 8.5a5 5 0 0 1 0 7", "M19 5a10 10 0 0 1 0 14"],
  mute: ["M11 5 6 9H2v6h4l5 4z", "M23 9l-6 6", "M17 9l6 6"],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"],
};
export function icon(name, size = 20) {
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8,
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: "icon" })) svg.setAttribute(k, v);
  for (const d of P[name] || []) { const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); svg.append(p); }
  return svg;
}
export const markSvg = () => { const s = icon("spark", 20); s.setAttribute("stroke-width", "2.2"); return s; };

let toastBox;
export function toast(text, kind = "ok") {
  toastBox ||= document.body.appendChild(h("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  const t = h("div", { class: `toast ${kind === "err" ? "err" : ""}` }, text);
  toastBox.append(t); setTimeout(() => t.remove(), kind === "err" ? 6000 : 3200);
}

/** Runs an async action once: the button is disabled and marked busy until it settles, so a double tap can't send twice. */
export function busy(fn) {
  return async (e) => {
    const b = e?.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    if (b?.dataset.busy) return;
    if (b) { b.dataset.busy = "1"; b.disabled = true; b.setAttribute("aria-busy", "true"); }
    try { await fn(e); } finally { if (b) { delete b.dataset.busy; b.disabled = false; b.removeAttribute("aria-busy"); } }
  };
}

export function sheet(title, ...content) {
  const d = h("dialog", { class: "sheet", "aria-label": title },
    h("div", { class: "sheet-head" }, h("h2", {}, title), h("button", { class: "iconbtn", "aria-label": "Close", onclick: () => d.close() }, icon("x", 22))),
    h("div", { class: "sheet-body" }, ...content));
  d.addEventListener("close", () => { d.querySelectorAll("video").forEach((v) => v.pause()); d.remove(); });
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  document.body.append(d); d.showModal();
  return d;
}

export const skeleton = (rows = 3) => h("div", { class: "stack", "aria-busy": "true", "aria-label": "Loading" },
  Array.from({ length: rows }, (_, i) => h("div", { class: "skel", style: `height:${i === 0 ? 120 : 64}px` })));
export const empty = (title, text, action) => h("div", { class: "state" }, icon("layers", 28), h("h3", {}, title), h("p", { class: "muted small" }, text), action || null);
export function errorState(err, retry) {
  if (err?.code === 403) return h("div", { class: "state denied", role: "alert" }, icon("lock", 28), h("h3", {}, "You don't have access to this"),
    h("p", { class: "muted small" }, "Your role can't open this item. Ask a Menapoly administrator if you need it."));
  if (err?.code === 404) return h("div", { class: "state", role: "alert" }, icon("alert", 28), h("h3", {}, "Not found"), h("p", { class: "muted small" }, err.message));
  return h("div", { class: "state error", role: "alert" }, icon("alert", 28), h("h3", {}, "Couldn't load this"), h("p", { class: "muted small" }, err?.message || "Something went wrong."),
    retry ? h("button", { class: "btn", onclick: retry }, icon("refresh", 18), "Try again") : null);
}
export const demoBadge = (text = "Simulated") => h("span", { class: "chip demo", title: "This action is simulated in the preview" }, text);
export const fictional = () => h("span", { class: "demo-label" }, "Fictional demo data");

export function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400); return d === 1 ? "yesterday" : `${d} days ago`;
}
export const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export function bytes(n) { const u = ["B", "KB", "MB", "GB"]; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; }
export const initials = (name) => name.split(" ").map((x) => x[0]).join("").slice(0, 2).toUpperCase();
export const avatar = (name, sm) => h("span", { class: `avatar ${sm ? "sm" : ""}`, "aria-hidden": "true" }, initials(name));
export const kindIcon = (k) => ({ video: "film", audio: "wave", image: "image", document: "doc" }[k] || "doc");
export const statusTone = (s) => /review|awaiting/i.test(s) ? "warn" : /changes|revision|overdue/i.test(s) ? "danger" : /approved|ready|done|complete|delivered/i.test(s) ? "ok"
  : /edit|progress|assigned/i.test(s) ? "info" : /waiting|brief|requested|submitted/i.test(s) ? "accent" : "";
/** One status language for projects and videos: a tone (colour) plus plain words, so colour is never the only signal. */
export function statusInfo(s) {
  if (/review/i.test(s)) return { tone: "review", label: "Ready for review", icon: "clock" };
  if (/changes|revision/i.test(s)) return { tone: "changes", label: "Changes requested", icon: "message" };
  if (/approved|done|complete|delivered/i.test(s)) return { tone: "done", label: "Completed", icon: "check" };
  if (/edit|progress|assigned/i.test(s)) return { tone: "editing", label: "Being edited", icon: "pen" };
  return { tone: "waiting", label: /brief/i.test(s) ? "Awaiting footage" : "Waiting to start", icon: "upload" };
}
export const statusBadge = (s, label) => { const i = statusInfo(s); return h("span", { class: "status", "data-tone": i.tone }, icon(i.icon, 13), label || i.label); };
export async function copyText(text, el) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch { if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } toast("Select the highlighted text and copy it", "err"); }
}

/* ---------- charts (SVG, one scale per chart) ---------- */
const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); kids.forEach((k) => e.append(k)); return e; };
const txt = (x, y, t, anchor = "middle") => { const e = s("text", { x, y, "text-anchor": anchor }); e.textContent = t; return e; };
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(Math.max(1, v))); return Math.ceil(v / p) * p; }

export function lineChart({ labels, series, height = 200, label }) {
  const W = 640, H = height, L = 44, R = 12, T = 12, B = 26;
  const max = niceMax(Math.max(...series.flatMap((x) => x.values)));
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, labels.length - 1), y = (v) => T + (H - T - B) * (1 - v / max);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": label });
  const grid = s("g", { class: "grid" });
  for (let k = 0; k <= 4; k++) { const v = (max * k) / 4; grid.append(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) })); svg.append(txt(L - 8, y(v) + 4, Math.round(v).toLocaleString(), "end")); }
  svg.prepend(grid);
  labels.forEach((l, i) => { if (labels.length <= 8 || i % Math.ceil(labels.length / 8) === 0 || i === labels.length - 1) svg.append(txt(x(i), H - 6, l)); });
  series.forEach((ser) => {
    const pts = ser.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    if (ser.area) svg.append(s("polygon", { points: `${x(0)},${y(0)} ${pts} ${x(ser.values.length - 1)},${y(0)}`, fill: ser.color, "fill-opacity": 0.14 }));
    svg.append(s("polyline", { points: pts, fill: "none", stroke: ser.color, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const li = ser.values.length - 1;
    svg.append(s("circle", { cx: x(li), cy: y(ser.values[li]), r: 4.5, fill: ser.color, stroke: "#FFFFFF", "stroke-width": 2 }));
  });
  return svg;
}

export function barChart({ items, max: mx, height, unit = "", label, color = "#6D3FE0" }) {
  const W = 640, row = 34, H = height || items.length * row + 8, L = 170, R = 56;
  const max = mx || niceMax(Math.max(...items.map((i) => i.value)));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": label });
  items.forEach((it, i) => {
    const y = 4 + i * row, w = ((W - L - R) * it.value) / max;
    svg.append(txt(L - 10, y + 19, it.label.length > 24 ? it.label.slice(0, 23) + "…" : it.label, "end"));
    svg.append(s("rect", { x: L, y: y + 6, width: W - L - R, height: 18, rx: 6, fill: "#EEEAF9" }));
    svg.append(s("rect", { x: L, y: y + 6, width: Math.max(2, w), height: 18, rx: 6, fill: it.color || color }));
    svg.append(txt(L + Math.max(2, w) + 8, y + 19, `${it.value}${unit}`, "start"));
  });
  return svg;
}

export function donut({ items, label, size = 180 }) {
  const total = items.reduce((a, b) => a + b.value, 0), r = 62, c = 2 * Math.PI * r;
  const svg = s("svg", { viewBox: "0 0 180 180", width: size, height: size, class: "chart", role: "img", "aria-label": label, style: `max-width:${size}px` });
  let off = 0;
  items.forEach((it) => { const len = (it.value / total) * c;
    svg.append(s("circle", { cx: 90, cy: 90, r, fill: "none", stroke: it.color, "stroke-width": 22, "stroke-dasharray": `${len} ${c - len}`, "stroke-dashoffset": -off, transform: "rotate(-90 90 90)" }));
    off += len; });
  return svg;
}
// Chart colours: each ≥ 3:1 against white so marks stay visible; series are also named in a legend.
export const PALETTE = ["#6D3FE0", "#2F7FC6", "#11786A", "#B7791F", "#C9405A", "#8657F2"];
