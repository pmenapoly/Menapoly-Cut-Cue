"use client";
// Drag-and-drop uploads (media + briefs together) and clear, honest processing states per file.
import { useRef, useState } from "react";
import { api, Asset, fmtBytes, Job, thumbUrl } from "@/lib/api";
import { duration, eta, jobLabel } from "@/lib/format";
import { useStore } from "@/lib/project";
import { Empty, Icon, Progress, Spinner } from "./ui";

export const ACCEPT = ".mp4,.mov,.m4v,.mkv,.webm,.avi,.mts,.wav,.mp3,.m4a,.aac,.flac,.ogg,.aiff,.aif,.jpg,.jpeg,.png,.pdf,.docx,.txt,.md,.srt,.vtt";

export function UploadZone({ compact = false, hint }: { compact?: boolean; hint?: string }) {
  const { upload } = useStore();
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
      className={`rounded-2xl border-2 border-dashed text-center transition-all ${compact ? "p-4" : "p-8"} ${
        drag ? "scale-[1.01] border-accent bg-accent-soft" : "border-line2 hover:border-accent/60"}`}>
      {!compact && <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-violet"><Icon name="upload" size={22} /></div>}
      <p className={compact ? "text-sm" : "font-medium"}>{drag ? "Drop to upload" : "Drag your recording and brief here"}</p>
      <p className="mt-1 text-xs text-muted">{hint ?? "Video or audio (MP4, MOV, WAV, MP3…) · briefs (PDF, DOCX, TXT) · captions (SRT)"}</p>
      <button className={`btn mt-3 ${compact ? "btn-sm" : "btn-primary"}`} onClick={() => input.current?.click()}>
        <Icon name="plus" size={16} /> Choose files
      </button>
      <input ref={input} type="file" multiple hidden accept={ACCEPT} data-testid="file-input"
             onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
    </div>
  );
}

/** What is happening to this file right now, in plain words. */
export function assetState(asset: Asset, jobs: Job[]) {
  const mine = jobs.filter((j) => j.payload?.asset_id === asset.id);
  const active = mine.find((j) => j.status === "running") ?? mine.find((j) => j.status === "queued");
  const failed = mine.find((j) => j.status === "failed" && j.type !== "proxy");
  if (asset.status === "error") return { label: "Couldn't process", tone: "danger" as const, detail: asset.error ?? "", job: undefined };
  if (active) return {
    label: active.status === "queued" ? `Waiting: ${jobLabel(active.type).toLowerCase()}` : jobLabel(active.type),
    tone: "busy" as const, detail: eta(active), job: active,
  };
  if (failed && failed.type === "transcribe") return { label: "No transcript yet", tone: "warn" as const, detail: failed.error ?? "", job: failed };
  if (asset.kind === "document") return { label: "Brief ready", tone: "ok" as const, detail: "", job: undefined };
  if (asset.kind === "video" || asset.kind === "audio")
    return asset.has_transcript ? { label: "Ready", tone: "ok" as const, detail: "", job: undefined } : { label: "Analyzing", tone: "busy" as const, detail: "", job: undefined };
  return { label: "Ready", tone: "ok" as const, detail: "", job: undefined };
}

export function FileList({ selectable = false, selected, onSelect }: { selectable?: boolean; selected?: string | null; onSelect?: (a: Asset) => void }) {
  const { pid, assets, jobs, uploads, dismissUpload, run } = useStore();
  if (!assets.length && !uploads.length) return <Empty icon="film" title="No files yet">Your recordings and briefs will appear here.</Empty>;
  return (
    <ul className="space-y-2" aria-label="Project files">
      {uploads.map((u) => (
        <li key={u.key} className="rounded-xl border border-line bg-panel2 p-3 animate-rise">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{u.name}</span>
            {u.error ? <button className="btn btn-ghost btn-sm" onClick={() => dismissUpload(u.key)}>Dismiss</button>
              : <span className="shrink-0 text-xs text-muted">{u.done ? "Uploaded" : `Uploading ${Math.round(u.progress * 100)}%`} · {fmtBytes(u.size)}</span>}
          </div>
          {u.error ? <p role="alert" className="mt-1 text-xs text-danger">{u.error}</p> : <div className="mt-2"><Progress value={u.progress} label={`Uploading ${u.name}`} /></div>}
        </li>
      ))}
      {assets.map((a) => {
        const st = assetState(a, jobs);
        const isSel = selected === a.id;
        const Tag = selectable ? "button" : "div";
        return (
          <li key={a.id} className="group relative">
            <Tag {...(selectable ? { onClick: () => onSelect?.(a), "aria-pressed": isSel, draggable: a.kind === "video" || a.kind === "audio",
                   onDragStart: (e: React.DragEvent) => e.dataTransfer.setData("application/x-cutcue-asset", a.id) } : {})}
                 className={`flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-colors ${
                   isSel ? "border-accent bg-accent-soft" : "border-line bg-panel2 hover:border-line2"}`}>
              <div className="relative grid h-11 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-ink text-faint">
                {a.thumb_name ? <img src={thumbUrl(pid, a.id)} alt="" className="h-full w-full object-cover" />
                  : <Icon name={a.kind === "document" ? "doc" : a.kind === "audio" ? "wave" : "film"} size={18} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{a.original_name}</div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs">
                  <span className={st.tone === "ok" ? "text-ok" : st.tone === "danger" ? "text-danger" : st.tone === "warn" ? "text-warn" : "text-violet"}>
                    {st.tone === "busy" && <Spinner size={10} />} {st.label}{st.job?.status === "running" ? ` ${Math.round(st.job.progress * 100)}%` : ""}
                  </span>
                  {st.detail && st.tone === "busy" && <span className="text-faint">{st.detail}</span>}
                  {a.duration ? <span className="text-faint">{duration(a.duration)}</span> : null}
                  {a.kind === "document" && <span className="text-faint">brief</span>}
                </div>
                {st.job?.status === "running" && <div className="mt-1.5"><Progress value={st.job.progress} label={`${st.label} ${a.original_name}`} /></div>}
                {(st.tone === "danger" || st.tone === "warn") && st.detail && <p className="mt-1 line-clamp-2 text-xs text-muted" title={st.detail}>{st.detail}</p>}
              </div>
            </Tag>
            <div className="absolute right-2 top-2 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              {st.job?.status === "failed" && (
                <button className="btn btn-sm" onClick={() => run(() => api.post(`/projects/${pid}/jobs/${st.job!.id}/retry`), "Retrying…")}>Retry</button>
              )}
              <button className="btn btn-ghost btn-icon h-7 min-h-7 w-7 bg-panel/80" aria-label={`Remove ${a.original_name}`}
                      onClick={() => confirm(`Remove ${a.original_name} from this project?`) && run(() => api.del(`/projects/${pid}/assets/${a.id}`), "File removed")}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
