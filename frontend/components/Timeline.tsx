"use client";
// Cue Pro timeline: video (thumbnails), audio (waveforms), captions and music tracks; drag to reorder,
// drag edges to trim, split at the playhead, keyboard editing. Pure edits go through the shared store.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, Asset, Clip, frameUrl, Segment, Timeline as TL, Waveform } from "@/lib/api";
import { duration as fmt } from "@/lib/format";
import { clipLength, clipOffsets, insertClip, moveClip, previewCues, totalDuration, trimClip } from "@/lib/timeline";
import { Icon } from "./ui";

const waveCache = new Map<string, Promise<Waveform>>();
function useWaveform(pid: string, asset: Asset | undefined) {
  const [wf, setWf] = useState<Waveform | null>(null);
  useEffect(() => {
    if (!asset?.has_audio || asset.status !== "ready") return;
    const key = `${pid}/${asset.id}`;
    if (!waveCache.has(key)) {
      const points = Math.min(8000, Math.max(200, Math.round((asset.duration ?? 60) * 10)));
      waveCache.set(key, api.get<Waveform>(`/projects/${pid}/assets/${asset.id}/waveform?points=${points}`));
    }
    let alive = true;
    waveCache.get(key)!.then((w) => alive && setWf(w)).catch(() => waveCache.delete(key));
    return () => { alive = false; };
  }, [pid, asset?.id, asset?.status, asset?.has_audio, asset?.duration]);
  return wf;
}

function WaveSlice({ pid, asset, start, end, width, color = "#2fb8a3" }: { pid: string; asset?: Asset; start: number; end: number; width: number; color?: string }) {
  const wf = useWaveform(pid, asset);
  const bars = Math.max(4, Math.floor(width / 3));
  const path = useMemo(() => {
    if (!wf || !wf.peaks.length) return "";
    const per = wf.peaks.length / (wf.duration || 1);
    let d = "";
    for (let i = 0; i < bars; i++) {
      const t0 = start + ((end - start) * i) / bars, t1 = start + ((end - start) * (i + 1)) / bars;
      const a = Math.floor(t0 * per), b = Math.max(a + 1, Math.ceil(t1 * per));
      let peak = 0;
      for (let k = a; k < b && k < wf.peaks.length; k++) peak = Math.max(peak, wf.peaks[k]);
      const h = Math.max(1, peak * 26);
      d += `M${i * 3 + 1} ${16 - h / 2}v${h}`;
    }
    return d;
  }, [wf, start, end, bars]);
  if (!wf) return <div className="skeleton absolute inset-1 opacity-40" />;
  return (
    <svg width={width} height={32} className="pointer-events-none absolute inset-0" aria-hidden>
      <path d={path} stroke={color} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

function Filmstrip({ pid, asset, clip, width }: { pid: string; asset?: Asset; clip: Clip; width: number }) {
  if (!asset?.has_video) {
    return <div className="flex h-full items-center gap-1 px-2 text-[11px] text-white/80"><Icon name="wave" size={13} /> Audio</div>;
  }
  const frames = Math.max(1, Math.min(12, Math.floor(width / 72)));
  return (
    <div className="pointer-events-none absolute inset-0 flex">
      {Array.from({ length: frames }, (_, i) => (
        <img key={i} src={frameUrl(pid, asset.id, clip.start + (clipLength(clip) * (i + 0.5)) / frames)} alt="" loading="lazy" draggable={false}
             className="h-full min-w-0 flex-1 object-cover opacity-80" />
      ))}
    </div>
  );
}

type Drag = { kind: "move"; index: number; startX: number; dx: number } | { kind: "trim"; index: number; edge: "start" | "end"; startX: number; dx: number } | { kind: "scrub" };

export function Timeline({ pid, timeline, assets, segments, playhead, onSeek, onEdit, selected, onSelect }: {
  pid: string; timeline: TL; assets: Asset[]; segments: Record<string, Segment[]>; playhead: number;
  onSeek: (t: number) => void; onEdit: (t: TL) => void; selected: number | null; onSelect: (i: number | null) => void;
}) {
  const total = totalDuration(timeline);
  const [zoom, setZoom] = useState(0);  // 0 = fit, otherwise px per second
  const scroller = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState(800);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFitWidth(Math.max(200, el.clientWidth - 80)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pps = zoom || Math.max(2, fitWidth / Math.max(total, 1));
  const offsets = clipOffsets(timeline);
  const assetById = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a])), [assets]);
  const cues = useMemo(() => previewCues(timeline, segments, timeline.aspect === "9:16" ? 28 : 42), [timeline, segments]);
  const width = Math.max(total * pps, 10);

  // Live geometry while dragging.
  const geometry = timeline.clips.map((c, i) => {
    let start = offsets[i] * pps, w = clipLength(c) * pps;
    if (drag?.kind === "trim" && drag.index === i) {
      if (drag.edge === "end") w = Math.max(4, w + drag.dx);
      else { w = Math.max(4, w - drag.dx); }
    }
    if (drag?.kind === "move" && drag.index === i) start += drag.dx;
    return { left: start, width: w };
  });

  const pointToTime = (clientX: number) => {
    const el = scroller.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - rect.left + el.scrollLeft - 80) / pps));
  };
  const dropSlot = (clientX: number) => {
    const t = pointToTime(clientX);
    for (let i = 0; i < timeline.clips.length; i++) if (t < offsets[i] + clipLength(timeline.clips[i]) / 2) return i;
    return timeline.clips.length;
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (drag.kind === "scrub") { onSeek(pointToTime(e.clientX)); return; }
      setDrag({ ...drag, dx: e.clientX - drag.startX });
      if (drag.kind === "move") setDropIndex(dropSlot(e.clientX));
    };
    const up = (e: PointerEvent) => {
      if (drag.kind === "trim") {
        const c = timeline.clips[drag.index];
        const delta = (e.clientX - drag.startX) / pps;
        const src = assetById[c.asset_id]?.duration ?? c.end;
        if (Math.abs(delta) > 0.02) onEdit(trimClip(timeline, drag.index, drag.edge, drag.edge === "start" ? c.start + delta : c.end + delta, src));
      } else if (drag.kind === "move") {
        const slot = dropSlot(e.clientX);
        const to = slot > drag.index ? slot - 1 : slot;
        if (Math.abs(e.clientX - drag.startX) > 4 && to !== drag.index) { onEdit(moveClip(timeline, drag.index, to)); onSelect(to); }
      }
      setDrag(null); setDropIndex(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }); // re-bind each render so handlers see fresh state

  const tick = pps > 60 ? 1 : pps > 20 ? 5 : pps > 6 ? 10 : pps > 2 ? 30 : 60;
  const ticks = Array.from({ length: Math.floor(total / tick) + 1 }, (_, i) => i * tick);

  const clipKeys = (e: React.KeyboardEvent, i: number) => {
    const c = timeline.clips[i];
    const src = assetById[c.asset_id]?.duration ?? c.end;
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const to = i + (e.key === "ArrowLeft" ? -1 : 1);
      if (to >= 0 && to < timeline.clips.length) { onEdit(moveClip(timeline, i, to)); onSelect(to); }
    } else if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      onEdit(trimClip(timeline, i, "end", c.end + (e.key === "ArrowLeft" ? -0.1 : 0.1), src));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const to = Math.max(0, Math.min(timeline.clips.length - 1, i + (e.key === "ArrowLeft" ? -1 : 1)));
      onSelect(to);
      (document.querySelector(`[data-clip-index="${to}"]`) as HTMLElement | null)?.focus();
    } else if (e.key === "Enter") onSeek(offsets[i]);
  };

  const trackLabel = (icon: string, text: string) => (
    <div className="sticky left-0 z-20 flex w-20 shrink-0 items-center gap-1.5 border-r border-line bg-panel px-2 text-[11px] font-medium text-muted"><Icon name={icon} size={13} />{text}</div>
  );

  return (
    <div className="flex h-full flex-col gap-2" data-testid="timeline">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-mono tabular-nums text-text">{fmt(playhead)}</span><span>/ {fmt(total)}</span>
        <span className="hidden sm:inline">· {timeline.clips.length} cuts</span>
        <label className="ml-auto flex items-center gap-2">Zoom
          <input type="range" min={0} max={120} step={1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Timeline zoom (0 = fit)" className="w-24 accent-[#8b7cf8]" />
        </label>
      </div>
      <div ref={scroller} className="scroll-thin relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden rounded-xl border border-line bg-ink/60 select-none"
           onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-cutcue-asset")) { e.preventDefault(); setDropIndex(dropSlot(e.clientX)); } }}
           onDragLeave={() => setDropIndex(null)}
           onDrop={(e) => {
             const id = e.dataTransfer.getData("application/x-cutcue-asset");
             const a = assetById[id];
             if (a?.duration) { e.preventDefault(); onEdit(insertClip(timeline, { asset_id: a.id, start: 0, end: a.duration, label: a.original_name }, dropSlot(e.clientX))); }
             setDropIndex(null);
           }}>
        <div style={{ width: width + 80 }} className="relative">
          {/* Ruler */}
          <div className="flex h-6 border-b border-line">
            {trackLabel("history", "Time")}
            <div className="relative flex-1 cursor-col-resize" onPointerDown={(e) => { onSeek(pointToTime(e.clientX)); setDrag({ kind: "scrub" }); }}
                 role="slider" aria-label="Timeline position" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(playhead)} aria-valuetext={fmt(playhead)} tabIndex={0}
                 onKeyDown={(e) => { if (e.key === "ArrowLeft") onSeek(playhead - 1); if (e.key === "ArrowRight") onSeek(playhead + 1); }}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 h-full border-l border-line2/70 pl-1 font-mono text-[10px] text-faint" style={{ left: t * pps }}>{fmt(t)}</span>
              ))}
            </div>
          </div>
          {/* Video track */}
          <div className="flex h-14 border-b border-line/60">
            {trackLabel("film", "Video")}
            <div className="relative flex-1">
              {timeline.clips.map((c, i) => {
                const a = assetById[c.asset_id];
                const g = geometry[i];
                const sel = selected === i;
                return (
                  <div key={i} data-clip-index={i} tabIndex={0} role="button" aria-pressed={sel}
                       aria-label={`Cut ${i + 1}: ${a?.original_name ?? "media"}, ${fmt(c.start)} to ${fmt(c.end)}. Alt+arrows to move, Shift+arrows to trim, S to split, Delete to remove.`}
                       onKeyDown={(e) => clipKeys(e, i)} onFocus={() => onSelect(i)}
                       onPointerDown={(e) => { if ((e.target as HTMLElement).dataset.handle) return; onSelect(i); setDrag({ kind: "move", index: i, startX: e.clientX, dx: 0 }); }}
                       className={`group absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-lg border bg-video/70 transition-shadow active:cursor-grabbing ${
                         sel ? "z-10 border-white shadow-[0_0_0_2px_#b18cff]" : "border-video/50 hover:border-white/50"} ${drag?.kind === "move" && drag.index === i ? "opacity-80 shadow-2xl" : ""}`}
                       style={{ left: g.left, width: Math.max(4, g.width - 2) }} data-testid="clip">
                    <Filmstrip pid={pid} asset={a} clip={c} width={g.width} />
                    {c.label && g.width > 60 && <span className="absolute bottom-0.5 left-1.5 rounded bg-black/55 px-1 text-[10px] text-white/90">{c.label}</span>}
                    {(["start", "end"] as const).map((edge) => (
                      <span key={edge} data-handle={edge} aria-hidden
                            onPointerDown={(e) => { e.stopPropagation(); onSelect(i); setDrag({ kind: "trim", index: i, edge, startX: e.clientX, dx: 0 }); }}
                            className={`absolute top-0 bottom-0 z-10 w-2.5 cursor-ew-resize bg-white/0 hover:bg-white/40 ${sel ? "bg-white/25" : ""} ${edge === "start" ? "left-0 rounded-l-lg" : "right-0 rounded-r-lg"}`}
                            data-testid={`trim-${edge}`} />
                    ))}
                  </div>
                );
              })}
              {dropIndex !== null && (
                <span className="absolute top-0 bottom-0 z-30 w-0.5 bg-violet shadow-[0_0_8px_#b18cff]"
                      style={{ left: (dropIndex < timeline.clips.length ? offsets[dropIndex] : total) * pps }} />
              )}
            </div>
          </div>
          {/* Audio track */}
          <div className="flex h-10 border-b border-line/60">
            {trackLabel("wave", "Audio")}
            <div className="relative flex-1">
              {timeline.clips.map((c, i) => (
                <div key={i} className={`absolute top-1 bottom-1 overflow-hidden rounded-md bg-audio/15 ${selected === i ? "ring-1 ring-violet" : ""}`}
                     style={{ left: geometry[i].left, width: Math.max(4, geometry[i].width - 2) }}>
                  <WaveSlice pid={pid} asset={assetById[c.asset_id]} start={c.start} end={c.end} width={Math.max(4, geometry[i].width - 2)} />
                </div>
              ))}
            </div>
          </div>
          {/* Music track */}
          {timeline.audio?.music_asset_id && (
            <div className="flex h-9 border-b border-line/60">
              {trackLabel("music", "Music")}
              <div className="relative flex-1">
                <div className="absolute inset-y-1 left-0 overflow-hidden rounded-md bg-[#8a5cf6]/15" style={{ width }}>
                  <WaveSlice pid={pid} asset={assetById[timeline.audio.music_asset_id]} start={0} end={total} width={width} color="#b18cff" />
                  <span className="absolute left-2 top-1 text-[10px] text-violet">{timeline.audio.duck ? "ducks under voices" : "music"}</span>
                </div>
              </div>
            </div>
          )}
          {/* Captions track */}
          <div className="flex h-8">
            {trackLabel("doc", "Captions")}
            <div className="relative flex-1">
              {cues.map((q, i) => (
                <button key={i} className="absolute top-1 bottom-1 overflow-hidden truncate rounded bg-caption/25 px-1 text-left text-[10px] text-[#f1cf9c] hover:bg-caption/40"
                        style={{ left: q.start * pps, width: Math.max(3, (q.end - q.start) * pps - 1) }} onClick={() => onSeek(q.start)} title={q.text} tabIndex={-1}>
                  {q.text}
                </button>
              ))}
            </div>
          </div>
          {/* Playhead */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-white" style={{ left: 80 + playhead * pps }} data-testid="playhead">
            <span className="pointer-events-auto absolute -left-1.5 -top-0.5 h-3 w-3 cursor-col-resize rounded-full bg-white shadow"
                  onPointerDown={() => setDrag({ kind: "scrub" })} />
          </div>
        </div>
      </div>
    </div>
  );
}
