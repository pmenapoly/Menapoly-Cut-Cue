"use client";
// CONNECTIONS: which integrations are ready, not set up, unavailable, or awaiting authorization.
import Link from "next/link";
import { ConnectionList, useConnections } from "@/components/connections";
import AppShell from "@/components/shell";
import { ErrorState, Loading, StatusPill } from "@/components/ui";

function ConnectionsPage() {
  const { data, error, load } = useConnections();
  if (error) return <ErrorState title="Couldn't check connections" onRetry={load}>Check that Cue is running.</ErrorState>;
  if (!data) return <Loading label="Checking connections" rows={5} />;
  const counts = data.items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});
  return (
    <div className="max-w-3xl space-y-6">
      <div className="card space-y-2 p-4">
        <p className="font-medium">{data.ready_for_projects ? "Ready for projects." : "Something required needs attention before real client work."}</p>
        <div className="flex flex-wrap gap-2" aria-label="Summary">
          <StatusPill label={`${counts.ready ?? 0} ready`} tone="ok" />
          <StatusPill label={`${counts.not_configured ?? 0} not set up`} tone="muted" />
          <StatusPill label={`${counts.awaiting_authorization ?? 0} awaiting authorization`} tone="warn" />
          <StatusPill label={`${counts.unavailable ?? 0} unavailable`} tone="danger" />
        </div>
        <p className="text-xs text-muted">
          Ready = checked and working · Not set up = optional, not configured · Awaiting authorization = configured or built, waiting on an
          account, approval or compliance step · Unavailable = configured but failing. Secret values are never shown here.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm min-h-9" onClick={load}>Check again</button>
          <Link className="btn btn-sm min-h-9" href="/setup/">First-run setup</Link>
        </div>
      </div>
      <ConnectionList items={data.items} onChanged={load} />
    </div>
  );
}

export default function Page() {
  return <AppShell title="Connections"><ConnectionsPage /></AppShell>;
}
