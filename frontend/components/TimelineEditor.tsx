"use client";
import { useState } from "react";
import { Aspect, Asset, Clip, fmtTime, Sequence, Timeline } from "@/lib/api";

const COLORS = ["#e0a458", "#9fd3c7", "#c79fd3", "#d3c79f", "#9fb3d3", "#d39fa8"];

export default function TimelineEditor(props: {
  sequences: Sequence[]; seqId: string | null; onSelectSeq: (id: string) => void;
  draft: Timeline | null; setDraft: (t: Timeline) => void; dirty: boolean;
  assets: Record<string, Asset>; playhead: { assetId: string | null; time: number };
  onSave: (label: string) => void; onRevert: () => void; onNewSequence: (name: string) => void;
  onDeleteSequence: (id: string) => void; onPreviewClip: (c: Clip) => void;
  onRender: (quality: "preview" | "final", wav: boolean) => void; busy: boolean; problems: string[];
}) {
  const { draft, setDraft } = props;
  const [sel, setSel] = useState<number | null>(null);
  const [wav, setWav] = useState(false);
  const seq = props.sequences.find((s) => s.id === props.seqId) ?? null;
  const assetIds = Object.keys(props.assets);
  const color = (id: string) => COLORS[Math.max(0, assetIds.indexOf(id)) % COLORS.length];

  const total = draft ? draft.clips.reduce((t, c) => t + (c.end - c.start), 0) : 0;
  const update = (patch: Partial<Timeline>) => draft && setDraft({ ...draft, ...patch });
  const setClip = (i: number, patch: Partial<Clip>) =>
    draft && update({ clips: draft.clips.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const move = (i: number, d: number) => {
    if (!draft) return;
    const clips = [...draft.clips];
    const j = i + d;
    if (j < 0 || j >= clips.length) return;
    [clips[i], clips[j]] = [clips[j], clips[i]];
    update({ clips });
    setSel(j);
  };
  const clip = draft && sel !== null ? draft.clips[sel] : null;
  const canSplit = clip && props.playhead.assetId === clip.asset_id && props.playhead.time > clip.start + 0.1 && props.playhead.time < clip.end - 0.1;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {props.sequences.map((s) => (
          <button key={s.id} onClick={() => { props.onSelectSeq(s.id); setSel(null); }}
                  className={`btn btn-sm ${s.id === props.seqId ? "border-accent text-accent" : ""}`}>
            {s.name} <span className="text-muted">v{s.versions.at(-1)?.number ?? 0}</span>
          </button>
        ))}
        <button className="btn btn-sm" onClick={() => { const n = prompt("New sequence name", "Sequence"); if (n) props.onNewSequence(n); }}>+ Sequence</button>
      </div>

      {!draft ? (
        <p className="text-sm text-muted">No sequence yet. Ask the editor in chat, or add transcript lines with “+ timeline”.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono">{fmtTime(total)}</span>
            <span className="text-muted">{draft.clips.length} clips</span>
            <label className="flex items-center gap-1">Aspect
              <select className="input py-0.5" value={draft.aspect} onChange={(e) => update({ aspect: e.target.value as Aspect })}>
                <option>16:9</option><option>9:16</option><option>1:1</option>
              </select>
            </label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={draft.burn_captions} onChange={(e) => update({ burn_captions: e.target.checked })} /> Burn captions</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={draft.normalize_audio} onChange={(e) => update({ normalize_audio: e.target.checked })} /> Loudness −16 LUFS</label>
            {props.dirty && <span className="text-accent">● unsaved</span>}
          </div>

          <div className="scroll-thin flex h-14 overflow-x-auto rounded border border-line bg-ink p-1">
            {draft.clips.map((c, i) => (
              <button key={i} onClick={() => { setSel(i); props.onPreviewClip(c); }} title={`${c.label || ""} ${fmtTime(c.start)}–${fmtTime(c.end)}`}
                      className={`mr-px h-full shrink-0 overflow-hidden rounded-sm px-1 text-left text-[10px] text-ink ${sel === i ? "outline-2 outline-white" : ""}`}
                      style={{ width: `${Math.max(18, ((c.end - c.start) / Math.max(total, 1)) * 1400)}px`, background: color(c.asset_id) }}>
                {c.label || fmtTime(c.start)}
              </button>
            ))}
          </div>

          {clip && sel !== null && (
            <div className="flex flex-wrap items-end gap-2 rounded border border-line p-2 text-sm">
              <span className="text-muted">Clip {sel + 1} · {props.assets[clip.asset_id]?.original_name ?? clip.asset_id}</span>
              <label className="flex flex-col"><span className="label">In (s)</span>
                <input className="input w-24" type="number" step="0.05" value={clip.start} onChange={(e) => setClip(sel, { start: Number(e.target.value) })} /></label>
              <label className="flex flex-col"><span className="label">Out (s)</span>
                <input className="input w-24" type="number" step="0.05" value={clip.end} onChange={(e) => setClip(sel, { end: Number(e.target.value) })} /></label>
              <label className="flex flex-col"><span className="label">Label</span>
                <input className="input w-36" value={clip.label ?? ""} onChange={(e) => setClip(sel, { label: e.target.value })} /></label>
              <button className="btn btn-sm" onClick={() => move(sel, -1)}>◀</button>
              <button className="btn btn-sm" onClick={() => move(sel, 1)}>▶</button>
              <button className="btn btn-sm" disabled={!canSplit} title="Split at the source player's playhead" onClick={() => {
                const t = Math.round(props.playhead.time * 1000) / 1000;
                const clips = [...draft.clips];
                clips.splice(sel, 1, { ...clip, end: t }, { ...clip, start: t });
                update({ clips });
              }}>Split at playhead</button>
              <button className="btn btn-sm" onClick={() => props.onPreviewClip(clip)}>Play source</button>
              <button className="btn btn-sm text-danger" onClick={() => { update({ clips: draft.clips.filter((_, j) => j !== sel) }); setSel(null); }}>Delete</button>
            </div>
          )}

          {props.problems.length > 0 && (
            <ul className="rounded border border-danger p-2 text-xs text-danger">{props.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          )}

          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={!props.dirty || props.busy} onClick={() => props.onSave(prompt("Version label", "Manual edit") || "Manual edit")}>Save version</button>
            <button className="btn" disabled={!props.dirty} onClick={props.onRevert}>Discard changes</button>
            <span className="mx-1 w-px bg-line" />
            <button className="btn" disabled={props.dirty || props.busy || !seq?.current_version_id} onClick={() => props.onRender("preview", false)}>Render preview</button>
            <button className="btn" disabled={props.dirty || props.busy || !seq?.current_version_id} onClick={() => props.onRender("final", wav)}>Export final</button>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={wav} onChange={(e) => setWav(e.target.checked)} /> + WAV</label>
            {seq && <button className="btn btn-sm ml-auto self-center" onClick={() => confirm(`Delete sequence "${seq.name}"?`) && props.onDeleteSequence(seq.id)}>Delete sequence</button>}
          </div>
        </>
      )}
    </div>
  );
}
