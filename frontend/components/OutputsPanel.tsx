"use client";
import { useState } from "react";
import { api, ApiError, Compare, fmtTime, Job, Render, renderUrl, Sequence } from "@/lib/api";

export function VersionsPanel({ pid, seq, onChanged }: { pid: string; seq: Sequence | null; onChanged: () => void }) {
  const [pick, setPick] = useState<string[]>([]);
  const [cmp, setCmp] = useState<Compare | null>(null);
  if (!seq) return <p className="text-sm text-muted">No sequence selected.</p>;
  const toggle = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  return (
    <div className="space-y-2 text-sm">
      <ul className="space-y-1">
        {[...seq.versions].reverse().map((v) => (
          <li key={v.id} className="flex items-center gap-2">
            <input type="checkbox" checked={pick.includes(v.id)} onChange={() => toggle(v.id)} title="Select two to compare" />
            <span className={`font-mono ${v.id === seq.current_version_id ? "text-accent" : ""}`}>v{v.number}</span>
            <span className="min-w-0 flex-1 truncate" title={v.label}>{v.label}</span>
            <span className="text-[11px] text-muted">{v.origin}</span>
            {v.id !== seq.current_version_id && (
              <button className="btn btn-sm" onClick={async () => { await api.post(`/projects/${pid}/versions/${v.id}/restore`); onChanged(); }}>Restore</button>
            )}
          </li>
        ))}
      </ul>
      <button className="btn btn-sm" disabled={pick.length !== 2} onClick={async () => {
        const [a, b] = [...pick].sort((x, y) => (seq.versions.find((v) => v.id === x)!.number - seq.versions.find((v) => v.id === y)!.number));
        setCmp(await api.get<Compare>(`/projects/${pid}/compare?a=${a}&b=${b}`));
      }}>Compare selected</button>
      {cmp && (
        <div className="rounded border border-line p-2 text-xs">
          <div>v{cmp.a.number}: {fmtTime(cmp.a.duration)}, {cmp.a.clips} clips, {cmp.a.aspect}</div>
          <div>v{cmp.b.number}: {fmtTime(cmp.b.duration)}, {cmp.b.clips} clips, {cmp.b.aspect}</div>
          <div className="mt-1 text-muted">{cmp.shared_clips} clips shared ·
            Δ {(cmp.b.duration - cmp.a.duration >= 0 ? "+" : "")}{(cmp.b.duration - cmp.a.duration).toFixed(1)}s</div>
          {cmp.only_in_a.length > 0 && <div className="text-danger">Removed in v{cmp.b.number}: {cmp.only_in_a.map((c) => `${fmtTime(c.start)}–${fmtTime(c.end)}`).join(", ")}</div>}
          {cmp.only_in_b.length > 0 && <div className="text-ok">Added in v{cmp.b.number}: {cmp.only_in_b.map((c) => `${fmtTime(c.start)}–${fmtTime(c.end)}`).join(", ")}</div>}
        </div>
      )}
    </div>
  );
}

export function RendersPanel({ pid, renders, onPlay, playingId }: {
  pid: string; renders: Render[]; onPlay: (r: Render) => void; playingId: string | null;
}) {
  if (!renders.length) return <p className="text-sm text-muted">No renders yet. Approve a proposal or click Render preview.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {renders.map((r) => (
        <li key={r.id} className={`rounded border p-2 ${playingId === r.id ? "border-accent" : "border-line"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{r.sequence_name}</span>
            <span className="text-muted">v{r.version_number} · {r.quality}</span>
            <span className={r.status === "succeeded" ? "text-ok" : r.status === "failed" ? "text-danger" : "text-accent"}>
              {r.status}{r.status === "running" && r.progress != null ? ` ${Math.round(r.progress * 100)}%` : ""}
            </span>
            {r.duration != null && <span className="text-muted">{fmtTime(r.duration)}</span>}
          </div>
          {r.status === "running" && <div className="mt-1 h-1 rounded bg-line"><div className="h-1 rounded bg-accent" style={{ width: `${(r.progress ?? 0) * 100}%` }} /></div>}
          {r.error && <div className="text-xs text-danger">{r.error}</div>}
          {r.status === "succeeded" && (
            <div className="mt-1 flex flex-wrap gap-2">
              <button className="btn btn-sm" onClick={() => onPlay(r)}>▶ Play</button>
              <a className="btn btn-sm" href={renderUrl(pid, r.id, "mp4", true)}>MP4</a>
              <a className="btn btn-sm" href={renderUrl(pid, r.id, "srt", true)}>SRT</a>
              {r.wav_name && <a className="btn btn-sm" href={renderUrl(pid, r.id, "wav", true)}>WAV</a>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function JobsPanel({ pid, jobs, onChanged }: { pid: string; jobs: Job[]; onChanged: () => void }) {
  const [error, setError] = useState("");
  const act = async (j: Job, action: "cancel" | "retry") => {
    try { await api.post(`/projects/${pid}/jobs/${j.id}/${action}`); onChanged(); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };
  if (!jobs.length) return <p className="text-sm text-muted">No jobs yet.</p>;
  return (
    <div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <ul className="space-y-1 text-xs">
        {jobs.slice(0, 30).map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-2">
            <span className="w-20 font-medium">{j.type}</span>
            <span className={j.status === "succeeded" ? "text-ok" : j.status === "failed" ? "text-danger" : j.status === "running" ? "text-accent" : "text-muted"}>{j.status}</span>
            {j.status === "running" && <span>{Math.round(j.progress * 100)}%</span>}
            <span className="min-w-0 flex-1 truncate text-muted" title={j.error ?? j.message ?? ""}>{j.error ?? j.message}</span>
            <span className="text-muted">{j.worker}</span>
            {(j.status === "queued" || j.status === "running") && <button className="btn btn-sm" onClick={() => act(j, "cancel")}>Cancel</button>}
            {(j.status === "failed" || j.status === "cancelled") && <button className="btn btn-sm" onClick={() => act(j, "retry")}>Retry</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
