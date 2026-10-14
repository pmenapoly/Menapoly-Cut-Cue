"use client";
import { useEffect, useMemo, useState } from "react";
import { api, Asset, fmtTime, Segment } from "@/lib/api";

type Hit = { asset_id: string; start: number; end: number; text: string; original_name: string };

export default function TranscriptPanel({ pid, asset, assets, currentTime, onSeek, onAdd }: {
  pid: string; asset: Asset | null; assets: Asset[]; currentTime: number;
  onSeek: (assetId: string, t: number) => void; onAdd: (assetId: string, start: number, end: number, label: string) => void;
}) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);

  useEffect(() => {
    setSegments([]);
    if (asset?.has_transcript) api.get<Segment[]>(`/projects/${pid}/assets/${asset.id}/transcript`).then(setSegments);
  }, [pid, asset?.id, asset?.has_transcript]);

  const active = useMemo(() => segments.findIndex((s) => currentTime >= s.start && currentTime < s.end), [segments, currentTime]);

  if (asset?.kind === "document") {
    return <pre className="scroll-thin h-full overflow-auto whitespace-pre-wrap text-sm text-muted">{asset.text ?? "Loading…"}</pre>;
  }

  const speakerColors = ["text-accent", "text-accent2", "text-[#c79fd3]", "text-[#d3c79f]"];
  const chip = (speaker?: string | null) => speaker
    ? <span className={`mr-1 text-[10px] font-semibold ${speakerColors[(Number(speaker.slice(1)) - 1) % speakerColors.length]}`}>{speaker}</span>
    : null;
  const row = (assetId: string, start: number, end: number, text: string, extra?: string, highlight = false, speaker?: string | null) => (
    <li key={`${assetId}-${start}`} className={`group rounded px-2 py-1 text-sm ${highlight ? "bg-panel2" : "hover:bg-panel2"}`}>
      <button className="mr-2 font-mono text-xs text-accent2" onClick={() => onSeek(assetId, start)}>{fmtTime(start)}</button>
      {chip(speaker)}
      {extra && <span className="mr-1 text-xs text-muted">{extra}</span>}
      <span>{text}</span>
      <button className="btn btn-sm ml-2 sm:opacity-0 sm:group-hover:opacity-100"
              onClick={() => onAdd(assetId, Math.max(0, start - 0.15), end + 0.15, text.slice(0, 40))}>+ timeline</button>
    </li>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form className="mb-2 flex gap-2" onSubmit={async (e) => {
        e.preventDefault();
        setHits(query.trim() ? await api.get<Hit[]>(`/projects/${pid}/search?q=${encodeURIComponent(query)}`) : null);
      }}>
        <input className="input min-w-0 flex-1" placeholder="Search all transcripts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn btn-sm">Search</button>
        {hits && <button type="button" className="btn btn-sm" onClick={() => { setHits(null); setQuery(""); }}>Clear</button>}
      </form>
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {hits ? (
          hits.length ? hits.map((h) => row(h.asset_id, h.start, h.end, h.text, h.original_name)) : <li className="text-sm text-muted">No matches.</li>
        ) : !asset ? (
          <li className="text-sm text-muted">Select a media file to see its transcript.</li>
        ) : !asset.has_transcript ? (
          <li className="text-sm text-muted">
            {asset.kind === "video" || asset.kind === "audio" ? "Transcript not ready yet (see jobs below), or upload an SRT/VTT with the same file name." : "No transcript for this file type."}
          </li>
        ) : (
          segments.map((s, i) => row(asset.id, s.start, s.end, s.text, undefined, i === active, s.speaker))
        )}
      </ul>
      {assets.length === 0 && <p className="text-sm text-muted">Upload files to begin.</p>}
    </div>
  );
}
