"use client";
// Reusable Menapoly Cue components: project cards/rows, action cards (proposed vs. done), processing list,
// Ask Cue composer + thread, new-project dialog and copy fields. All data comes from /api/cue.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, thumbUrl } from "@/lib/api";
import { AskMessage, Client, CueAction, elapsed, JobView, ProjectCard, RISK_LABEL, stageLabel } from "@/lib/cue";
import { timeAgo } from "@/lib/format";
import { useShell } from "./shell";
import { Dialog, Empty, Icon, Spinner, StatusPill } from "./ui";

export function ProjectThumb({ p, className = "" }: { p: Pick<ProjectCard, "id" | "thumb_asset_id" | "media_count">; className?: string }) {
  return (
    <div className={`relative overflow-hidden bg-panel2 ${className}`}>
      {p.thumb_asset_id
        ? <img src={thumbUrl(p.id, p.thumb_asset_id)} alt="" className="h-full w-full object-cover" loading="lazy" />
        : <div className="grid h-full place-items-center text-faint"><Icon name={p.media_count ? "wave" : "film"} size={26} /></div>}
    </div>
  );
}

export function ProjectCardView({ p }: { p: ProjectCard }) {
  return (
    <li className="group card overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:border-line2" data-testid="project-card">
      <Link href={`/projects/?id=${p.id}`} className="block focus-visible:outline-offset-[-2px]">
        <ProjectThumb p={p} className="aspect-video" />
        <div className="space-y-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate font-semibold tracking-tight">{p.name}</h3>
          </div>
          <p className="truncate text-xs text-muted">{p.client_name ?? "No client"} · {stageLabel(p.stage)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={p.status.label} tone={p.status.tone} busy={p.status.key === "processing"} />
            <span className="text-xs text-faint">{timeAgo(p.last_activity)}</span>
          </div>
        </div>
      </Link>
    </li>
  );
}

export function ProjectRow({ p }: { p: ProjectCard }) {
  return (
    <li>
      <Link href={`/projects/?id=${p.id}`} data-testid="project-row"
            className="flex min-h-14 items-center gap-3 rounded-xl border border-transparent p-2 hover:border-line hover:bg-panel2">
        <ProjectThumb p={p} className="h-10 w-16 shrink-0 rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{p.name}</span>
          <span className="block truncate text-xs text-muted">{p.client_name ?? "No client"} · {p.media_count} media · {p.render_count} render{p.render_count === 1 ? "" : "s"}</span>
        </span>
        <span className="hidden text-xs text-muted sm:block">{stageLabel(p.stage)}</span>
        <StatusPill label={p.status.label} tone={p.status.tone} busy={p.status.key === "processing"} />
      </Link>
    </li>
  );
}

/** Processing activity: real stage text + elapsed time. Never a made-up percentage. */
export function ProcessingList({ jobs, showProject = true }: { jobs: JobView[]; showProject?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!jobs.length) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [jobs.length]);
  if (!jobs.length) return <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">Nothing is processing right now.</p>;
  return (
    <ul className="space-y-2" aria-label="Processing">
      {jobs.map((j) => (
        <li key={j.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-3" data-testid="processing-item">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-violet">
            {j.status === "running" ? <Spinner /> : <Icon name="clock" size={16} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{j.status === "queued" ? `Waiting: ${j.label.toLowerCase()}` : j.label}
              {showProject && j.project_name && <span className="font-normal text-muted"> · {j.project_name}</span>}</span>
            <span className="block truncate text-xs text-muted">
              {j.status === "running" ? `${j.message ?? "Working"} · ${elapsed(j.started_at)} so far` : "In line, starts when the computer is free"}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A proposed action looks like a proposal (dashed, "Needs your approval"); done/failed ones say so plainly. */
export function ActionCard({ a, onChange }: { a: CueAction; onChange?: (a: CueAction) => void }) {
  const { toast, refreshBadges } = useShell();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const serious = a.risk === "client_facing" || a.risk === "destructive" || a.risk === "external_delivery" || a.risk === "ai_cost";
  const decide = async (what: "approve" | "reject") => {
    setBusy(what);
    try {
      const r = await api.post<CueAction>(`/cue/actions/${a.id}/${what}`);
      onChange?.(r);
      refreshBadges();
      if (what === "reject") toast("Dismissed. Nothing was changed.", "info");
      else if (r.status === "failed") toast(`Didn't work: ${r.error}`, "error");
      else toast(r.result?.note ? String(r.result.note) : "Done.");
    } catch (err) { toast(err instanceof ApiError ? err.message : "Couldn't reach Cue", "error"); }
    setBusy(null); setConfirming(false);
  };
  const proposed = a.status === "proposed";
  return (
    <article data-testid="action-card" data-status={a.status} aria-label={`${proposed ? "Proposed" : a.status}: ${a.summary}`}
             className={`rounded-2xl border p-4 ${proposed ? "border-dashed border-accent/60 bg-accent-soft/40" : "border-line bg-panel"}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {proposed ? <span className="inline-flex items-center gap-1 font-semibold text-violet"><Icon name="sparkle" size={13} /> Proposed · needs your approval</span>
          : a.status === "executed" ? <span className="inline-flex items-center gap-1 font-semibold text-ok"><Icon name="check" size={13} /> Approved and done</span>
          : a.status === "failed" ? <span className="inline-flex items-center gap-1 font-semibold text-danger"><Icon name="alert" size={13} /> Approved, but it didn&apos;t work</span>
          : a.status === "running" ? <span className="inline-flex items-center gap-1 font-semibold"><Spinner size={12} /> Running</span>
          : <span className="font-semibold text-muted">Dismissed</span>}
        <span className="chip">{RISK_LABEL[a.risk]}</span>
        <span className="text-faint">{a.created_by === "cue_text" ? "from a text" : a.created_by === "ask-cue" ? "from Ask Cue" : "by you"} · {timeAgo(a.created_at)}</span>
      </div>
      <p className="mt-2 font-medium">{a.summary}</p>
      {a.args.reason && <p className="mt-1 text-sm text-muted">{a.args.reason}</p>}
      {proposed && <p className="mt-1 text-xs text-muted">{a.risk_text}</p>}
      {a.status === "failed" && a.error && <p className="mt-2 text-sm text-danger">{a.error}</p>}
      {a.status === "executed" && a.result && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {a.result.note && <span className="text-muted">{String(a.result.note)}</span>}
          {a.result.href && <Link className="btn btn-sm" href={String(a.result.href)}>Open <Icon name="chevron" size={14} /></Link>}
        </div>
      )}
      {proposed && (
        <div className="mt-3 flex flex-wrap gap-2">
          {confirming ? (
            <>
              <span className="w-full text-sm">{a.risk === "client_facing" ? "This creates a link someone outside can open. Continue?"
                : a.risk === "destructive" ? "This hides the project from your lists. Continue?"
                : a.risk === "ai_cost" ? "This uses Claude and counts toward the project's AI budget. Continue?"
                : "This sends a message outside the app. Continue?"}</span>
              <button className="btn btn-primary min-h-11" disabled={!!busy} onClick={() => decide("approve")}>{busy === "approve" ? <Spinner /> : <Icon name="check" />} Yes, approve</button>
              <button className="btn min-h-11" onClick={() => setConfirming(false)}>Back</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary min-h-11" disabled={!!busy} onClick={() => (serious ? setConfirming(true) : decide("approve"))}>
                {busy === "approve" ? <Spinner /> : <Icon name="check" />} Approve
              </button>
              <button className="btn min-h-11" disabled={!!busy} onClick={() => decide("reject")}>{busy === "reject" ? <Spinner /> : <Icon name="x" />} Dismiss</button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

const SUGGESTIONS = ["What needs my attention?", "Find where someone talks about pricing", "New project Spring Promo for Acme"];

/** Ask Cue: app-wide assistant. Replies can include proposed actions (never executed without approval). */
export function AskCuePanel({ compact = false }: { compact?: boolean }) {
  const { toast } = useShell();
  const [messages, setMessages] = useState<AskMessage[] | null>(null);
  const [actions, setActions] = useState<Record<string, CueAction>>({});
  const [mode, setMode] = useState<string>("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get<{ mode: string; messages: AskMessage[] }>("/cue/ask");
      setMode(r.mode);
      setMessages(r.messages);
      const ids = r.messages.flatMap((m) => m.action_ids);
      if (ids.length) {
        const all = await api.get<CueAction[]>("/cue/actions");
        setActions(Object.fromEntries(all.map((a) => [a.id, a])));
      }
    } catch { setMessages([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { thread.current?.scrollTo({ top: thread.current.scrollHeight }); }, [messages]);
  const send = async (msg: string, e?: FormEvent) => {
    e?.preventDefault();
    if (!msg.trim() || busy) return;
    setBusy(true); setFailed("");
    setMessages((m) => [...(m ?? []), { id: -Date.now(), role: "user", text: msg, created_at: Date.now() / 1000, action_ids: [] }]);
    setText("");
    try {
      const r = await api.post<{ actions: CueAction[] }>("/cue/ask", { message: msg });
      setActions((prev) => ({ ...prev, ...Object.fromEntries(r.actions.map((a) => [a.id, a])) }));
      await load();
    } catch (err) {
      setFailed(msg);
      toast(err instanceof ApiError ? err.message : "Couldn't reach Cue. Your message is kept so you can retry.", "error");
      await load();
    }
    setBusy(false);
  };
  const shown = (messages ?? []).slice(compact ? -6 : -50);
  return (
    <section aria-label="Ask Cue" className="card flex min-w-0 flex-col p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-accent to-violet text-on-accent"><Icon name="sparkle" size={16} /></span>
        <h2 className="font-semibold tracking-tight">Ask Cue</h2>
        {mode && <span className={`chip ml-auto ${mode === "claude" ? "text-ok" : "text-warn"}`} title={mode === "claude" ? "Claude is connected" : "No API key: a simple built-in planner answers"}>
          {mode === "claude" ? "Claude connected" : "Local mode"}</span>}
      </div>
      <div ref={thread} className={`scroll-thin space-y-3 overflow-y-auto ${compact ? "max-h-80" : "max-h-[60dvh]"}`} aria-live="polite" data-testid="ask-thread">
        {messages === null ? <Spinner /> : shown.length === 0 ? (
          <p className="text-sm text-muted">Ask about your projects, find a moment, or tell Cue what to do next. Anything that changes your work comes back as a proposal for you to approve.</p>
        ) : shown.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
            <div className={`max-w-[92%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm ${m.role === "user" ? "bg-accent-strong text-on-accent" : "bg-panel2"}`}>
              {m.text}
            </div>
            {m.action_ids.map((id) => actions[id] && (
              <div key={id} className="mt-2"><ActionCard a={actions[id]} onChange={(a) => setActions((p) => ({ ...p, [a.id]: a }))} /></div>
            ))}
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> Cue is thinking…</div>}
      </div>
      {!messages?.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => <button key={s} className="btn btn-sm min-h-9" onClick={() => send(s)}>{s}</button>)}
        </div>
      )}
      {failed && <button className="btn btn-sm mt-2 self-start" onClick={() => send(failed)}>Retry “{failed.slice(0, 40)}”</button>}
      <form className="mt-3 flex gap-2" onSubmit={(e) => send(text, e)}>
        <label className="sr-only" htmlFor="ask-input">Message Cue</label>
        <input id="ask-input" className="input min-h-11" placeholder="Ask Cue anything…" value={text} onChange={(e) => setText(e.target.value)} maxLength={8000} />
        <button className="btn btn-primary min-h-11 shrink-0" disabled={!text.trim() || busy} aria-label="Send"><Icon name="send" /></button>
      </form>
    </section>
  );
}

export function NewProjectDialog({ open, onClose, defaultClient = "" }: { open: boolean; onClose: () => void; defaultClient?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [client, setClient] = useState(defaultClient);
  const [clients, setClients] = useState<Client[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) api.get<Client[]>("/cue/clients").then(setClients).catch(() => {}); }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError("");
        try {
          const p = await api.post<ProjectCard>("/cue/projects", { name, client });
          router.push(`/project/?id=${p.id}&welcome=1`);
        } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); setBusy(false); }
      }}>
        <label className="block space-y-1.5">
          <span className="label">Project name</span>
          <input className="input min-h-11" placeholder="e.g. Market Mocha · Episode 12" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="block space-y-1.5">
          <span className="label">Client (optional)</span>
          <input className="input min-h-11" list="client-options" placeholder="Pick or type a client" value={client} onChange={(e) => setClient(e.target.value)} />
          <datalist id="client-options">{clients.map((c) => <option key={c.id} value={c.name} />)}</datalist>
        </label>
        <p className="text-sm text-muted">Next you&apos;ll add your recording and brief. Everything is processed on this computer.</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary min-h-11" disabled={!name.trim() || busy}>{busy ? <Spinner /> : <Icon name="plus" />} Create project</button>
        </div>
      </form>
    </Dialog>
  );
}

export function CopyField({ label, value }: { label: string; value: string }) {
  const { toast } = useShell();
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor={`copy-${label}`}>{label}</label>
      <input id={`copy-${label}`} readOnly value={value} className="input min-h-10 font-mono text-xs" onFocus={(e) => e.target.select()} />
      <button className="btn min-h-10 shrink-0" onClick={async () => {
        try { await navigator.clipboard.writeText(value); toast("Copied"); } catch { toast("Select the text and copy it manually", "info"); }
      }}><Icon name="copy" size={15} /> Copy</button>
    </div>
  );
}

export function EmptyProjects({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="card">
      <Empty icon="folder" title="No projects yet">
        <p>Create one, drop in your recording and brief, then ask Cue for an edit.</p>
        <button className="btn btn-primary mt-3 min-h-11" onClick={onCreate}><Icon name="plus" /> New project</button>
      </Empty>
    </div>
  );
}
