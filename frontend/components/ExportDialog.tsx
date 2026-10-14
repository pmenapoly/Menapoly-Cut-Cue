"use client";
// Simple exports: pick where it's going; Cue sets size, captions and loudness. Advanced options stay folded.
import { useState } from "react";
import { api, Render, renderUrl } from "@/lib/api";
import { duration, eta } from "@/lib/format";
import { useStore } from "@/lib/project";
import { Dialog, Icon, Progress, Spinner } from "./ui";
import { useWorkspace } from "./workspace";

const PRESET_ICON: Record<string, string> = { youtube: "play", podcast: "wave", tiktok: "film", reels: "film", linkedin: "user", original: "layers" };
const PRESET_SHAPE: Record<string, string> = { youtube: "16:9", podcast: "16:9", tiktok: "9:16", reels: "9:16", linkedin: "1:1" };

export function RenderRow({ r }: { r: Render }) {
  const { pid, jobs, run, presets } = useStore();
  const { setPreview, setMobileTab } = useWorkspace();
  const job = jobs.find((j) => j.id === r.job_id);
  const label = r.preset ? presets.find((p) => p.id === r.preset)?.label ?? r.preset : r.origin === "reimport" ? "Processed audio" : r.quality === "preview" ? "Preview" : "Export";
  const busy = r.status === "queued" || r.status === "running";
  return (
    <li className="rounded-xl border border-line bg-panel2 p-3" data-testid="render-row">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted">{r.sequence_name} · v{r.version_number}{r.duration ? ` · ${duration(r.duration)}` : ""}</span>
        <span className={`ml-auto text-xs ${r.status === "succeeded" ? "text-ok" : r.status === "failed" ? "text-danger" : "text-violet"}`}>
          {busy ? <span className="inline-flex items-center gap-1"><Spinner size={11} /> {r.status === "queued" ? "Waiting" : `${Math.round((r.progress ?? 0) * 100)}%`}</span>
            : r.status === "succeeded" ? "Ready" : r.status}
        </span>
      </div>
      {busy && (
        <div className="mt-2 space-y-1">
          <Progress value={r.progress ?? 0} label={`${label} progress`} />
          <p className="text-[11px] text-faint">{r.message}{job && eta(job) ? ` · ${eta(job)}` : ""}</p>
        </div>
      )}
      {r.status === "failed" && (
        <div className="mt-1 flex items-center gap-2 text-xs text-danger">
          <span className="line-clamp-2">{r.error}</span>
          {r.job_id && <button className="btn btn-sm ml-auto" onClick={() => run(() => api.post(`/projects/${pid}/jobs/${r.job_id}/retry`), "Retrying export")}>Retry</button>}
        </div>
      )}
      {r.status === "succeeded" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn btn-sm" onClick={() => { setPreview({ kind: "render", id: r.id }); setMobileTab("preview"); }}><Icon name="play" size={12} /> Play</button>
          <a className="btn btn-primary btn-sm" href={renderUrl(pid, r.id, "mp4", true)} download><Icon name="download" size={14} /> Download MP4</a>
          {r.srt_name && <a className="btn btn-sm" href={renderUrl(pid, r.id, "srt", true)} download>Captions (SRT)</a>}
          {r.wav_name && <a className="btn btn-sm" href={renderUrl(pid, r.id, "wav", true)} download>Audio (WAV)</a>}
        </div>
      )}
    </li>
  );
}

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { presets, renders, seq, exportWith, draft, dirty } = useStore();
  const [wav, setWav] = useState(false);
  const [busy, setBusy] = useState("");
  const exports = renders.filter((r) => r.quality === "final" || r.origin === "reimport");
  return (
    <Dialog open={open} onClose={onClose} title="Export" wide>
      {!seq ? (
        <p className="text-sm text-muted">Approve an edit from Cue first, then export it here.</p>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted">
            Exporting <span className="text-text">{seq.name}</span> ({duration(draft ? draft.clips.reduce((s, c) => s + c.end - c.start, 0) : seq.duration)}).
            Pick where it&apos;s going and Cut Cue sets the size, captions and loudness. Your edit itself isn&apos;t changed.
            {dirty && <span className="mt-1 block text-warn">You have unsaved Pro changes: save them first to include them.</span>}
          </p>
          <ul className="grid gap-3 sm:grid-cols-3" aria-label="Export presets">
            {presets.map((p) => (
              <li key={p.id}>
                <button className="flex h-full w-full flex-col items-start gap-2 rounded-2xl border border-line bg-panel2 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent disabled:opacity-50"
                        disabled={!!busy} onClick={async () => { setBusy(p.id); await exportWith(p.id, wav); setBusy(""); }}
                        aria-label={`Export for ${p.label}`}>
                  <span className="flex w-full items-center justify-between">
                    <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-soft text-violet"><Icon name={PRESET_ICON[p.id] ?? "layers"} size={17} /></span>
                    <span className="chip">{PRESET_SHAPE[p.id] ?? seq.timeline?.aspect}</span>
                  </span>
                  <span className="font-semibold">{busy === p.id ? <Spinner size={14} /> : null} {p.label}</span>
                  <span className="text-xs leading-relaxed text-muted">{p.description}</span>
                </button>
              </li>
            ))}
          </ul>
          <details className="rounded-xl border border-line p-3 text-sm">
            <summary className="cursor-pointer text-muted">Advanced options</summary>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={wav} onChange={(e) => setWav(e.target.checked)} /> Also export a WAV (for audio tools like Trebble)</label>
            <p className="mt-2 text-xs text-faint">Exports render at full quality (1080p) on this Mac. Captions are always included as an SRT file.</p>
          </details>
          <section aria-labelledby="exports-h">
            <h3 id="exports-h" className="label mb-2">Your exports</h3>
            {exports.length === 0 ? <p className="text-sm text-faint">Nothing exported yet.</p> : (
              <ul className="space-y-2">{exports.map((r) => <RenderRow key={r.id} r={r} />)}</ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
