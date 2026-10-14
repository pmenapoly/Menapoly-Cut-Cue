"use client";
// SETTINGS: appearance, Ask Cue, system status, Cue Text (approved senders, simulator), component gallery.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AppShell, { applyTheme, readTheme, Section, ThemePref, useShell } from "@/components/shell";
import { Icon, Loading, Segmented, StatusPill } from "@/components/ui";
import { api, ApiError, Health } from "@/lib/api";
import { Meta, TextStatus } from "@/lib/cue";
import { timeAgo } from "@/lib/format";

function CueTextSettings() {
  const { toast } = useShell();
  const [data, setData] = useState<TextStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [simFrom, setSimFrom] = useState("");
  const [simBody, setSimBody] = useState("");
  const [simResult, setSimResult] = useState("");
  const load = useCallback(() => api.get<TextStatus>("/cue/text").then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Loading rows={2} />;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={data.inbound_ready ? `Receiving at ${data.number}` : "Not connected"} tone={data.inbound_ready ? "ok" : "muted"} />
          <StatusPill label="Sending off" tone="warn" />
        </div>
        <p className="mt-2 text-muted">{data.sending_note}</p>
        {!data.inbound_ready && (
          <p className="mt-2 text-muted">To receive real texts you need an SMS provider number and its webhook secret in <code className="kbd">.env</code>
            (<code className="kbd">CUE_TEXT_PROVIDER</code>, <code className="kbd">CUE_TEXT_NUMBER</code>, <code className="kbd">CUE_TEXT_AUTH_TOKEN</code>,
            <code className="kbd">CUE_TEXT_WEBHOOK_URL</code>) and a public HTTPS address for this computer. See docs/cue2/cue-text.md.</p>
        )}
      </div>

      <div className="card space-y-3 p-4">
        <h3 className="font-semibold">Approved senders</h3>
        <p className="text-sm text-muted">Only these numbers can start work by text. Texts from anyone else are stored and ignored.</p>
        <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={async (e) => {
          e.preventDefault();
          try { await api.post("/cue/text/senders", { phone, name, consent }); setPhone(""); setName(""); setConsent(false); toast("Sender approved"); load(); }
          catch (err) { toast(err instanceof ApiError ? err.message : "Couldn't add", "error"); }
        }}>
          <label><span className="sr-only">Phone number</span><input className="input min-h-11" inputMode="tel" placeholder="+1 555 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label><span className="sr-only">Name</span><input className="input min-h-11" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="btn btn-primary min-h-11" disabled={!phone || !name || !consent}>Add</button>
          <label className="flex items-start gap-2 text-sm sm:col-span-3">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            This person agreed to text with Menapoly Cue and knows they can reply STOP at any time.
          </label>
        </form>
        {data.senders.length > 0 && (
          <ul className="divide-y divide-line/60" aria-label="Approved senders">
            {data.senders.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1"><span className="font-medium">{s.name}</span> <span className="text-muted">{s.phone}</span>
                  <span className="block text-xs text-faint">Consent recorded {timeAgo(s.consent_at)}</span></span>
                {s.opted_out_at && <StatusPill label="Opted out" tone="warn" />}
                <button className="btn btn-ghost btn-sm" aria-label={`Remove ${s.name}`} onClick={async () => { await api.del(`/cue/text/senders/${s.id}`); load(); }}><Icon name="trash" size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card space-y-3 border-dashed p-4">
        <h3 className="font-semibold">Test console (simulated texts)</h3>
        <p className="text-sm text-muted">Runs the real intake steps (sender check, STOP handling, intent) without a phone provider. Nothing is sent. Simulated texts are labelled in the history.</p>
        <form className="space-y-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api.post<{ status: string; detail: string }>("/cue/text/simulate", { from_number: simFrom, body: simBody });
            setSimResult(`${r.status.replace(/_/g, " ")} — ${r.detail}`); setSimBody(""); load();
          } catch (err) { setSimResult(err instanceof ApiError ? err.message : "Failed"); }
        }}>
          <div className="grid gap-2 sm:grid-cols-[200px_1fr_auto]">
            <label><span className="sr-only">From number</span><input className="input min-h-11" inputMode="tel" placeholder="From +1…" value={simFrom} onChange={(e) => setSimFrom(e.target.value)} /></label>
            <label><span className="sr-only">Text</span><input className="input min-h-11" placeholder="new project Spring Promo · status · changes: shorter intro" value={simBody} onChange={(e) => setSimBody(e.target.value)} /></label>
            <button className="btn min-h-11" disabled={!simFrom}>Simulate</button>
          </div>
        </form>
        {simResult && <p role="status" className="text-sm">{simResult}</p>}
        <Link href="/inbox/?tab=messages" className="text-sm text-violet underline">See text history</Link>
      </div>
    </div>
  );
}

type EmailStatus = { configured: boolean; to: string | null; from: string | null; host: string | null; kinds: string[];
  counts: Record<string, number>; recent: { id: string; subject: string; status: string; error: string | null; created_at: number }[] };
type Backups = { folder: string; backups: { name: string; ok: boolean; include_media?: boolean; files?: number; projects?: number }[] };
type Relay = { configured: boolean; problem: string | null; url: string | null; workspace_id: string | null; auth: string | null };

const KIND_LABEL: Record<string, string> = {
  render_done: "Renders finished", job_failed: "Something failed", review_changes_requested: "Client requested changes",
  review_approved: "Client approved", review_comment: "Client notes", review_requested: "Cue proposed an edit",
  stage_changed: "Project status changed", relay_published: "Published to portal", relay_failed: "Portal publish failed",
};

function EmailSettings() {
  const { toast } = useShell();
  const [s, setS] = useState<EmailStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get<EmailStatus>("/cue/email").then(setS).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (!s) return <Loading rows={1} />;
  return (
    <div className="card space-y-3 p-4 text-sm">
      <p><StatusPill label={s.configured ? `Emails go to ${s.to}` : "Email is off"} tone={s.configured ? "ok" : "muted"} /></p>
      {s.configured ? (
        <>
          <p className="text-muted">Sent for: {s.kinds.map((k) => KIND_LABEL[k] ?? k).join(", ")}. Every notification also appears in the bell.</p>
          <button className="btn min-h-11" disabled={busy} onClick={async () => {
            setBusy(true);
            try { const r = await api.post<{ status: string; error: string | null }>("/cue/email/test");
              toast(r.status === "sent" ? "Test email sent. Check your inbox." : `Not sent yet: ${r.error ?? r.status}`, r.status === "sent" ? "ok" : "error"); }
            catch (e) { toast(e instanceof ApiError ? e.message : "Failed", "error"); }
            setBusy(false); load();
          }}>Send a test email</button>
          {s.recent.length > 0 && <ul className="space-y-1" aria-label="Recent emails">{s.recent.map((m) => (
            <li key={m.id} className="flex flex-wrap gap-2"><StatusPill label={m.status} tone={m.status === "sent" ? "ok" : m.status === "failed" ? "danger" : "info"} />
              <span className="min-w-0 truncate">{m.subject}</span>{m.error && <span className="w-full text-xs text-danger">{m.error}</span>}</li>))}</ul>}
        </>
      ) : <p className="text-muted">Add <code className="kbd">CUE_SMTP_HOST</code>, <code className="kbd">CUE_EMAIL_FROM</code> and <code className="kbd">CUE_EMAIL_TO</code> (plus login details) to <code className="kbd">.env</code> and restart. See docs/cue2/setup.md.</p>}
    </div>
  );
}

function PortalAndBackups() {
  const { toast } = useShell();
  const [relay, setRelay] = useState<Relay | null>(null);
  const [backups, setBackups] = useState<Backups | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.get<Relay>("/cue/relay").then(setRelay).catch(() => {});
    api.get<Backups>("/cue/backups").then(setBackups).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-6">
      <Section title="Client portal (Menapoly Cue on Cloudflare)">
        <div className="card space-y-1 p-4 text-sm">
          {relay ? <>
            <p><StatusPill label={relay.configured ? `Connected to ${relay.url}` : "Not connected"} tone={relay.configured ? "ok" : "muted"} /></p>
            <p className="text-muted">{relay.configured ? "Publish a finished render from a project's Delivery tab. Each publish needs your approval." : relay.problem}</p>
          </> : <Loading rows={1} />}
        </div>
      </Section>
      <Section title="Backups">
        <div className="card space-y-3 p-4 text-sm">
          <p className="text-muted">“Back up now” saves the database (projects, edits, reviews, settings). For everything including media, run <code className="kbd">make backup</code>. Restoring is done from the terminal with the app stopped (<code className="kbd">make restore BACKUP=…</code>).</p>
          <button className="btn min-h-11" disabled={busy} onClick={async () => {
            setBusy(true);
            try { const r = await api.post<{ name: string; ok: boolean }>("/cue/backups"); toast(r.ok ? `Backed up: ${r.name}` : "Backup failed verification", r.ok ? "ok" : "error"); }
            catch (e) { toast(e instanceof ApiError ? e.message : "Backup failed", "error"); }
            setBusy(false); load();
          }}>Back up now</button>
          {backups && backups.backups.length > 0 && (
            <ul className="space-y-1" aria-label="Backups">{backups.backups.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center gap-2"><StatusPill label={b.ok ? "Verified" : "Damaged"} tone={b.ok ? "ok" : "danger"} />
                <span className="font-mono text-xs">{b.name}</span><span className="text-xs text-muted">{b.include_media ? "with media" : "database only"} · {b.projects ?? "?"} projects</span></li>))}</ul>
          )}
          {backups && <p className="text-xs text-faint">Folder: {backups.folder}</p>}
        </div>
      </Section>
    </div>
  );
}

function SettingsPage() {
  const [theme, setTheme] = useState<ThemePref>("system");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    setTheme(readTheme());
    api.get<Meta>("/cue/meta").then(setMeta).catch(() => {});
    api.get<Health>("/health").then(setHealth).catch(() => {});
  }, []);
  return (
    <div className="max-w-3xl space-y-8">
      <Section title="Appearance">
        <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
          <span className="text-sm">Theme</span>
          <Segmented label="Theme" value={theme} onChange={(t) => { setTheme(t); applyTheme(t); }}
                     options={[{ id: "system", label: "Device" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" }]} />
        </div>
      </Section>
      <Section title="Ask Cue">
        <div className="card space-y-1 p-4 text-sm">
          {meta ? <>
            <p><StatusPill label={meta.ask_mode === "claude" ? "Claude connected" : "Local mode (no API key)"} tone={meta.ask_mode === "claude" ? "ok" : "warn"} /></p>
            <p className="text-muted">AI spending for Ask Cue: ${meta.ask_spent_usd.toFixed(2)} of ${meta.ask_budget_usd.toFixed(2)}. Each project in Cut Cue has its own budget.</p>
            <p className="text-muted">Ask Cue can look things up on its own. Anything that changes your work, shares with a client, costs money or sends a message waits in Inbox → Approvals.</p>
          </> : <Loading rows={1} />}
        </div>
      </Section>
      <Section title="This computer">
        <div className="card grid gap-2 p-4 text-sm sm:grid-cols-2">
          {health ? <>
            <span>FFmpeg: <strong className={health.ffmpeg ? "text-ok" : "text-danger"}>{health.ffmpeg ? "found" : "missing"}</strong></span>
            <span>Transcription: <strong>{health.transcriber}</strong> ({health.whisper_model})</span>
            <span>Password: <strong>{health.auth_required ? "on" : "off"}</strong></span>
            <span>Cloud processing: <strong>{health.cloud_configured ? "configured (opt-in per project)" : "off"}</strong></span>
            <span>Version: {health.version}</span>
          </> : <Loading rows={1} />}
        </div>
      </Section>
      <Section title="Email notifications" id="email"><EmailSettings /></Section>
      <PortalAndBackups />
      <Section title="Cue Text" id="cue-text"><CueTextSettings /></Section>
      <Section title="Design">
        <div className="card flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
          <span>Every component in one place, in both themes.</span>
          <Link className="btn min-h-11" href="/gallery/">Open component gallery</Link>
        </div>
      </Section>
    </div>
  );
}

export default function Page() {
  return <AppShell title="Settings"><SettingsPage /></AppShell>;
}
