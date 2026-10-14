"use client";
// PROJECTS: card / board / list views with search and filters; ?id= opens project details.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { EmptyProjects, NewProjectDialog, ProjectCardView, ProjectRow } from "@/components/cue";
import ProjectDetails from "@/components/ProjectDetails";
import AppShell from "@/components/shell";
import { ErrorState, Icon, Loading, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { Client, ProjectCard, STAGES } from "@/lib/cue";

type View = "cards" | "board" | "list";

function ProjectsList() {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [stage, setStage] = useState("");
  const [archived, setArchived] = useState(false);
  const [view, setView] = useState<View>("cards");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("cue-projects-view") as View | null;
      setView(saved ?? (window.innerWidth < 640 ? "list" : "cards"));
    } catch { /* storage blocked */ }
    api.get<Client[]>("/cue/clients").then(setClients).catch(() => {});
  }, []);
  const load = useCallback(() => {
    const params = new URLSearchParams({ q, client_id: client, stage, archived: String(archived) });
    api.get<ProjectCard[]>(`/cue/projects?${params}`).then((p) => { setProjects(p); setError(false); }).catch(() => setError(true));
  }, [q, client, stage, archived]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);
  const changeView = (v: View) => { setView(v); try { localStorage.setItem("cue-projects-view", v); } catch { /* ignore */ } };
  const filtered = !!(q || client || stage || archived);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56">
          <span className="sr-only">Search projects</span>
          <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input min-h-11 pl-9" placeholder="Search projects or clients" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn btn-primary min-h-11" onClick={() => setCreating(true)}><Icon name="plus" /> New project</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-0"><span className="sr-only">Client</span>
          <select aria-label="Client" className="input min-h-10 w-auto max-w-[11rem]" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="min-w-0"><span className="sr-only">Stage</span>
          <select aria-label="Stage" className="input min-h-10 w-auto max-w-[11rem]" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">Any stage</option>
            {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
        </label>
        <div className="ml-auto">
          <Segmented label="View" value={view} onChange={changeView}
                     options={[{ id: "cards", label: "Cards" }, { id: "board", label: "Board" }, { id: "list", label: "List" }]} />
        </div>
      </div>

      {error ? <ErrorState title="Couldn't load projects" onRetry={load}>Check that Cue is running.</ErrorState>
        : projects === null ? <Loading label="Loading projects" />
        : projects.length === 0 ? (filtered ? <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">No projects match these filters.</p>
          : <EmptyProjects onCreate={() => setCreating(true)} />)
        : view === "cards" ? <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Projects">{projects.map((p) => <ProjectCardView key={p.id} p={p} />)}</ul>
        : view === "list" ? <ul className="card divide-y divide-line/60 p-1" aria-label="Projects">{projects.map((p) => <ProjectRow key={p.id} p={p} />)}</ul>
        : (
          <div className="scroll-thin -mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" role="region" aria-label="Projects by stage" tabIndex={0}>
            <div className="flex gap-3">
              {STAGES.map((s) => {
                const col = projects.filter((p) => p.stage === s.id);
                return (
                  <section key={s.id} aria-label={s.label} className="w-64 shrink-0 rounded-2xl border border-line bg-panel/60 p-2">
                    <h3 className="flex items-center justify-between px-2 py-1.5 text-sm font-semibold">{s.label}<span className="text-xs font-normal text-muted">{col.length}</span></h3>
                    <ul className="space-y-1">{col.map((p) => <ProjectRow key={p.id} p={p} />)}</ul>
                    {!col.length && <p className="px-2 py-3 text-xs text-faint">None</p>}
                  </section>
                );
              })}
            </div>
          </div>
        )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function Route() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id");
  return (
    <AppShell title={id ? "Project" : "Projects"}>
      {id ? <ProjectDetails pid={id} tab={params.get("tab") ?? "overview"}
                            onTab={(t) => router.replace(`/projects/?id=${id}&tab=${t}`, { scroll: false })} /> : <ProjectsList />}
    </AppShell>
  );
}

export default function Page() {
  return <Suspense fallback={null}><Route /></Suspense>;
}
