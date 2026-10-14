import { Job } from "./api";

export function timeAgo(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)} d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** "about 3 min left" from a running job's progress rate; empty until there is enough signal. */
export function eta(job: Pick<Job, "progress" | "started_at" | "status">): string {
  if (job.status !== "running" || !job.started_at || job.progress < 0.03) return "";
  const elapsed = Date.now() / 1000 - job.started_at;
  const left = (elapsed / job.progress) * (1 - job.progress);
  if (!Number.isFinite(left) || left < 1) return "";
  return left < 60 ? `about ${Math.max(5, Math.round(left / 5) * 5)} s left` : `about ${Math.round(left / 60)} min left`;
}

const JOB_LABELS: Record<string, string> = {
  analyze: "Analyzing", transcribe: "Transcribing", diarize: "Finding speakers", proxy: "Preparing preview",
  render: "Rendering", reimport: "Replacing audio",
};
export const jobLabel = (type: string) => JOB_LABELS[type] ?? type;
