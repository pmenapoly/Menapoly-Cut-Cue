"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, ChatMessage, fmtTime, Proposal } from "@/lib/api";

const SUGGESTIONS = [
  "Find the most compelling 20-second hook for the intro",
  "Make a rough cut: hook first, then the full conversation with long pauses removed",
  "Create two vertical clips for Reels with burned-in captions",
];

export default function ChatPanel({ pid, mode, proposals, onProposalsChanged }: {
  pid: string; mode: string; proposals: Proposal[]; onProposalsChanged: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLDivElement>(null);

  const load = () => api.get<{ messages: ChatMessage[] }>(`/projects/${pid}/chat`).then((r) => setMessages(r.messages));
  useEffect(() => { load(); }, [pid]);
  // Scroll only the message list (scrollIntoView would also scroll the page on small screens).
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [messages.length, proposals.length, sending]);

  const send = async (message: string) => {
    if (!message.trim() || sending) return;
    setSending(true);
    setError("");
    setMessages((m) => [...m, { id: -Date.now(), role: "user", text: message, created_at: Date.now() / 1000 }]);
    setText("");
    try {
      await api.post(`/projects/${pid}/chat`, { message });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSending(false);
      load();
      onProposalsChanged();
    }
  };

  // Show each proposal right after the assistant reply of the turn that created it.
  type Item = { t: number; msg?: ChatMessage; prop?: Proposal };
  const placeAt = (p: Proposal) =>
    (messages.find((m) => m.role !== "user" && m.created_at >= p.created_at)?.created_at ?? p.created_at) + 0.0001;
  const items: Item[] = [
    ...messages.map((m) => ({ t: m.created_at, msg: m })),
    ...proposals.map((p) => ({ t: placeAt(p), prop: p })),
  ].sort((a, b) => a.t - b.t);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="label">AI editor</h2>
        <span className={`rounded px-2 py-0.5 text-[11px] ${mode === "claude" ? "bg-ok/20 text-ok" : "bg-accent/20 text-accent"}`}>
          {mode === "claude" ? "Claude" : "Local test mode"}
        </span>
      </div>
      <div ref={list} className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {items.length === 0 && (
          <div className="space-y-2 text-sm text-muted">
            <p>Ask for an edit. Proposals appear here and change nothing until you approve them.</p>
            {SUGGESTIONS.map((s) => <button key={s} className="btn btn-sm block text-left" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {items.map((it) => it.msg ? (
          <div key={`m${it.msg.id}`} className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
            it.msg.role === "user" ? "ml-6 bg-panel2" : it.msg.role === "note" ? "border border-danger text-danger" : "mr-6 border border-line"}`}>
            {it.msg.text}
          </div>
        ) : it.prop ? (
          <ProposalCard key={`p${it.prop.id}`} pid={pid} p={it.prop} onDone={onProposalsChanged} />
        ) : null)}
        {sending && <div className="mr-6 animate-pulse rounded-lg border border-line px-3 py-2 text-sm text-muted">Working through the transcript…</div>}
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <textarea className="input min-h-[2.5rem] flex-1 resize-y" rows={2} placeholder="e.g. Tighten the intro and make a 30s teaser"
                  value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
        <button className="btn btn-primary self-end" disabled={sending || !text.trim()}>Send</button>
      </form>
    </div>
  );
}

function ProposalCard({ pid, p, onDone }: { pid: string; p: Proposal; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: "approve" | "reject") => {
    setBusy(true);
    try {
      await api.post(`/projects/${pid}/proposals/${p.id}/${action}`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? [err.message, ...err.problems].join("\n") : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-accent/60 bg-panel2 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{p.title}</span>
        <span className={`text-[11px] uppercase ${p.status === "pending" ? "text-accent" : p.status === "approved" ? "text-ok" : "text-muted"}`}>{p.status}</span>
      </div>
      {p.rationale && <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{p.rationale}</p>}
      <ul className="mt-2 space-y-1 text-xs">
        {p.plan.sequences.map((s, i) => {
          const issues = s.compliance?.checks.filter((c) => c.status === "fail" || c.status === "warn") ?? [];
          return (
            <li key={i}>• {s.name}{s.sequence_id ? " (revision)" : ""}: {s.clip_count} clips, {fmtTime(s.duration)}, {s.timeline.aspect}
              {s.timeline.burn_captions ? ", captions" : ""}{s.timeline.title ? `, title “${s.timeline.title}”` : ""}
              {s.compliance && (
                <div className={`ml-3 ${issues.some((c) => c.status === "fail") ? "text-danger" : issues.length ? "text-accent" : "text-ok"}`}>
                  Brief: {s.compliance.summary}
                  {issues.slice(0, 4).map((c) => <div key={c.check} className="text-muted">– {c.check}: {c.detail}</div>)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {p.plan.notes?.auto_edit && (
        <p className="mt-1 text-xs text-muted">
          Auto-edit: −{p.plan.notes.auto_edit.removed_seconds.toFixed(1)}s of {fmtTime(p.plan.notes.auto_edit.source_duration)},
          {" "}{p.plan.notes.auto_edit.pauses_tightened} pauses tightened, fillers cut: {p.plan.notes.auto_edit.fillers_removed.map((f) => `${f.word} @${fmtTime(f.start)}`).join(", ") || "none"}
        </p>
      )}
      {p.status === "pending" && (
        <div className="mt-2 flex gap-2">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act("approve")}>Approve & render preview</button>
          <button className="btn btn-sm" disabled={busy} onClick={() => act("reject")}>Reject</button>
        </div>
      )}
      {error && <p className="mt-1 whitespace-pre-wrap text-xs text-danger">{error}</p>}
    </div>
  );
}
