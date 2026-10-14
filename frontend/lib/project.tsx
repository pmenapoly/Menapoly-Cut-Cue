"use client";
// One project store shared by Cue Simple and Cue Pro: same data, same draft, same history.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  api, ApiError, Asset, Brief, ChatMessage, Health, Job, Preset, Project, Proposal, Render, Segment, Sequence, Timeline, uploadFile,
} from "./api";
import { sameTimeline } from "./timeline";

export type Upload = { key: string; name: string; size: number; progress: number; error?: string; done?: boolean };
export type Toast = { id: number; text: string; tone: "ok" | "error" | "info" };

type Store = {
  pid: string; loaded: boolean; health: Health | null; project: Project | null; assets: Asset[]; sequences: Sequence[];
  proposals: Proposal[]; renders: Render[]; jobs: Job[]; brief: Brief | null; presets: Preset[]; messages: ChatMessage[];
  segments: Record<string, Segment[]>; uploads: Upload[]; toasts: Toast[]; sending: boolean;
  seqId: string | null; setSeqId: (id: string | null) => void; seq: Sequence | null;
  draft: Timeline | null; dirty: boolean; canUndo: boolean; canRedo: boolean;
  edit: (t: Timeline) => void; undo: () => void; redo: () => void; discard: () => void; save: (label?: string) => Promise<void>;
  refresh: () => Promise<void>; upload: (files: FileList | File[]) => void; send: (text: string) => Promise<void>;
  approve: (p: Proposal) => Promise<void>; reject: (p: Proposal) => Promise<void>;
  exportWith: (preset: string, wav?: boolean) => Promise<Render | null>;
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | null>; toast: (text: string, tone?: Toast["tone"]) => void;
  dismissUpload: (key: string) => void; reloadTranscript: (assetId: string) => Promise<void>;
};

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside ProjectProvider");
  return s;
};

const errorText = (err: unknown) => (err instanceof ApiError ? [err.message, ...err.problems].join(" · ") : String(err));

export function ProjectProvider({ pid, children }: { pid: string; children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [renders, setRenders] = useState<Render[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [segments, setSegments] = useState<Record<string, Segment[]>>({});
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sending, setSending] = useState(false);
  const [seqId, setSeqIdState] = useState<string | null>(null);
  // Draft history: past/future stacks of unsaved timelines for the active sequence.
  const [draft, setDraft] = useState<Timeline | null>(null);
  const [past, setPast] = useState<Timeline[]>([]);
  const [future, setFuture] = useState<Timeline[]>([]);
  const transcriptKeys = useRef<Record<string, string>>({});

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, a, s, pr, r, j, b, chat] = await Promise.all([
        api.get<Project>(`/projects/${pid}`), api.get<Asset[]>(`/projects/${pid}/assets`),
        api.get<Sequence[]>(`/projects/${pid}/sequences`), api.get<Proposal[]>(`/projects/${pid}/proposals`),
        api.get<Render[]>(`/projects/${pid}/renders`), api.get<Job[]>(`/projects/${pid}/jobs`),
        api.get<Brief>(`/projects/${pid}/brief`), api.get<{ messages: ChatMessage[] }>(`/projects/${pid}/chat`),
      ]);
      setProject(p); setAssets(a); setSequences(s); setProposals(pr); setRenders(r); setJobs(j); setBrief(b);
      setMessages(chat.messages);
      setLoaded(true);
    } catch (err) {
      if (!loaded) toast(errorText(err), "error");
    }
  }, [pid, loaded, toast]);

  useEffect(() => {
    api.get<Health>("/health").then(setHealth).catch(() => {});
    api.get<Preset[]>("/presets").then(setPresets).catch(() => {});
    refresh();
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = jobs.some((j) => j.status === "queued" || j.status === "running") || uploads.some((u) => !u.done && !u.error);
  useEffect(() => {
    const t = setInterval(refresh, busy ? 1500 : 5000);
    return () => clearInterval(t);
  }, [refresh, busy]);

  // Transcript cache (refetched when an asset's transcript or speakers change).
  useEffect(() => {
    for (const a of assets) {
      if (!(a.kind === "video" || a.kind === "audio") || !a.has_transcript) continue;
      const diarized = jobs.filter((j) => j.type === "diarize" && j.payload?.asset_id === a.id && j.status === "succeeded").length;
      const key = `${a.has_transcript}-${diarized}`;
      if (transcriptKeys.current[a.id] === key) continue;
      transcriptKeys.current[a.id] = key;
      api.get<Segment[]>(`/projects/${pid}/assets/${a.id}/transcript`).then((segs) => setSegments((s) => ({ ...s, [a.id]: segs })));
    }
  }, [assets, jobs, pid]);

  // Active sequence: keep a valid selection.
  useEffect(() => {
    if (seqId && sequences.some((s) => s.id === seqId)) return;
    setSeqIdState(sequences[0]?.id ?? null);
  }, [sequences, seqId]);
  const seq = sequences.find((s) => s.id === seqId) ?? null;
  // `base` is the saved timeline the draft started from; local edits = draft differs from it.
  const [base, setBase] = useState<Timeline | null>(null);
  const dirty = !!draft && !sameTimeline(draft, base);

  // When the saved version changes (approve, restore, undo/redo of versions) and there are no local edits, follow it.
  useEffect(() => {
    if (!dirty) { setDraft(seq?.timeline ?? null); setBase(seq?.timeline ?? null); setPast([]); setFuture([]); }
  }, [seq?.current_version_id, seqId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSeqId = useCallback((id: string | null) => {
    if (dirty && !confirm("You have unsaved timeline changes. Discard them?")) return;
    setPast([]); setFuture([]);
    setSeqIdState(id);
    const tl = sequences.find((s) => s.id === id)?.timeline ?? null;
    setDraft(tl); setBase(tl);
  }, [dirty, sequences]);

  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | null> => {
    try {
      const out = await fn();
      if (success) toast(success, "ok");
      await refresh();
      return out;
    } catch (err) {
      toast(errorText(err), "error");
      return null;
    }
  }, [refresh, toast]);

  const edit = useCallback((t: Timeline) => {
    if (draft) setPast((p) => [...p.slice(-99), draft]);
    setFuture([]);
    setDraft(t);
  }, [draft]);

  const serverStep = useCallback((dir: "undo" | "redo") => seq && run(async () => {
    await api.post(`/projects/${pid}/sequences/${seq.id}/${dir}`);
  }, dir === "undo" ? "Went back to the previous version" : "Restored the newer version"), [seq, pid, run]);

  const undo = useCallback(() => {
    if (past.length && draft) {
      setFuture((f) => [draft, ...f]);
      setDraft(past[past.length - 1]);
      setPast((p) => p.slice(0, -1));
    } else serverStep("undo");
  }, [past, draft, serverStep]);

  const redo = useCallback(() => {
    if (future.length && draft) {
      setPast((p) => [...p, draft]);
      setDraft(future[0]);
      setFuture((f) => f.slice(1));
    } else serverStep("redo");
  }, [future, draft, serverStep]);

  const versionIndex = seq ? seq.versions.findIndex((v) => v.id === seq.current_version_id) : -1;
  const canUndo = past.length > 0 || versionIndex > 0;
  const canRedo = future.length > 0 || (seq ? versionIndex >= 0 && versionIndex < seq.versions.length - 1 : false);

  const discard = useCallback(() => { setDraft(seq?.timeline ?? null); setBase(seq?.timeline ?? null); setPast([]); setFuture([]); }, [seq]);

  const save = useCallback(async (label = "Edited in Cue Pro") => {
    if (!seq || !draft) return;
    const saved = draft;
    const ok = await run(() => api.post(`/projects/${pid}/sequences/${seq.id}/versions`, { timeline: saved, label }), "Saved as a new version");
    if (ok) { setBase(saved); setPast([]); setFuture([]); }
  }, [seq, draft, pid, run]);

  const upload = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0 }]);
      const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      uploadFile(pid, file, (f) => patch({ progress: f }))
        .then(() => {
          patch({ progress: 1, done: true });
          setTimeout(() => setUploads((u) => u.filter((x) => x.key !== key)), 2500);
          refresh();
        })
        .catch((err) => patch({ error: errorText(err) }));
    }
  }, [pid, refresh]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    setMessages((m) => [...m, { id: -Date.now(), role: "user", text, created_at: Date.now() / 1000 }]);
    try {
      await api.post(`/projects/${pid}/chat`, { message: text });
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setSending(false);
      await refresh();
    }
  }, [pid, sending, refresh, toast]);

  const approve = useCallback(async (p: Proposal) => {
    const res = await run(() => api.post<Proposal>(`/projects/${pid}/proposals/${p.id}/approve`), "Approved. Rendering a preview…");
    const first = res?.result?.created?.[0];
    if (first) { setPast([]); setFuture([]); setDraft(null); setBase(null); setSeqIdState(first.sequence_id); }
  }, [pid, run]);

  const reject = useCallback(async (p: Proposal) => {
    await run(() => api.post(`/projects/${pid}/proposals/${p.id}/reject`), "Proposal dismissed");
  }, [pid, run]);

  const exportWith = useCallback(async (preset: string, wav = false) => {
    if (!seq?.current_version_id) { toast("Approve an edit first: there is nothing to export yet.", "error"); return null; }
    return run(() => api.post<Render>(`/projects/${pid}/renders`, { version_id: seq.current_version_id, preset, wav }),
      "Export started. You can keep working.");
  }, [seq, pid, run, toast]);

  const dismissUpload = useCallback((key: string) => setUploads((u) => u.filter((x) => x.key !== key)), []);
  const reloadTranscript = useCallback(async (assetId: string) => {
    const segs = await api.get<Segment[]>(`/projects/${pid}/assets/${assetId}/transcript`);
    setSegments((s) => ({ ...s, [assetId]: segs }));
  }, [pid]);

  const value = useMemo<Store>(() => ({
    pid, loaded, health, project, assets, sequences, proposals, renders, jobs, brief, presets, messages, segments, uploads, toasts,
    sending, seqId, setSeqId, seq, draft, dirty, canUndo, canRedo, edit, undo, redo, discard, save, refresh, upload, send, approve,
    reject, exportWith, run, toast, dismissUpload, reloadTranscript,
  }), [pid, loaded, health, project, assets, sequences, proposals, renders, jobs, brief, presets, messages, segments, uploads, toasts,
    sending, seqId, setSeqId, seq, draft, dirty, canUndo, canRedo, edit, undo, redo, discard, save, refresh, upload, send, approve,
    reject, exportWith, run, toast, dismissUpload, reloadTranscript]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
