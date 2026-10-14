"use client";
// Preview player. "timeline" mode plays an edit instantly from the source files (no render needed):
// it walks the clip list, seeking/switching sources at each cut, and draws live captions and framing.
// "render" mode plays a finished export.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Asset, mediaUrl, Render, renderUrl, Segment, Timeline } from "@/lib/api";
import { duration as fmt } from "@/lib/format";
import { clipLength, locate, previewCues, totalDuration } from "@/lib/timeline";
import { Icon } from "./ui";

export type PlayerSource =
  | { kind: "timeline"; timeline: Timeline; label: string }
  | { kind: "render"; render: Render; label: string; aspect?: string }
  | { kind: "empty"; label: string };

export type PlayerHandle = { seek: (t: number) => void; toggle: () => void; pause: () => void; time: () => number };

const ASPECT: Record<string, string> = { "16:9": "aspect-video", "9:16": "aspect-[9/16]", "1:1": "aspect-square" };

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  return t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range";
}

export const Player = forwardRef<PlayerHandle, {
  pid: string; source: PlayerSource; assets: Asset[]; segments: Record<string, Segment[]>;
  onTime?: (t: number) => void; compact?: boolean; shortcuts?: boolean;
}>(function Player({ pid, source, assets, segments, onTime, compact = false, shortcuts = true }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [cc, setCc] = useState(true);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const pending = useRef<{ index: number; source: number; play: boolean } | null>(null);
  const raf = useRef<number>(0);

  const timeline = source.kind === "timeline" ? source.timeline : null;
  const total = timeline ? totalDuration(timeline) : source.kind === "render" ? (source.render.duration ?? 0) : 0;
  const clip = timeline?.clips[index];
  const asset = clip ? assets.find((a) => a.id === clip.asset_id) : undefined;
  const src = timeline ? (clip ? mediaUrl(pid, clip.asset_id) : null) : source.kind === "render" ? renderUrl(pid, source.render.id, "mp4") : null;
  const cues = useMemo(() => (timeline ? previewCues(timeline, segments, timeline.aspect === "9:16" ? 28 : 42) : []), [timeline, segments]);
  const cue = timeline && cc ? cues.find((c) => time >= c.start && time < c.end) : undefined;

  // Reset when the edit changes.
  const timelineKey = timeline ? JSON.stringify(timeline.clips.map((c) => [c.asset_id, c.start, c.end])) : source.kind === "render" ? source.render.id : "";
  useEffect(() => {
    setIndex(0); setTime(0); setPlaying(false); setError("");
    pending.current = timeline?.clips.length ? { index: 0, source: timeline.clips[0].start, play: false } : null;
    if (video.current && timeline?.clips.length) video.current.currentTime = timeline.clips[0].start;
  }, [timelineKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const outputFromVideo = useCallback(() => {
    const v = video.current;
    if (!v) return 0;
    if (!timeline) return v.currentTime;
    const c = timeline.clips[index];
    if (!c) return 0;
    let acc = 0;
    for (let i = 0; i < index; i++) acc += clipLength(timeline.clips[i]);
    return acc + Math.min(Math.max(0, v.currentTime - c.start), clipLength(c));
  }, [timeline, index]);

  const seek = useCallback((t: number, play?: boolean) => {
    const v = video.current;
    const target = Math.max(0, Math.min(t, total));
    setTime(target);
    onTime?.(target);
    if (!v) return;
    const wantPlay = play ?? !v.paused;
    if (!timeline) { v.currentTime = target; return; }
    const hit = locate(timeline, target);
    if (!hit) return;
    if (hit.index !== index) {
      pending.current = { index: hit.index, source: hit.source, play: wantPlay };
      const nextAsset = timeline.clips[hit.index].asset_id;
      const sameSource = timeline.clips[index]?.asset_id === nextAsset;
      setIndex(hit.index);
      if (sameSource) { v.currentTime = hit.source; pending.current = null; if (wantPlay) v.play().catch(() => {}); }
    } else {
      v.currentTime = hit.source;
    }
  }, [timeline, index, total, onTime]);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v || !src) return;
    if (v.paused) {
      if (time >= total - 0.05) seek(0, true);
      v.play().catch((e) => setError(String(e?.message ?? e)));
    } else v.pause();
  }, [src, time, total, seek]);

  useImperativeHandle(ref, () => ({ seek: (t) => seek(t), toggle, pause: () => video.current?.pause(), time: () => time }), [seek, toggle, time]);

  // Frame loop: advance across cuts precisely (timeupdate alone is too coarse).
  useEffect(() => {
    const tick = () => {
      const v = video.current;
      if (v && timeline && !v.paused) {
        const c = timeline.clips[index];
        if (c && v.currentTime >= c.end - 0.02) {
          if (index + 1 < timeline.clips.length) {
            const next = timeline.clips[index + 1];
            if (next.asset_id === c.asset_id) { v.currentTime = next.start; setIndex(index + 1); }
            else { pending.current = { index: index + 1, source: next.start, play: true }; setIndex(index + 1); }
          } else { v.pause(); }
        }
        const t = outputFromVideo();
        setTime(t); onTime?.(t);
      } else if (v && !timeline && !v.paused) {
        setTime(v.currentTime); onTime?.(v.currentTime);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [timeline, index, outputFromVideo, onTime]);

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") { e.preventDefault(); toggle(); }
      else if (k === "j") seek(time - 5);
      else if (k === "l") seek(time + 5);
      else if (e.key === "ArrowLeft" && (e.target as HTMLElement)?.getAttribute?.("role") !== "slider") { e.preventDefault(); seek(time - 1); }
      else if (e.key === "ArrowRight" && (e.target as HTMLElement)?.getAttribute?.("role") !== "slider") { e.preventDefault(); seek(time + 1); }
      else if (k === "m") setMuted((m) => !m);
      else if (k === "c") setCc((c) => !c);
      else if (k === "f") frame.current?.requestFullscreen?.().catch(() => {});
      else if (k === "?") setShowHelp((h) => !h);
      else if (e.key === "Home") seek(0);
      else if (e.key === "End") seek(total);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts, toggle, seek, time, total]);

  const aspect = timeline?.aspect ?? (source.kind === "render" ? source.aspect ?? "16:9" : "16:9");
  const focus = clip?.focus_x ?? 0.5;
  const audioOnly = timeline ? asset && !asset.has_video : false;

  return (
    <div className="flex h-full flex-col gap-2">
      <div ref={frame} className={`relative mx-auto w-full overflow-hidden rounded-2xl bg-black shadow-[0_30px_60px_-30px_#000] ${compact ? "max-h-[40dvh]" : "max-h-[58dvh]"} ${
        aspect === "16:9" ? "" : aspect === "9:16" ? "max-w-[min(100%,calc(58dvh*9/16))]" : "max-w-[min(100%,58dvh)]"} ${ASPECT[aspect]}`}
           data-testid="player-frame">
        {src ? (
          <video ref={video} key={src} src={src} playsInline muted={muted} preload="auto"
                 className="h-full w-full object-cover" style={{ objectPosition: `${focus * 100}% 50%`, objectFit: aspect === "16:9" ? "contain" : "cover" }}
                 onLoadedMetadata={() => {
                   const p = pending.current;
                   const v = video.current;
                   if (v && p) { v.currentTime = p.source; if (p.play) v.play().catch(() => {}); pending.current = null; }
                   else if (v && timeline?.clips[index]) v.currentTime = Math.max(v.currentTime, timeline.clips[index].start);
                 }}
                 onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                 onError={() => setError("This browser can't play this file. Try Chrome or Safari, or play the exported MP4.")}
                 onClick={toggle} />
        ) : (
          <div className="grid h-full place-items-center bg-gradient-to-br from-[#17142b] via-[#100e1c] to-[#1a1230] p-6 text-center">
            <div className="space-y-3">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-accent-soft text-violet"><Icon name="film" size={26} /></div>
              <p className="text-sm text-muted">{source.label}</p>
            </div>
          </div>
        )}
        {audioOnly && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-gradient-to-br from-[#1c1838] to-[#0f0d1c]">
            <div className="flex items-end gap-1" aria-hidden>
              {Array.from({ length: 24 }, (_, i) => (
                <span key={i} className={`w-1.5 rounded-full bg-gradient-to-t from-accent-strong to-violet ${playing ? "animate-pulse-soft" : ""}`}
                      style={{ height: `${14 + ((i * 37) % 48)}px`, animationDelay: `${(i % 6) * 120}ms` }} />
              ))}
            </div>
          </div>
        )}
        {timeline?.title && time < 4 && (
          <div className="absolute inset-x-0 top-[8%] flex justify-center px-4">
            <span className="rounded-md bg-[#e0a458] px-3 py-1 text-center text-sm font-bold text-[#101418] sm:text-base">{timeline.title}</span>
          </div>
        )}
        {cue && (
          <div className={`pointer-events-none absolute inset-x-0 flex justify-center px-[8%] ${aspect === "9:16" ? "bottom-[16%]" : "bottom-[7%]"}`}>
            <span className="rounded-md bg-black/55 px-2 py-1 text-center text-sm font-semibold leading-snug text-white [text-shadow:0_1px_2px_#000] sm:text-base"
                  data-testid="caption">{cue.text}</span>
          </div>
        )}
        {!playing && src && (
          <button onClick={toggle} aria-label="Play" className="absolute inset-0 m-auto grid h-16 w-16 place-items-center rounded-full bg-white/15 text-white backdrop-blur-md transition hover:scale-105 hover:bg-white/25">
            <Icon name="play" size={26} />
          </button>
        )}
        {timeline && (
          <span className="absolute left-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white/85 backdrop-blur">
            Instant preview · cut {Math.min(index + 1, timeline.clips.length)}/{timeline.clips.length}
          </span>
        )}
      </div>
      {error && <p role="alert" className="text-center text-xs text-warn">{error}</p>}

      <div className="flex items-center gap-1.5 sm:gap-2" aria-label="Playback controls">
        {!compact && <button className="btn btn-ghost btn-icon" onClick={() => seek(time - 5)} aria-label="Back 5 seconds (J)" disabled={!src}><Icon name="back5" /></button>}
        <button className="btn btn-icon border-transparent bg-text text-ink hover:bg-white" onClick={toggle} aria-label={playing ? "Pause (Space)" : "Play (Space)"} disabled={!src}
                data-testid="play-toggle" data-playing={playing}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        {!compact && <button className="btn btn-ghost btn-icon" onClick={() => seek(time + 5)} aria-label="Forward 5 seconds (L)" disabled={!src}><Icon name="fwd5" /></button>}
        <span className="w-[5.5rem] shrink-0 text-center font-mono text-xs tabular-nums text-muted" data-testid="player-time">{fmt(time)} / {fmt(total)}</span>
        <input type="range" className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[#8b7cf8]" min={0} max={Math.max(total, 0.01)} step={0.05}
               value={Math.min(time, total)} onChange={(e) => seek(Number(e.target.value))} aria-label="Seek" disabled={!src}
               aria-valuetext={`${fmt(time)} of ${fmt(total)}`} />
        <button className={`btn btn-ghost btn-icon hidden ${compact ? "" : "sm:inline-flex"}`} onClick={() => setMuted((m) => !m)} aria-label={muted ? "Unmute (M)" : "Mute (M)"} aria-pressed={muted}>
          <Icon name={muted ? "mute" : "volume"} /></button>
        {timeline && !compact && <button className={`btn btn-ghost btn-sm ${cc ? "text-violet" : ""}`} onClick={() => setCc((c) => !c)} aria-pressed={cc} aria-label="Captions (C)">CC</button>}
        <button className={`btn btn-ghost btn-icon hidden ${compact ? "" : "sm:inline-flex"}`} onClick={() => frame.current?.requestFullscreen?.().catch(() => {})} aria-label="Full screen (F)"><Icon name="maximize" /></button>
        <button className={`btn btn-ghost btn-icon hidden ${compact ? "" : "md:inline-flex"}`} onClick={() => setShowHelp((h) => !h)} aria-label="Keyboard shortcuts (?)" aria-expanded={showHelp}><Icon name="keyboard" /></button>
      </div>
      {showHelp && (
        <div className="rounded-xl border border-line bg-panel2 p-3 text-xs text-muted animate-rise" role="note">
          <span className="kbd">Space</span>/<span className="kbd">K</span> play · <span className="kbd">J</span>/<span className="kbd">L</span> ±5 s · <span className="kbd">←</span>/<span className="kbd">→</span> ±1 s ·{" "}
          <span className="kbd">M</span> mute · <span className="kbd">C</span> captions · <span className="kbd">F</span> full screen
          {" "}· Pro: <span className="kbd">S</span> split · <span className="kbd">⌫</span> delete · <span className="kbd">⌘Z</span> undo · <span className="kbd">⇧⌘Z</span> redo · <span className="kbd">⌘S</span> save
        </div>
      )}
    </div>
  );
});
