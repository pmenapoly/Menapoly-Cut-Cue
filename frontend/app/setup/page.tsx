"use client";
// FIRST-RUN SETUP: six short steps with live status; ends by creating the first real project.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConnectionRow, useConnections } from "@/components/connections";
import AppShell, { useShell } from "@/components/shell";
import { ErrorState, Icon, Loading, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { ProjectCard } from "@/lib/cue";

const STEPS = [
  { id: "computer", title: "This computer", keys: ["ffmpeg", "transcription"],
    text: "Menapoly Cue edits on this Mac. It needs FFmpeg and the speech model." },
  { id: "ai", title: "AI editing", keys: ["claude"],
    text: "Optional. With a Claude API key, Cue holds real conversations. Without it, a simple built-in planner still makes edits." },
  { id: "private", title: "Keep it private", keys: ["password", "sharing"],
    text: "If anyone other than you can reach this computer, set a password. Client review links never need it." },
  { id: "notify", title: "Notifications", keys: ["email"],
    text: "Optional. Get an email when renders finish, clients reply, or something fails. Everything also appears in the bell." },
  { id: "backup", title: "Backups", keys: ["backups"],
    text: "Make a first backup now. Your projects, edits and reviews are saved with checksums." },
  { id: "project", title: "First project", keys: [],
    text: "Name your first project. You'll drop in the recording and brief next." },
] as const;

function Setup() {
  const router = useRouter();
  const { toast } = useShell();
  const { data, error, load } = useConnections();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  if (error) return <ErrorState title="Can't reach Cue" onRetry={load}>Start it with <code className="kbd">make start</code>.</ErrorState>;
  if (!data) return <Loading label="Checking this computer" rows={3} />;
  const s = STEPS[step];
  const items = data.items.filter((i) => (s.keys as readonly string[]).includes(i.key));
  const blocked = items.some((i) => i.required && i.status !== "ready");
  const finish = async (dismissed = false) => { await api.post("/cue/setup", dismissed ? { dismissed: true } : { completed: true }).catch(() => {}); };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <ol className="flex flex-wrap gap-1 text-xs" aria-label="Setup steps">
        {STEPS.map((x, i) => (
          <li key={x.id} aria-current={i === step ? "step" : undefined}
              className={`rounded-full px-2.5 py-1 ${i === step ? "bg-accent-soft font-semibold text-violet" : i < step ? "text-ok" : "text-faint"}`}>
            {i < step ? "✓ " : `${i + 1}. `}{x.title}
          </li>
        ))}
      </ol>
      <section className="card space-y-4 p-5" aria-labelledby="setup-step-h">
        <div>
          <p className="text-xs text-muted">Step {step + 1} of {STEPS.length}</p>
          <h2 id="setup-step-h" className="text-xl font-semibold tracking-tight">{s.title}</h2>
          <p className="mt-1 text-sm text-muted">{s.text}</p>
        </div>
        {items.length > 0 && <ul className="space-y-2">{items.map((i) => <ConnectionRow key={i.key} item={i} onChanged={load} />)}</ul>}
        {s.id === "backup" && (
          <button className="btn min-h-11" disabled={busy} onClick={async () => {
            setBusy(true);
            try { const r = await api.post<{ name: string; ok: boolean }>("/cue/backups"); toast(r.ok ? `Backed up: ${r.name}` : "Backup failed verification", r.ok ? "ok" : "error"); }
            catch (e) { toast(e instanceof ApiError ? e.message : "Backup failed", "error"); }
            setBusy(false); load();
          }}>{busy ? <Spinner /> : <Icon name="archive" />} Back up now</button>
        )}
        {s.id === "project" && (
          <form className="space-y-3" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const p = await api.post<ProjectCard>("/cue/projects", { name, client });
              await finish();
              router.push(`/project/?id=${p.id}&welcome=1`);
            } catch (err) { toast(err instanceof ApiError ? err.message : "Couldn't create the project", "error"); setBusy(false); }
          }}>
            <label className="block space-y-1"><span className="label">Project name</span>
              <input className="input min-h-11" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Market Mocha · Episode 12" /></label>
            <label className="block space-y-1"><span className="label">Client (optional)</span>
              <input className="input min-h-11" value={client} onChange={(e) => setClient(e.target.value)} /></label>
            <button className="btn btn-primary min-h-11" disabled={!name.trim() || busy || !data.ready_for_projects}>
              {busy ? <Spinner /> : <Icon name="plus" />} Create project and add media</button>
            {!data.ready_for_projects && <p role="alert" className="text-sm text-danger">Fix the required items first: {data.blocking.join(", ")}.</p>}
          </form>
        )}
        {blocked && <p role="alert" className="text-sm text-warn">This step is required. Follow the instruction above, restart Menapoly Cue if needed, then press Check again.</p>}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {step > 0 && <button className="btn min-h-11" onClick={() => setStep(step - 1)}>Back</button>}
          <button className="btn btn-ghost min-h-11" onClick={load}>Check again</button>
          <span className="flex-1" />
          {step < STEPS.length - 1 && (
            <button className="btn btn-primary min-h-11" onClick={() => setStep(step + 1)}>
              {blocked ? "Continue anyway" : items.length && items.every((i) => i.status !== "ready") ? "Skip for now" : "Next"} <Icon name="chevron" size={16} />
            </button>
          )}
        </div>
      </section>
      <p className="text-center text-sm text-muted">
        <button className="underline" onClick={async () => { await finish(true); router.push("/"); }}>Skip setup</button> ·
        {" "}<Link className="underline" href="/connections/">See all connections</Link>
      </p>
    </div>
  );
}

export default function Page() {
  return <AppShell title="Set up Menapoly Cue"><Setup /></AppShell>;
}
