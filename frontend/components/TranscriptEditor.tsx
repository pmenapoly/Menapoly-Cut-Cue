"use client";
// Transcript editing for Cue Pro: click a word, shift-click another to select a span, then cut it from the
// edit (or add it). Fix wording with the pencil: captions follow. Text is search-filtered and speaker-coloured.
import { useMemo, useState } from "react";
import { api, Asset, Segment } from "@/lib/api";
import { duration } from "@/lib/format";
import { useStore } from "@/lib/project";
import { cutSourceRange, insertClip, locate } from "@/lib/timeline";
import { Icon } from "./ui";

const SPEAKER_COLORS = ["text-violet", "text-audio", "text-[#f1a58f]", "text-[#d6c56b]"];

export function TranscriptEditor({ playhead, onSeekSource }: { playhead: number; onSeekSource: (assetId: string, t: number) => void }) {
  const { pid, assets, segments, draft, edit, run } = useStore();
  const media = assets.filter((a) => (a.kind === "video" || a.kind === "audio") && a.has_transcript);
  const [assetId, setAssetId] = useState<string>("");
  const asset: Asset | undefined = media.find((a) => a.id === assetId) ?? media[0];
  const segs: Segment[] = asset ? segments[asset.id] ?? [] : [];
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const words = useMemo(() => segs.flatMap((s) => s.words.length ? s.words.map((w) => ({ ...w, seg: s.idx })) : [{ start: s.start, end: s.end, word: s.text, seg: s.idx }]), [segs]);
  const playingSource = draft ? locate(draft, playhead) : null;
  const inEdit = (t: number) => !!draft?.clips.some((c) => c.asset_id === asset?.id && t >= c.start && t <= c.end);

  if (!asset) return <p className="p-3 text-sm text-faint">The transcript appears here once Cue has listened to your recording.</p>;
  const pick = (i: number, shift: boolean) => {
    const w = words[i];
    if (shift && anchor !== null) {
      const a = Math.min(anchor, i), b = Math.max(anchor, i);
      setSel({ start: words[a].start, end: words[b].end });
    } else { setAnchor(i); setSel({ start: w.start, end: w.end }); onSeekSource(asset.id, w.start); }
  };
  const visible = query ? segs.filter((s) => s.text.toLowerCase().includes(query.toLowerCase())) : segs;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex gap-2">
        {media.length > 1 && (
          <select className="input w-auto" value={asset.id} onChange={(e) => setAssetId(e.target.value)} aria-label="Recording">
            {media.map((a) => <option key={a.id} value={a.id}>{a.original_name}</option>)}
          </select>
        )}
        <input className="input" placeholder="Search the transcript" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the transcript" />
      </div>
      {sel && draft && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-xs animate-rise" role="toolbar" aria-label="Selection actions">
          <span>Selected {duration(sel.start)}–{duration(sel.end)}</span>
          <button className="btn btn-sm" onClick={() => { edit(cutSourceRange(draft, asset.id, sel.start - 0.02, sel.end + 0.02)); setSel(null); }}>
            <Icon name="scissors" size={13} /> Cut from edit</button>
          <button className="btn btn-sm" onClick={() => { edit(insertClip(draft, { asset_id: asset.id, start: Math.max(0, sel.start - 0.15), end: Math.min(asset.duration ?? sel.end, sel.end + 0.15), label: "Added" })); setSel(null); }}>
            <Icon name="plus" size={13} /> Add to end of edit</button>
          <button className="btn btn-ghost btn-sm ml-auto" onClick={() => setSel(null)} aria-label="Clear selection"><Icon name="x" size={13} /></button>
        </div>
      )}
      <p className="text-[11px] text-faint">Click a word to jump there; Shift-click to select a passage. Faded text isn&apos;t in your edit.</p>
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {visible.map((s) => {
          const speaker = s.speaker ? Number(s.speaker.slice(1)) - 1 : -1;
          const first = words.findIndex((w) => w.seg === s.idx);
          return (
            <div key={s.idx} className="group">
              <div className="mb-0.5 flex items-center gap-2 text-[11px]">
                <button className="font-mono text-faint hover:text-text" onClick={() => onSeekSource(asset.id, s.start)}>{duration(s.start)}</button>
                {s.speaker && <span className={`font-semibold ${SPEAKER_COLORS[speaker % SPEAKER_COLORS.length]}`}>{s.speaker}</span>}
                <button className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" aria-label={`Correct the wording at ${duration(s.start)}`}
                        onClick={() => { setEditing(s.idx); setText(s.text); }}><Icon name="wand" size={12} className="text-faint" /></button>
              </div>
              {editing === s.idx ? (
                <form className="flex gap-2" onSubmit={async (e) => {
                  e.preventDefault();
                  await run(() => api.patch(`/projects/${pid}/assets/${asset.id}/transcript/${s.idx}`, { text }), "Transcript corrected; captions updated");
                  setEditing(null);
                }}>
                  <input className="input text-sm" value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label="Corrected text" />
                  <button className="btn btn-primary btn-sm">Save</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <p className="text-[15px] leading-7">
                  {(s.words.length ? s.words : [{ start: s.start, end: s.end, word: s.text }]).map((w, k) => {
                    const i = first + k;
                    const mid = (w.start + w.end) / 2;
                    const selected = sel && w.start >= sel.start - 0.001 && w.end <= sel.end + 0.001;
                    const now = playingSource && draft?.clips[playingSource.index]?.asset_id === asset.id && playingSource.source >= w.start && playingSource.source < w.end;
                    return (
                      <span key={k} role="button" tabIndex={-1} onClick={(e) => pick(i, e.shiftKey)}
                            className={`cursor-pointer rounded px-px transition-colors ${selected ? "bg-accent/40 text-white" : now ? "bg-white/15" : "hover:bg-panel3"} ${inEdit(mid) ? "" : "text-faint line-through decoration-faint/40"}`}>
                        {w.word}
                      </span>
                    );
                  })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
