// Typed client for the Menapoly Cut Cue API (same origin: proxied in dev, served by FastAPI in prod).

export type Health = {
  app: string; version: string; ffmpeg: boolean; ffprobe: boolean;
  assistant_mode: "claude" | "local-test"; claude_model: string | null;
  transcriber: string; whisper_model: string; cloud_configured: boolean; auth_required: boolean;
};
export type Project = {
  id: string; name: string; created_at: number; processing_mode: "local" | "cloud";
  cloud_approved: number; budget_usd: number; spent_usd: number; asset_count?: number;
  thumb_asset_id?: string | null; active_jobs?: number; render_count?: number; last_activity?: number;
};
export type Activity = { kind: "render" | "proposal" | "upload"; project_id: string; project_name: string; at: number; status: string; detail: string };
export type Preset = {
  id: string; label: string; description: string; aspect?: Aspect; loudness_target?: number; burn_captions?: boolean; wav: boolean;
};
export type Waveform = { duration: number; peaks: number[] };
export type Asset = {
  id: string; project_id: string; kind: "video" | "audio" | "image" | "document" | "subtitle";
  original_name: string; size: number; duration: number | null; has_video: number; has_audio: number;
  width: number | null; height: number | null; status: string; error: string | null;
  thumb_name: string | null; proxy_name: string | null; has_transcript: boolean;
  silences?: { start: number; end: number }[]; scenes?: number[]; text?: string;
  audio_override_id?: string | null; audio_offset?: number | null;
};
export type Word = { start: number; end: number; word: string; speaker?: string };
export type Segment = { idx: number; start: number; end: number; text: string; words: Word[]; source: string; speaker?: string | null };
export type Clip = { asset_id: string; start: number; end: number; label?: string; focus_x?: number };
export type Aspect = "16:9" | "9:16" | "1:1";
export type AudioSettings = {
  denoise: "off" | "light" | "strong"; voice_eq: boolean; compress: boolean; loudness_target: number;
  music_asset_id: string | null; music_volume_db: number; duck: boolean;
};
export const DEFAULT_AUDIO: AudioSettings = {
  denoise: "off", voice_eq: false, compress: false, loudness_target: -16, music_asset_id: null, music_volume_db: -18, duck: true,
};
export type Timeline = {
  aspect: Aspect; clips: Clip[]; burn_captions: boolean; normalize_audio: boolean; audio?: AudioSettings; title?: string;
};
export type SpeakerLabel = { name: string; focus_x: number; talk_seconds: number };
export type Speakers = { method: string | null; confidence?: number; labels: Record<string, SpeakerLabel> };
export type Deliverable = {
  kind: "full" | "clip"; count: number; aspect: Aspect; min_s?: number; max_s?: number; captions: boolean | null;
  platforms: string[]; text: string;
};
export type Requirements = {
  client?: string; goals?: string[]; audience?: string; tone?: string[]; platforms?: string[]; deliverables?: Deliverable[];
  key_messages?: string[]; must_include?: string[]; must_avoid?: string[]; cta?: string; deadline?: string;
  loudness_target?: number; keywords?: string[];
};
export type Brief = {
  requirements: Requirements; sources: { asset_id: string; name: string }[]; overrides: Requirements;
  override_source: string | null; has_brief: boolean;
};
export type Check = { check: string; status: "pass" | "fail" | "warn" | "info"; detail: string };
export type Compliance = { deliverable: Deliverable | null; checks: Check[]; summary: string };
export type VersionMeta = { id: string; number: number; label: string; origin: string; parent_id: string | null; created_at: number };
export type Sequence = {
  id: string; name: string; current_version_id: string | null; versions: VersionMeta[];
  timeline: Timeline | null; duration: number;
};
export type ProposalSeq = {
  sequence_id: string | null; name: string; timeline: Timeline; duration: number; clip_count: number; compliance?: Compliance;
};
export type Proposal = {
  id: string; title: string; rationale: string; status: "pending" | "approved" | "rejected";
  created_by: string; created_at: number;
  plan: { sequences: ProposalSeq[]; notes?: { auto_edit?: { fillers_removed: { start: number; word: string }[];
    pauses_tightened: number; removed_seconds: number; source_duration: number } } };
  result: { created: { sequence_id: string; version_id: string; render_id?: string }[] } | null;
};
export type ChatMessage = { id: number; role: "user" | "assistant" | "note"; text: string; created_at: number };
export type Render = {
  id: string; sequence_id: string; version_id: string; job_id: string | null; quality: "preview" | "final";
  status: string; output_name: string | null; srt_name: string | null; wav_name: string | null;
  duration: number | null; created_at: number; progress: number | null; message: string | null; error: string | null;
  version_number?: number; sequence_name?: string; origin?: string; parent_render_id?: string | null; preset?: string | null;
  info?: { measured_input_lufs?: number; noise_floor_db?: number | null; chain?: string[]; duck?: boolean; offset?: number };
};
export type Job = {
  id: string; type: string; status: string; progress: number; message: string | null; error: string | null;
  worker: string; created_at: number; updated_at: number; payload: Record<string, unknown>;
  started_at?: number | null; finished_at?: number | null;
};
export type Compare = {
  a: { id: string; number: number; duration: number; clips: number; aspect: Aspect };
  b: { id: string; number: number; duration: number; clips: number; aspect: Aspect };
  only_in_a: Clip[]; only_in_b: Clip[]; shared_clips: number;
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail ?? data);
    throw new ApiError(res.status, detail, data.problems ?? []);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => request<T>("POST", p, b),
  patch: <T>(p: string, b: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b: unknown) => request<T>("PUT", p, b),
  del: (p: string) => request<void>("DELETE", p),
};

export const mediaUrl = (pid: string, aid: string) => `/api/projects/${pid}/assets/${aid}/media`;
export const thumbUrl = (pid: string, aid: string) => `/api/projects/${pid}/assets/${aid}/thumbnail`;
export const frameUrl = (pid: string, aid: string, t: number) => `/api/projects/${pid}/assets/${aid}/frame?t=${(Math.round(t * 2) / 2).toFixed(1)}`;
export const renderUrl = (pid: string, rid: string, kind: "mp4" | "srt" | "wav", download = false) =>
  `/api/projects/${pid}/renders/${rid}/${kind}${download ? "?download=true" : ""}`;

const CHUNK = 8 * 1024 * 1024;

/** Resumable chunked upload. Resumes from the server's byte count after a failure. */
export async function uploadFile(pid: string, file: File, onProgress: (fraction: number) => void): Promise<Asset> {
  const up = await api.post<{ id: string }>(`/projects/${pid}/uploads`, { filename: file.name, size: file.size });
  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + CHUNK, file.size));
    try {
      const res = await fetch(`/api/projects/${pid}/uploads/${up.id}?offset=${offset}`, {
        method: "PUT", body: chunk, credentials: "same-origin",
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).detail ?? "Upload failed");
      offset = (await res.json()).received;
      failures = 0;
      onProgress(offset / file.size);
    } catch (err) {
      if (++failures > 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
      offset = (await api.get<{ received: number }>(`/projects/${pid}/uploads/${up.id}`)).received;
    }
  }
  return api.post<Asset>(`/projects/${pid}/uploads/${up.id}/complete`);
}

export function fmtTime(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "–";
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = sec.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}
