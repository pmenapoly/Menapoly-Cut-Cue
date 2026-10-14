"use client";
// HOME: Ask Cue, priority actions, recent projects, review queue and processing activity (all real data).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AskCuePanel, EmptyProjects, NewProjectDialog, ProcessingList, ProjectCardView } from "@/components/cue";
import AppShell, { Section } from "@/components/shell";
import { ErrorState, Icon, Loading } from "@/components/ui";
import { api } from "@/lib/api";
import { Home as HomeData } from "@/lib/cue";
import { timeAgo } from "@/lib/format";

const TONE_DOT: Record<string, string> = { danger: "bg-danger", warn: "bg-warn", accent: "bg-accent", ok: "bg-ok", info: "bg-text", muted: "bg-faint" };

function HomePage() {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.get<HomeData>("/cue/home").then((d) => { setData(d); setError(false); }).catch(() => setError(true)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, data?.processing.length ? 4000 : 15000);
    return () => clearInterval(t);
  }, [load, data?.processing.length]);

  if (error && !data) return <ErrorState title="Can't reach Cue" onRetry={load}>The Cut Cue engine isn&apos;t answering. Start it with <code className="kbd">make start</code> and try again.</ErrorState>;
  if (!data) return <Loading label="Loading home" rows={4} />;
  const hour = new Date().getHours();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}</p>
          <p className="text-2xl font-semibold tracking-tight sm:text-3xl">What should we make today?</p>
        </div>
        <button className="btn btn-primary min-h-11" onClick={() => setCreating(true)}><Icon name="plus" /> New project</button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <Section title="Next up">
            {data.priority_actions.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">Nothing needs you right now.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2" data-testid="priority-actions">
                {data.priority_actions.map((a, i) => (
                  <li key={i}>
                    <Link href={a.href} className="flex min-h-14 items-center gap-3 rounded-xl border border-line bg-panel p-3 hover:border-line2">
                      <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[a.tone]}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{a.text}</span>
                        {a.project_name && <span className="block truncate text-xs text-muted">{a.project_name}</span>}
                      </span>
                      <Icon name="chevron" size={16} className="text-faint" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <AskCuePanel compact />
          <Section title="Recent projects" action={<Link href="/projects/" className="text-sm text-violet hover:underline">All projects</Link>}>
            {data.recent_projects.length === 0 ? <EmptyProjects onCreate={() => setCreating(true)} /> : (
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{data.recent_projects.map((p) => <ProjectCardView key={p.id} p={p} />)}</ul>
            )}
          </Section>
        </div>
        <aside className="min-w-0 space-y-6">
          <Section title="Waiting for review" action={<Link href="/inbox/" className="text-sm text-violet hover:underline">Inbox</Link>}>
            {data.review_queue.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">No reviews waiting.</p> : (
              <ul className="space-y-2" data-testid="review-queue">
                {data.review_queue.map((q) => (
                  <li key={`${q.kind}-${q.id}`}>
                    <Link href={q.href} className="block rounded-xl border border-line bg-panel p-3 hover:border-line2">
                      <span className="text-xs font-semibold text-violet">{q.kind === "proposal" ? "Proposed edit" : q.kind === "action" ? "Needs approval" : "Client note"}</span>
                      <span className="block truncate text-sm">{q.title}</span>
                      <span className="block truncate text-xs text-faint">{q.project_name ?? "—"} · {timeAgo(q.at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Processing"><ProcessingList jobs={data.processing} /></Section>
        </aside>
      </div>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export default function Page() {
  return <AppShell title="Home"><HomePage /></AppShell>;
}
