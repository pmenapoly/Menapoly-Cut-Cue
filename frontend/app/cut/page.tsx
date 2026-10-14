"use client";
// CUT CUE: pick a project to edit in Cue Simple (all screens) or Cue Pro (tablet/desktop timeline).
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyProjects, NewProjectDialog, ProjectThumb } from "@/components/cue";
import AppShell, { Section } from "@/components/shell";
import { ErrorState, Icon, Loading, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { ProjectCard } from "@/lib/cue";
import { timeAgo } from "@/lib/format";

function CutCue() {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const load = () => api.get<ProjectCard[]>("/cue/projects").then(setProjects).catch(() => setError(true));
  useEffect(() => { load(); }, []);
  if (error) return <ErrorState title="Couldn't load projects" onRetry={load} />;
  if (!projects) return <Loading label="Loading" />;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="card p-4">
          <h2 className="flex items-center gap-2 font-semibold"><Icon name="chat" className="text-violet" /> Cue Simple</h2>
          <p className="mt-1 text-sm text-muted">Tell Cue what you want, preview the proposal, approve, export. Works on any screen.</p>
        </div>
        <div className="card p-4">
          <h2 className="flex items-center gap-2 font-semibold"><Icon name="layers" className="text-violet" /> Cue Pro</h2>
          <p className="mt-1 text-sm text-muted">Multitrack timeline, transcript editing, audio and captions. Same project, same versions. Tablet or computer.</p>
        </div>
      </div>
      <Section title="Continue editing">
        {projects.length === 0 ? <EmptyProjects onCreate={() => setCreating(true)} /> : (
          <ul className="space-y-2" aria-label="Projects to edit">
            {projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel p-3">
                <ProjectThumb p={p} className="h-12 w-20 shrink-0 rounded-lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block truncate text-xs text-muted">{p.client_name ?? "No client"} · {p.version_count} version{p.version_count === 1 ? "" : "s"} · {timeAgo(p.last_activity)}</span>
                </span>
                <StatusPill label={p.status.label} tone={p.status.tone} busy={p.status.key === "processing"} />
                <span className="flex gap-2">
                  <Link className="btn btn-primary min-h-11" href={`/project/?id=${p.id}&mode=simple`} aria-label={`Edit ${p.name} in Cue Simple`}>Simple</Link>
                  <Link className="btn hidden min-h-11 md:inline-flex" href={`/project/?id=${p.id}&mode=pro`} aria-label={`Edit ${p.name} in Cue Pro`}>Pro</Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export default function Page() {
  return <AppShell title="Cut Cue"><CutCue /></AppShell>;
}
