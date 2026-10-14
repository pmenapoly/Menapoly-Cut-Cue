// Types for the Menapoly Cue 2.0 layer (/api/cue/*, /api/public/*). See docs/cue2/api-contract-v1.md.
import { Requirements } from "./api";

export type Tone = "danger" | "info" | "accent" | "warn" | "ok" | "muted";
export type Stage = "draft" | "editing" | "in_review" | "changes" | "approved" | "delivered";
export const STAGES: { id: Stage; label: string }[] = [
  { id: "draft", label: "Draft" }, { id: "editing", label: "Editing" }, { id: "in_review", label: "In client review" },
  { id: "changes", label: "Changes requested" }, { id: "approved", label: "Approved" }, { id: "delivered", label: "Delivered" },
];
export const stageLabel = (s: string) => STAGES.find((x) => x.id === s)?.label ?? s;

export type ProjectCard = {
  id: string; name: string; created_at: number; client_id: string | null; client_name: string | null; stage: Stage;
  archived_at: number | null; asset_count: number; media_count: number; document_count: number; thumb_asset_id: string | null;
  active_jobs: number; failed_jobs: number; pending_proposals: number; pending_actions: number; version_count: number;
  render_count: number; open_feedback: number; last_activity: number;
  status: { key: string; label: string; tone: Tone };
};
export type Client = { id: string; name: string; contact: string; notes: string; created_at: number; project_count: number };
export type JobView = {
  id: string; project_id: string; project_name: string | null; type: string; label: string; status: string;
  message: string | null; started_at: number | null; created_at: number;
};
export type Problem = { job_id?: string; asset_id?: string; label: string; error: string | null; help: string; can_retry: boolean };
export type Risk = "creates" | "changes" | "local_processing" | "client_facing" | "ai_cost" | "destructive" | "external_delivery";
export type CueAction = {
  id: string; kind: string; label: string; project_id: string | null; project_name: string | null; args: Record<string, unknown> & { reason?: string };
  summary: string; risk: Risk; risk_text: string; status: "proposed" | "running" | "executed" | "rejected" | "failed";
  created_by: string; result: (Record<string, unknown> & { href?: string; note?: string; path?: string }) | null; error: string | null;
  created_at: number; decided_at: number | null;
};
export type PriorityAction = { priority: number; project_id: string | null; project_name: string | null; text: string; href: string; tone: Tone };
export type QueueItem = { kind: "proposal" | "action" | "feedback"; id: string; title: string; project_id: string | null;
  project_name: string | null; at: number; href: string; risk?: Risk };
export type Home = { priority_actions: PriorityAction[]; recent_projects: ProjectCard[]; review_queue: QueueItem[];
  processing: JobView[]; unread_notifications: number };
export type Notification = { id: string; kind: string; title: string; body: string; project_id: string | null; project_name: string | null;
  href: string | null; created_at: number; read_at: number | null };
export type ReviewLink = { id: string; project_id: string; render_id: string; label: string; allow_download: number; created_at: number;
  expires_at: number; revoked_at: number | null; last_viewed_at: number | null; active: boolean;
  decision?: { kind: string; author: string; created_at: number } | null; comments?: number; token?: string; path?: string };
export type ReviewEvent = { id: string; link_id?: string; link_label?: string; kind: "comment" | "approved" | "changes_requested";
  author: string; body: string; at_seconds: number | null; created_at: number; resolved_at: number | null };
export type Overview = {
  project: ProjectCard;
  assets: { id: string; kind: string; original_name: string; status: string; duration: number | null; size: number;
    has_transcript: boolean; error: string | null; thumb_name: string | null }[];
  brief: { has_brief: boolean; sources: { asset_id: string; name: string }[]; requirements: Requirements };
  sequences: { id: string; name: string; versions: number; duration: number; current_version_id: string | null }[];
  renders: { id: string; status: string; quality: string; preset: string | null; duration: number | null; created_at: number;
    sequence_name: string | null; version_number: number | null; message: string | null }[];
  proposals: { id: string; title: string; status: string; created_at: number }[];
  reviews: ReviewLink[]; feedback: ReviewEvent[]; actions: CueAction[]; processing: JobView[]; problems: Problem[];
};
export type AskMessage = { id: number; role: "user" | "assistant" | "note"; text: string; created_at: number; action_ids: string[] };
export type LibraryItem = { id: string; kind: "brand_kit" | "template"; name: string; data: Record<string, unknown>; created_at: number; updated_at: number };
export type Library = {
  media: { id: string; project_id: string; project_name: string; kind: string; original_name: string; duration: number | null;
    size: number; status: string; thumb_name: string | null; created_at: number; also_in?: string[] }[];
  briefs: { id: string; project_id: string; project_name: string; original_name: string; created_at: number; status: string;
    client: string | null; deliverables: number }[];
  brand_kits: LibraryItem[]; templates: LibraryItem[]; presets: { id: string; label: string; description: string }[];
};
export type TextMessage = { id: string; direction: "in" | "out"; provider: string; from_number: string; to_number: string; body: string;
  media: { url: string; content_type: string }[]; status: string; detail: string | null; sender_name: string | null;
  project_id: string | null; project_name: string | null; action_id: string | null; created_at: number };
export type TextSender = { id: string; phone: string; name: string; consent_at: number | null; consent_note: string | null;
  opted_out_at: number | null; created_at: number };
export type TextStatus = { provider: string | null; number: string | null; inbound_ready: boolean; sending_enabled: boolean;
  sending_note: string; approved_senders: number; senders: TextSender[]; messages: TextMessage[] };
export type Meta = { stages: { id: Stage; label: string }[]; ask_mode: "claude" | "local-test"; ask_budget_usd: number;
  ask_spent_usd: number; public_url: string | null; text: Omit<TextStatus, "senders" | "messages"> };

export const RISK_LABEL: Record<Risk, string> = {
  creates: "Creates", changes: "Changes status", local_processing: "Runs on this computer", client_facing: "Client-facing",
  ai_cost: "Uses AI budget", destructive: "Hides a project", external_delivery: "Sends outside the app",
};

/** Full link for something the owner will share (uses CUTCUE_PUBLIC_URL when set, else this browser's origin). */
export function shareUrl(path: string, publicUrl?: string | null) {
  const base = publicUrl || (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}${path}`;
}

/** Elapsed time since a real timestamp (seconds) — used instead of invented percentages. */
export function elapsed(since: number | null | undefined, nowMs = Date.now()) {
  if (!since) return "";
  const s = Math.max(0, Math.round(nowMs / 1000 - since));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
