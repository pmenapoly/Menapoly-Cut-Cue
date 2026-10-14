"use client";
// Connection status rows, shared by /connections and the first-run /setup flow. Data: GET /api/cue/connections.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useShell } from "./shell";
import { Icon, Spinner, StatusPill } from "./ui";

export type ConnStatus = "ready" | "not_configured" | "unavailable" | "awaiting_authorization" | "disabled";
export type ConnItem = { key: string; name: string; status: ConnStatus; status_label: string; detail: string; fix: string;
  required: boolean; group: string; can_test: boolean };
export type Connections = { items: ConnItem[]; ready_for_projects: boolean; blocking: string[];
  setup: { completed?: boolean; dismissed?: boolean }; has_projects: boolean };

export const TONE: Record<ConnStatus, "ok" | "muted" | "danger" | "warn" | "info"> = {
  ready: "ok", not_configured: "muted", unavailable: "danger", awaiting_authorization: "warn", disabled: "info",
};

export function useConnections() {
  const [data, setData] = useState<Connections | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => api.get<Connections>("/cue/connections").then((d) => { setData(d); setError(false); })
    .catch(() => setError(true)), []);
  useEffect(() => { load(); }, [load]);
  return { data, error, load };
}

export function ConnectionRow({ item, onChanged }: { item: ConnItem; onChanged: () => void }) {
  const { toast } = useShell();
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true);
    try {
      if (item.key === "relay") {
        const r = await api.post<{ ok: boolean; error?: string }>("/cue/connections/relay/test");
        toast(r.ok ? "Client portal reached." : `Not yet: ${r.error}`, r.ok ? "ok" : "error");
      } else if (item.key === "email") {
        const r = await api.post<{ status: string; error: string | null }>("/cue/email/test");
        toast(r.status === "sent" ? "Test email sent. Check your inbox." : `Not sent: ${r.error ?? r.status}`, r.status === "sent" ? "ok" : "error");
      }
    } catch (e) { toast(e instanceof ApiError ? e.message : "Test failed", "error"); }
    setBusy(false); onChanged();
  };
  return (
    <li className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-panel p-3" data-testid={`conn-${item.key}`}>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item.name}</span>
          {item.required && <span className="chip">Required</span>}
        </span>
        <span className="mt-0.5 block text-sm text-muted">{item.detail}</span>
        {item.fix && item.status !== "ready" && <span className="mt-1 block text-sm"><Icon name="info" size={13} className="mr-1 inline" />{item.fix}</span>}
      </span>
      <span className="flex items-center gap-2">
        <StatusPill label={item.status_label} tone={TONE[item.status]} />
        {item.can_test && <button className="btn btn-sm min-h-9" disabled={busy} onClick={test}>{busy ? <Spinner size={12} /> : "Test"}</button>}
      </span>
    </li>
  );
}

export function ConnectionList({ items, onChanged }: { items: ConnItem[]; onChanged: () => void }) {
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g} aria-label={g}>
          <h2 className="mb-2 text-sm font-semibold text-muted">{g}</h2>
          <ul className="space-y-2">{items.filter((i) => i.group === g).map((i) => <ConnectionRow key={i.key} item={i} onChanged={onChanged} />)}</ul>
        </section>
      ))}
    </div>
  );
}
