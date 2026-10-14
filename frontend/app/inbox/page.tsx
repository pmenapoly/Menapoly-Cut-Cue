"use client";
// INBOX: approvals (Cue actions), reviews (proposals + client notes), notifications, texts, activity.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { ActionCard } from "@/components/cue";
import AppShell, { useShell } from "@/components/shell";
import { Empty, ErrorState, Icon, Loading, StatusPill, Tabs } from "@/components/ui";
import { Activity, api } from "@/lib/api";
import { CueAction, Home, Notification, TextStatus } from "@/lib/cue";
import { timeAgo } from "@/lib/format";

const TABS = [
  { id: "approvals", label: "Approvals" }, { id: "reviews", label: "Reviews" }, { id: "notifications", label: "Notifications" },
  { id: "messages", label: "Texts" }, { id: "activity", label: "Activity" },
] as const;

function Approvals() {
  const [actions, setActions] = useState<CueAction[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => api.get<CueAction[]>("/cue/actions").then(setActions).catch(() => setError(true)), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <ErrorState title="Couldn't load approvals" onRetry={load} />;
  if (!actions) return <Loading />;
  const pending = actions.filter((a) => a.status === "proposed");
  const past = actions.filter((a) => a.status !== "proposed").slice(0, 20);
  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-label="Waiting for approval">
        {pending.length === 0 ? <Empty icon="check" title="Nothing to approve">When Ask Cue or a text proposes something, it waits here until you decide.</Empty>
          : pending.map((a) => <ActionCard key={a.id} a={a} onChange={load} />)}
      </section>
      {past.length > 0 && <section className="space-y-3" aria-label="Decided"><h2 className="text-sm font-semibold text-muted">Recently decided</h2>
        {past.map((a) => <ActionCard key={a.id} a={a} />)}</section>}
    </div>
  );
}

function Reviews() {
  const [home, setHome] = useState<Home | null>(null);
  useEffect(() => { api.get<Home>("/cue/home").then(setHome).catch(() => {}); }, []);
  if (!home) return <Loading />;
  const items = home.review_queue.filter((q) => q.kind !== "action");
  if (!items.length) return <Empty icon="compare" title="No reviews waiting">Cue&apos;s proposed edits and client notes appear here.</Empty>;
  return (
    <ul className="space-y-2">
      {items.map((q) => (
        <li key={`${q.kind}-${q.id}`}>
          <Link href={q.href} className="flex min-h-14 items-center gap-3 rounded-xl border border-line bg-panel p-3 hover:border-line2">
            <StatusPill label={q.kind === "proposal" ? "Proposed edit" : "Client note"} tone={q.kind === "proposal" ? "accent" : "warn"} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{q.title}</span>
              <span className="block truncate text-xs text-muted">{q.project_name} · {timeAgo(q.at)}</span></span>
            <Icon name="chevron" size={16} className="text-faint" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Notifications() {
  const { refreshBadges } = useShell();
  const router = useRouter();
  const [items, setItems] = useState<Notification[] | null>(null);
  const load = useCallback(() => api.get<{ items: Notification[] }>("/cue/notifications?limit=100").then((r) => setItems(r.items)).catch(() => setItems([])), []);
  useEffect(() => { load(); }, [load]);
  if (!items) return <Loading />;
  if (!items.length) return <Empty icon="bell" title="No notifications yet">Finished renders, failures, client notes and texts appear here.</Empty>;
  return (
    <div className="space-y-3">
      <button className="btn btn-sm min-h-9" onClick={async () => { await api.post("/cue/notifications/read"); refreshBadges(); load(); }}>Mark all read</button>
      <ul className="card divide-y divide-line/60 p-1">
        {items.map((n) => (
          <li key={n.id}>
            <button className="flex w-full gap-3 p-3 text-left hover:bg-panel2" onClick={async () => {
              if (!n.read_at) await api.post(`/cue/notifications/${n.id}/read`).catch(() => {});
              refreshBadges();
              if (n.href) router.push(n.href); else load();
            }}>
              <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "" : "bg-accent"}`} />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm ${n.read_at ? "text-muted" : "font-medium"}`}>{n.title}</span>
                {n.body && <span className="block text-xs text-muted">{n.body}</span>}
                <span className="block text-xs text-faint">{timeAgo(n.created_at)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TEXT_STATUS: Record<string, string> = {
  rejected_unknown_sender: "Not an approved number — ignored", action_proposed: "Waiting for your approval", status_request: "Asked for status",
  media_received: "Photos/videos received", note: "Saved as a note", help: "Asked for help", opt_out: "Opted out (STOP)", opt_in: "Opted back in",
  ignored_opted_out: "Ignored (opted out)", needs_project: "Needs a project", error: "Couldn't process", draft_not_sent: "Draft reply — not sent",
};

function Messages() {
  const { toast } = useShell();
  const [data, setData] = useState<TextStatus | null>(null);
  const load = useCallback(() => api.get<TextStatus>("/cue/text").then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Loading />;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-panel p-3 text-sm">
        <p><strong>Cue Text</strong> {data.inbound_ready ? `is receiving texts at ${data.number}.` : "isn't connected to a phone number yet."} {data.sending_note}</p>
        <Link href="/settings/#cue-text" className="mt-1 inline-block text-violet underline">Set up Cue Text and approved senders</Link>
      </div>
      {data.messages.length === 0 ? <Empty icon="phone" title="No texts yet">Inbound texts and Cue&apos;s draft replies are kept here as a complete history.</Empty> : (
        <ul className="space-y-2" aria-label="Text messages">
          {data.messages.map((m) => (
            <li key={m.id} className={`rounded-xl border p-3 text-sm ${m.direction === "out" ? "ml-6 border-dashed border-line2" : "mr-6 border-line bg-panel"}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-semibold text-text">{m.direction === "in" ? (m.sender_name ?? m.from_number) : `Cue → ${m.to_number}`}</span>
                <StatusPill label={TEXT_STATUS[m.status] ?? m.status} tone={m.status === "error" || m.status.startsWith("rejected") ? "danger" : m.direction === "out" ? "muted" : "info"} />
                {m.provider === "simulator" && <span className="chip">Simulated</span>}
                <span>{timeAgo(m.created_at)}</span>
              </div>
              {m.body && <p className="mt-1 whitespace-pre-wrap">{m.body}</p>}
              {m.media.length > 0 && <p className="mt-1 text-xs text-muted">{m.media.length} attachment(s): {m.media.map((x) => x.content_type || "file").join(", ")}</p>}
              {m.detail && <p className="mt-1 text-xs text-muted">{m.detail}</p>}
              {m.status === "error" && <button className="btn btn-sm mt-2" onClick={async () => { await api.post(`/cue/text/messages/${m.id}/retry`).catch((e) => toast(String(e), "error")); load(); }}>Retry</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityTab() {
  const [items, setItems] = useState<Activity[] | null>(null);
  useEffect(() => { api.get<Activity[]>("/activity?limit=50").then(setItems).catch(() => setItems([])); }, []);
  if (!items) return <Loading />;
  if (!items.length) return <Empty icon="history" title="No activity yet" />;
  return (
    <ul className="card divide-y divide-line/60 p-1">
      {items.map((a, i) => (
        <li key={i}><Link href={`/projects/?id=${a.project_id}`} className="flex gap-3 p-3 hover:bg-panel2">
          <Icon name={a.kind === "render" ? "download" : a.kind === "proposal" ? "sparkle" : "upload"} size={16} className="mt-0.5 text-muted" />
          <span className="min-w-0 text-sm"><span className="block truncate">
            {a.kind === "render" ? `Render ${a.status === "succeeded" ? "finished" : a.status}` : a.kind === "proposal" ? `Cue proposed: ${a.detail} (${a.status})` : `Uploaded ${a.detail}`}</span>
            <span className="block text-xs text-faint">{a.project_name} · {timeAgo(a.at)}</span></span>
        </Link></li>
      ))}
    </ul>
  );
}

function Route() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "approvals") as (typeof TABS)[number]["id"];
  const { pending, unread } = useShell();
  return (
    <div className="space-y-4">
      <Tabs label="Inbox sections" value={tab} onChange={(t) => router.replace(`/inbox/?tab=${t}`, { scroll: false })}
            tabs={TABS.map((t) => ({ ...t, badge: t.id === "approvals" ? pending : t.id === "notifications" ? unread : 0 }))} />
      <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "approvals" && <Approvals />}{tab === "reviews" && <Reviews />}{tab === "notifications" && <Notifications />}
        {tab === "messages" && <Messages />}{tab === "activity" && <ActivityTab />}
      </div>
    </div>
  );
}

export default function Page() {
  return <AppShell title="Inbox"><Suspense fallback={null}><Route /></Suspense></AppShell>;
}

