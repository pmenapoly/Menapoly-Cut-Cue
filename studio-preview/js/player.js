// Video player component for the Editing Room: custom touch-sized controls, comment markers on the timeline and a
// drawing layer for frame annotations. Reused by the room and the compare sheet; no dependencies.
import { h, icon, toast } from "./ui.js";

export const fmtTime = (t) => { const s = Math.max(0, Number.isFinite(t) ? t : 0); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Fill a <video> with H.264 and VP9 sources; the browser plays the first one it supports. */
export function setSources(video, media) {
  video.replaceChildren(
    h("source", { src: media.src, type: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' }),
    media.webm ? h("source", { src: media.webm, type: 'video/webm; codecs="vp9, opus"' }) : null);
  video.poster = media.poster || "";
  video.load();
}

/**
 * createPlayer({ media, label, markers, onMarker, onTime })
 *  markers(): [{ id, t, resolved, label }]   onMarker(id)   onTime(seconds)
 * Returns { el, video, setMedia, seek, pause, time, annotate: { setTool, draft, clear, showShapes } }.
 */
export function createPlayer({ media, label, markers = () => [], onMarker = () => {}, onTime = () => {} }) {
  const video = h("video", { playsinline: true, preload: "metadata", "aria-label": label, tabindex: "-1" });
  const canvas = h("canvas", { class: "vp-draw", "aria-hidden": "true" });
  const stage = h("div", { class: "vp-stage" }, video, canvas);
  const el = h("div", { class: "vp", role: "region", "aria-label": `Player: ${label}` });
  let duration = media.duration || 0, tool = null, draft = null, start = null, shapes = () => [];

  // ---- controls ----
  const playBtn = h("button", { class: "vp-btn", "aria-label": "Play", "aria-pressed": "false" }, icon("play", 22));
  const time = h("span", { class: "vp-time mono", "aria-live": "off" }, "0:00.0 / 0:00.0");
  const track = h("div", { class: "vp-track", role: "slider", tabindex: "0", "aria-label": "Seek", "aria-valuemin": "0", "aria-valuenow": "0" });
  // Comment pins are buttons, so they sit in a layer over the slider rather than inside it (no nested controls).
  const pins = h("div", { class: "vp-pins" });
  const mute = h("button", { class: "vp-btn", "aria-label": "Mute", "aria-pressed": "false" }, icon("volume", 20));
  const vol = h("input", { class: "vp-vol", type: "range", min: "0", max: "1", step: "0.05", value: "1", "aria-label": "Volume" });
  const speed = h("select", { class: "vp-speed", "aria-label": "Playback speed" }, SPEEDS.map((s) => h("option", { value: String(s), selected: s === 1 }, `${s}×`)));
  const full = h("button", { class: "vp-btn", "aria-label": "Full screen" }, icon("expand", 20));
  el.append(stage, h("div", { class: "vp-bar" }, h("div", { class: "vp-seek" }, h("div", { class: "vp-scrub" }, track, pins), time),
    h("div", { class: "vp-row" }, playBtn, h("span", { class: "vp-gap" }), mute, vol, speed, full)));

  const toggle = async () => {
    if (video.paused) { try { await video.play(); } catch { toast("This video can't play in this browser.", "err"); } } else video.pause();
  };
  playBtn.addEventListener("click", toggle);
  stage.addEventListener("click", () => { if (!tool) toggle(); });
  video.addEventListener("play", () => { playBtn.replaceChildren(icon("pause", 22)); playBtn.setAttribute("aria-label", "Pause"); playBtn.setAttribute("aria-pressed", "true"); });
  video.addEventListener("pause", () => { playBtn.replaceChildren(icon("play", 22)); playBtn.setAttribute("aria-label", "Play"); playBtn.setAttribute("aria-pressed", "false"); });
  mute.addEventListener("click", () => { video.muted = !video.muted; mute.setAttribute("aria-pressed", String(video.muted)); mute.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    mute.replaceChildren(icon(video.muted ? "mute" : "volume", 20)); });
  vol.addEventListener("input", () => { video.volume = Number(vol.value); if (video.muted && video.volume > 0) mute.click(); });
  speed.addEventListener("change", () => { video.playbackRate = Number(speed.value); });
  full.addEventListener("click", async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await el.requestFullscreen(); }
    catch { toast("Full screen isn't available here. Rotate your phone for a bigger picture.", "err"); }
  });

  const drawTrack = () => {
    const d = video.duration || duration || 1, t = video.currentTime || 0;
    track.setAttribute("aria-valuemax", String(Math.round(d))); track.setAttribute("aria-valuenow", String(Math.round(t)));
    track.setAttribute("aria-valuetext", `${fmtTime(t)} of ${fmtTime(d)}`);
    track.replaceChildren(h("span", { class: "vp-played", style: `width:${(t / d) * 100}%` }));
    pins.replaceChildren(...markers().map((m) => h("button", { class: `vp-pin ${m.resolved ? "resolved" : ""}`, style: `left:${Math.min(100, (m.t / d) * 100)}%`, "aria-label": m.label,
        onclick: (e) => { e.stopPropagation(); onMarker(m.id); } })));
    time.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
  };
  const seekAt = (x) => { const b = track.getBoundingClientRect(), d = video.duration || duration || 1; video.currentTime = Math.min(d, Math.max(0, ((x - b.left) / b.width) * d)); drawTrack(); paint(); };
  track.addEventListener("pointerdown", (e) => { if (e.target.classList.contains("vp-pin")) return; video.pause(); seekAt(e.clientX); });
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); video.currentTime = Math.max(0, Math.min(video.duration || duration, video.currentTime + (e.key === "ArrowRight" ? 1 : -1))); }
  });
  video.addEventListener("timeupdate", () => { drawTrack(); paint(); onTime(video.currentTime); });
  video.addEventListener("loadedmetadata", () => { duration = video.duration || duration; drawTrack(); size(); });
  video.addEventListener("ratechange", () => { speed.value = String(video.playbackRate); });

  // ---- drawing layer ----
  function size() { const b = stage.getBoundingClientRect(), r = devicePixelRatio || 1; canvas.width = Math.round(b.width * r); canvas.height = Math.round(b.height * r); paint(); }
  function stroke(g, s, color) {
    const W = canvas.width, H = canvas.height; g.strokeStyle = color; g.lineWidth = 3 * (devicePixelRatio || 1); g.lineJoin = g.lineCap = "round";
    if (s.type === "rect") g.strokeRect(s.x * W, s.y * H, s.w * W, s.h * H);
    else if (s.points?.length) { g.beginPath(); s.points.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H))); g.stroke(); }
  }
  function paint() {
    const g = canvas.getContext("2d"); if (!g) return; g.clearRect(0, 0, canvas.width, canvas.height);
    shapes(video.currentTime || 0).forEach((s) => stroke(g, s.shape, s.active ? "rgb(168 140 255)" : "rgb(210 196 255)"));
    if (draft) stroke(g, draft, "rgb(244 195 90)");
  }
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))]; };
  canvas.addEventListener("pointerdown", (e) => { if (!tool) return; e.preventDefault(); canvas.setPointerCapture(e.pointerId); start = pos(e);
    draft = tool === "rect" ? { type: "rect", x: start[0], y: start[1], w: 0, h: 0 } : { type: "pen", points: [start] }; paint(); });
  canvas.addEventListener("pointermove", (e) => { if (!start || !draft) return; const [x, y] = pos(e);
    if (draft.type === "rect") Object.assign(draft, { x: Math.min(x, start[0]), y: Math.min(y, start[1]), w: Math.abs(x - start[0]), h: Math.abs(y - start[1]) });
    else if (draft.points.length < 400) draft.points.push([+x.toFixed(4), +y.toFixed(4)]);
    paint(); });
  canvas.addEventListener("pointerup", () => { start = null; if (draft?.type === "rect" && (draft.w < 0.02 || draft.h < 0.02)) draft = null; paint(); el.dispatchEvent(new CustomEvent("draft")); });
  new ResizeObserver(size).observe(stage);

  setSources(video, media);
  drawTrack();
  return {
    el, video,
    setMedia(m, label2) { duration = m.duration || 0; video.pause(); setSources(video, m); video.setAttribute("aria-label", label2 || label); drawTrack(); },
    seek(t) { video.pause(); video.currentTime = t; drawTrack(); paint(); },
    pause() { video.pause(); },
    time: () => video.currentTime || 0,
    refresh() { drawTrack(); paint(); },
    annotate: {
      setTool(t) { tool = t; canvas.classList.toggle("on", Boolean(t)); if (t) video.pause(); },
      tool: () => tool,
      draft: () => draft,
      clear() { draft = null; paint(); },
      showShapes(fn) { shapes = fn; paint(); },
    },
  };
}
