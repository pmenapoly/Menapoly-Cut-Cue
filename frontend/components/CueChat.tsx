"use client";
// Cue: the conversational editor. Suggested prompts adapt to the project; proposals are explained in plain
// language with Preview / Approve / Revise / Reject.
import { useEffect, useRef, useState } from "react";
import { ChatMessage, Proposal, ProposalSeq } from "@/lib/api";
import { duration } from "@/lib/format";
import { useStore } from "@/lib/project";
import { Icon, Spinner } from "./ui";
import { useWorkspace } from "./workspace";

type Suggestion = { text: string; action?: () => void };

function explain(p: Proposal) {
  const seqs = p.plan.sequences;
  const ae = p.plan.notes?.auto_edit;
  const bullets: string[] = [];
  if (ae) {
    bullets.push(`Removes ${ae.removed_seconds.toFixed(1)} s of ${duration(ae.source_duration)}: ${ae.pauses_tightened} long pauses shortened`
      + (ae.fillers_removed.length ? `, ${ae.fillers_removed.length} filler word${ae.fillers_removed.length > 1 ? "s" : ""} (${ae.fillers_removed.map((f) => f.word.replace(/[.,]/g, "")).join(", ")})` : "") + ".");
    bullets.push("Natural pauses are kept when the speaker changes or after a question.");
  }
  for (const s of seqs) {
    const kind = s.timeline.aspect === "9:16" ? "vertical clip" : s.timeline.aspect === "1:1" ? "square clip" : "edit";
    const extras = [s.timeline.burn_captions && "captions", s.timeline.title && `title “${s.timeline.title}”`,
      s.timeline.clips[0]?.label === "Hook" && "opens with a hook"].filter(Boolean).join(", ");
    bullets.push(`${s.name.replace(/^Clip \d+: /, "")}: a ${duration(s.duration)} ${kind}${extras ? ` (${extras})` : ""}.`);
  }
  return { headline: seqs.length > 1 ? `${seqs.length} outputs` : seqs[0] ? `${duration(seqs[0].duration)} ${seqs[0].timeline.aspect}` : "", bullets };
}

function Compliance({ s }: { s: ProposalSeq }) {
  if (!s.compliance?.checks.length) return null;
  const issues = s.compliance.checks.filter((c) => c.status === "fail" || c.status === "warn");
  const fail = issues.some((c) => c.status === "fail");
  return (
    <div className={`mt-1 rounded-lg px-2.5 py-1.5 text-xs ${fail ? "bg-danger/10 text-danger" : issues.length ? "bg-warn/10 text-warn" : "bg-ok/10 text-ok"}`}>
      <span className="font-medium">Brief check:</span> {fail ? "needs changes" : issues.length ? "a few things to review" : "meets the brief"}
      {issues.slice(0, 3).map((c) => <div key={c.check} className="text-muted">· {c.check.replace(/^(include|avoid): /, (m) => (m.startsWith("include") ? "mention " : "avoid "))}: {c.detail}</div>)}
    </div>
  );
}

export function ProposalCard({ p }: { p: Proposal }) {
  const { approve, reject, send } = useStore();
  const { preview, setPreview, setMobileTab } = useWorkspace();
  const [busy, setBusy] = useState<"" | "approve" | "reject">("");
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [why, setWhy] = useState(false);
  const { headline, bullets } = explain(p);
  const pending = p.status === "pending";
  return (
    <article className={`rounded-2xl border p-4 animate-rise ${pending ? "border-accent/50 bg-gradient-to-b from-accent-soft to-transparent" : "border-line bg-panel2/60"}`}
             aria-label={`Proposal: ${p.title}`} data-testid="proposal">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label flex items-center gap-1.5 text-violet"><Icon name="sparkle" size={13} /> Proposed edit</p>
          <h3 className="mt-1 font-semibold leading-snug">{p.title.replace(/^Local planner: /, "")}</h3>
        </div>
        <span className={`chip shrink-0 ${p.status === "approved" ? "border-ok/40 text-ok" : p.status === "rejected" ? "text-faint" : "border-accent/50 text-violet"}`}>
          {p.status === "pending" ? "Waiting for you" : p.status}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted">{headline}</p>
      <ul className="mt-2 space-y-1.5 text-sm">
        {bullets.map((b, i) => <li key={i} className="flex gap-2"><Icon name="check" size={15} className="mt-0.5 shrink-0 text-violet" />{b}</li>)}
      </ul>
      {p.plan.sequences.map((s, i) => <Compliance key={i} s={s} />)}
      {p.rationale && (
        <button className="mt-2 text-xs text-muted underline-offset-2 hover:text-text hover:underline" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
          {why ? "Hide" : "Why Cue chose this"}
        </button>
      )}
      {why && <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted">{p.rationale}</p>}
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          {p.plan.sequences.map((s, i) => {
            const active = preview.kind === "proposal" && preview.id === p.id && preview.index === i;
            return (
              <button key={i} className={`btn btn-sm ${active ? "border-accent text-violet" : ""}`} aria-pressed={active}
                      onClick={() => { setPreview({ kind: "proposal", id: p.id, index: i }); setMobileTab("preview"); }}>
                <Icon name="play" size={12} /> Preview{p.plan.sequences.length > 1 ? ` ${i + 1}` : ""}
              </button>
            );
          })}
          <button className="btn btn-primary btn-sm" disabled={!!busy}
                  onClick={async () => { setBusy("approve"); await approve(p); setPreview({ kind: "edit" }); setMobileTab("preview"); setBusy(""); }}>
            {busy === "approve" ? <Spinner size={12} /> : <Icon name="check" size={14} />} Approve
          </button>
          <button className="btn btn-sm" onClick={() => setRevising((r) => !r)} aria-expanded={revising}>Revise</button>
          <button className="btn btn-ghost btn-sm text-muted" disabled={!!busy}
                  onClick={async () => { setBusy("reject"); await reject(p); setBusy(""); }}>Reject</button>
        </div>
      )}
      {revising && (
        <form className="mt-3 flex gap-2 animate-rise" onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          send(`Revise the proposal "${p.title}" (${p.id}): ${note}`);
          setNote(""); setRevising(false);
        }}>
          <input className="input" autoFocus placeholder="What should change? e.g. keep the intro, make it under 30 s"
                 value={note} onChange={(e) => setNote(e.target.value)} aria-label="Revision request" />
          <button className="btn btn-primary btn-sm shrink-0" disabled={!note.trim()}>Send</button>
        </form>
      )}
    </article>
  );
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === "user") return <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-panel3 px-3.5 py-2 text-sm animate-rise">{m.text}</div>;
  const note = m.role === "note";
  return (
    <div className={`flex max-w-[92%] gap-2.5 animate-rise ${note ? "text-danger" : ""}`}>
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent-strong to-violet text-white"><Icon name="sparkle" size={14} /></span>
      <div className="whitespace-pre-wrap text-sm leading-relaxed">{m.text.replace(/^\[Local test mode[^\]]*\]\s*/, "")}</div>
    </div>
  );
}

export function CueChat() {
  const { messages, proposals, send, sending, assets, sequences, health, brief } = useStore();
  const { openBrief, setMobileTab } = useWorkspace();
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [messages.length, proposals.length, sending]);

  const media = assets.filter((a) => a.kind === "video" || a.kind === "audio");
  const ready = media.some((a) => a.has_transcript);
  const processing = media.length > 0 && !ready;
  const suggestions: Suggestion[] = !ready ? [] : sequences.length === 0 ? [
    { text: "Make a tight rough cut with a hook" },
    { text: "Remove pauses and filler words" },
    { text: "Create 2 vertical clips for Reels" },
    ...(brief?.has_brief ? [{ text: "What does the brief ask for?", action: openBrief }] : []),
  ] : [
    { text: "Create 2 vertical clips for Reels" },
    { text: "Add a hook at the start" },
    { text: "Check my edit against the brief", action: openBrief },
  ];

  type Item = { t: number; m?: ChatMessage; p?: Proposal };
  const placeAt = (p: Proposal) => (messages.find((m) => m.role !== "user" && m.created_at >= p.created_at)?.created_at ?? p.created_at) + 0.0001;
  const items: Item[] = [...messages.map((m) => ({ t: m.created_at, m })), ...proposals.map((p) => ({ t: placeAt(p), p }))].sort((a, b) => a.t - b.t);

  const submit = (value: string) => { if (value.trim()) { send(value.trim()); setText(""); } };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Cue, your AI editor">
      <header className="flex items-center justify-between gap-2 pb-3">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-accent-strong to-violet text-white"><Icon name="sparkle" size={16} /></span>
          <div>
            <h2 className="text-sm font-semibold leading-tight">Cue</h2>
            <p className="text-[11px] text-faint">{health?.assistant_mode === "claude" ? "AI editor · Claude" : "Test mode · add a Claude key for full chat"}</p>
          </div>
        </div>
      </header>
      <div ref={list} className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" aria-live="polite">
        {items.length === 0 && (
          <div className="rounded-2xl border border-line bg-panel2/60 p-4 text-sm">
            <p className="font-medium">Hi! I&apos;m Cue.</p>
            <p className="mt-1 text-muted">
              {media.length === 0 ? "Add your recording (and the brief, if you have one) and I'll listen to it."
                : processing ? "I'm listening to your recording now. You'll be able to ask for edits in a moment."
                  : "Tell me what you'd like, or pick a suggestion. Nothing changes until you approve it."}
            </p>
            {media.length === 0 && <button className="btn btn-sm mt-3" onClick={() => setMobileTab("files")}><Icon name="upload" size={14} /> Add files</button>}
          </div>
        )}
        {items.map((it) => it.m ? <Message key={`m${it.m.id}`} m={it.m} /> : it.p ? <ProposalCard key={`p${it.p.id}`} p={it.p} /> : null)}
        {sending && (
          <div className="flex items-center gap-2.5 text-sm text-muted">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-panel3"><Spinner size={14} /></span>
            Cue is working through your recording…
          </div>
        )}
      </div>
      {suggestions.length > 0 && !sending && (
        <div className="flex gap-2 overflow-x-auto py-2 scroll-thin" aria-label="Suggested requests">
          {suggestions.map((s) => (
            <button key={s.text} className="btn btn-sm shrink-0 rounded-full border-accent/30 text-violet hover:bg-accent-soft"
                    onClick={() => (s.action ? s.action() : submit(s.text))}>{s.text}</button>
          ))}
        </div>
      )}
      <form className="relative mt-1" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
        <label htmlFor="cue-input" className="sr-only">Message Cue</label>
        <textarea id="cue-input" rows={2} className="input resize-none pr-12"
                  placeholder={ready ? "Ask Cue… e.g. “cut it to 20 minutes and keep the funny bits”" : "Upload a recording to start"}
                  value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(text); } }} />
        <button className="btn btn-primary btn-icon absolute bottom-2 right-2 h-8 min-h-8 w-8" disabled={sending || !text.trim()} aria-label="Send">
          <Icon name="send" size={15} />
        </button>
      </form>
    </section>
  );
}
