"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { Dialog, Empty, Icon, Logo, Spinner } from "@/components/ui";
import { Activity, api, ApiError, Health, Project, thumbUrl } from "@/lib/api";
import { timeAgo } from "@/lib/format";

const STEPS = [
  { icon: "upload", title: "Upload", text: "Drop in your recording and the client brief." },
  { icon: "chat", title: "Ask Cue", text: "Say what you want: “tighten it up”, “3 clips for Reels”." },
  { icon: "check", title: "Approve", text: "Preview the proposed edit, then approve or revise it." },
  { icon: "download", title: "Export", text: "One tap for YouTube, podcast, TikTok, Reels or LinkedIn." },
];

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError("");
        try {
          const p = await api.post<Project>("/projects", { name });
          router.push(`/project/?id=${p.id}&welcome=1`);
        } catch (err) { setError(err instanceof ApiError ? err.message : String(err)); setBusy(false); }
      }}>
        <label className="block space-y-1.5">
          <span className="label">Project name</span>
          <input className="input" placeholder="e.g. Market Mocha · Episode 12" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <p className="text-sm text-muted">Next you&apos;ll add your recording and brief. Cue analyzes them on this Mac: nothing is uploaded to the cloud.</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || busy}>{busy ? <Spinner /> : <Icon name="plus" />} Create project</button>
        </div>
      </form>
    </Dialog>
  );
}

function ProjectCard({ p, onDelete }: { p: Project; onDelete: () => void }) {
  return (
    <li className="group card relative overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:border-line2 hover:shadow-[0_20px_40px_-24px_#7262f2]">
      <Link href={`/project/?id=${p.id}`} className="block focus-visible:outline-offset-[-2px]">
        <div className="relative aspect-video bg-gradient-to-br from-[#1d1a35] via-panel2 to-[#241a33]">
          {p.thumb_asset_id
            ? <img src={thumbUrl(p.id, p.thumb_asset_id)} alt="" className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100" />
            : <div className="grid h-full place-items-center text-faint"><Icon name="film" size={30} /></div>}
          {!!p.active_jobs && (
            <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs backdrop-blur">
              <Spinner size={12} /> Processing
            </span>
          )}
        </div>
        <div className="space-y-1 p-4">
          <h3 className="truncate font-semibold tracking-tight">{p.name}</h3>
          <p className="text-xs text-muted">
            {p.last_activity ? `Active ${timeAgo(p.last_activity)}` : `Created ${timeAgo(p.created_at)}`}
            {" · "}{p.asset_count ?? 0} file{p.asset_count === 1 ? "" : "s"}
            {p.render_count ? ` · ${p.render_count} export${p.render_count === 1 ? "" : "s"}` : ""}
          </p>
        </div>
      </Link>
      <button className="btn btn-ghost btn-icon absolute right-2 top-2 bg-black/40 opacity-100 backdrop-blur sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
              aria-label={`Delete ${p.name}`} onClick={onDelete}><Icon name="trash" size={16} /></button>
    </li>
  );
}

function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [creating, setCreating] = useState(false);
  const load = () => {
    api.get<Health>("/health").then(setHealth).catch(() => setHealth(null));
    api.get<Project[]>("/projects").then(setProjects).catch(() => setProjects([]));
    api.get<Activity[]>("/activity?limit=8").then(setActivity).catch(() => {});
  };
  useEffect(load, []);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between gap-3 py-5">
        <Logo />
        <div className="flex items-center gap-2">
          {health && (
            <span className={`chip hidden sm:inline-flex ${health.assistant_mode === "claude" ? "text-ok" : "text-warn"}`}
                  title={health.assistant_mode === "claude" ? `Cue is using ${health.claude_model}` : "Add ANTHROPIC_API_KEY to .env to connect Claude"}>
              <span className={`h-1.5 w-1.5 rounded-full ${health.assistant_mode === "claude" ? "bg-ok" : "bg-warn"}`} />
              {health.assistant_mode === "claude" ? "Cue connected" : "Cue in test mode"}
            </span>
          )}
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New project</button>
        </div>
      </header>

      <main id="main" className="space-y-10">
        <section className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-[#1b1730] via-panel to-[#171427] p-6 sm:p-10">
          <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/20 blur-3xl" />
          <h1 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
            Edit by <span className="bg-gradient-to-r from-accent to-violet bg-clip-text text-transparent">telling Cue</span> what you want.
          </h1>
          <p className="mt-3 max-w-xl text-muted">Podcasts, interviews and client promos: Cue tightens the pauses, finds the moments worth sharing and checks everything against your brief.</p>
          <ol className="mt-6 grid gap-3 sm:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-2xl border border-line/80 bg-ink/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-soft text-violet"><Icon name={s.icon} size={15} /></span>{i + 1}. {s.title}</div>
                <p className="mt-2 text-xs leading-relaxed text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
          <button className="btn btn-primary mt-6 px-5 py-2.5 text-base" onClick={() => setCreating(true)}><Icon name="sparkle" /> Start a new edit</button>
        </section>

        <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
          <section aria-labelledby="projects-h">
            <h2 id="projects-h" className="label mb-3">Your projects</h2>
            {projects === null ? (
              <div className="grid gap-4 sm:grid-cols-2">{[0, 1].map((i) => <div key={i} className="skeleton h-48" />)}</div>
            ) : projects.length === 0 ? (
              <div className="card"><Empty icon="film" title="No projects yet">Create one to upload your first recording.</Empty></div>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {projects.map((p) => (
                  <ProjectCard key={p.id} p={p} onDelete={async () => {
                    if (!confirm(`Delete “${p.name}” and all its files and exports? This cannot be undone.`)) return;
                    await api.del(`/projects/${p.id}`); load();
                  }} />
                ))}
              </ul>
            )}
          </section>
          <aside aria-labelledby="activity-h">
            <h2 id="activity-h" className="label mb-3">Recent activity</h2>
            <div className="card p-2">
              {activity.length === 0 ? <p className="p-4 text-sm text-muted">Nothing yet.</p> : (
                <ul>
                  {activity.map((a, i) => (
                    <li key={i}>
                      <Link href={`/project/?id=${a.project_id}`} className="flex gap-3 rounded-xl p-2.5 hover:bg-panel2">
                        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-panel3 text-muted">
                          <Icon name={a.kind === "render" ? "download" : a.kind === "proposal" ? "sparkle" : "upload"} size={14} />
                        </span>
                        <span className="min-w-0 text-sm">
                          <span className="block truncate">
                            {a.kind === "render" ? `Export ${a.status === "succeeded" ? "ready" : a.status}` : a.kind === "proposal" ? `Cue proposed: ${a.detail}` : `Uploaded ${a.detail}`}
                          </span>
                          <span className="block truncate text-xs text-faint">{a.project_name} · {timeAgo(a.at)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      </main>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export default function Page() {
  return <AuthGate><Dashboard /></AuthGate>;
}
