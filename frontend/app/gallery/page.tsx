"use client";
// Component gallery: every shared component in dark and light themes. Uses labelled SAMPLE data only.
import { useState } from "react";
import { ActionCard, ProcessingList, ProjectCardView, ProjectRow } from "@/components/cue";
import AppShell, { Section, useShell } from "@/components/shell";
import { Dialog, Empty, ErrorState, Icon, Loading, Progress, Segmented, Spinner, StatusPill, Tabs } from "@/components/ui";
import { CueAction, JobView, ProjectCard } from "@/lib/cue";

const now = Date.now() / 1000;
const SAMPLE_PROJECT: ProjectCard = {
  id: "prj_sample0000000000", name: "Sample: Spring Promo", created_at: now - 86400, client_id: null, client_name: "Sample Client",
  stage: "in_review", archived_at: null, asset_count: 3, media_count: 2, document_count: 1, thumb_asset_id: null, active_jobs: 0,
  failed_jobs: 0, pending_proposals: 0, pending_actions: 0, version_count: 2, render_count: 1, open_feedback: 1,
  last_activity: now - 600, status: { key: "in_review", label: "In client review", tone: "info" },
};
const SAMPLE_JOB: JobView = { id: "job_sample", project_id: "p", project_name: "Sample project", type: "render", label: "Rendering",
  status: "running", message: "Encoding clip 2 of 4", started_at: now - 42, created_at: now - 50 };
const action = (status: CueAction["status"], extra: Partial<CueAction> = {}): CueAction => ({
  id: `act_sample_${status}`, kind: "create_review_link", label: "Create a client review link", project_id: null, project_name: "Sample",
  args: { reason: "Sample reason shown to the owner" }, summary: "Create a client review link for “Sample: Spring Promo”",
  risk: "client_facing", risk_text: "Creates a link someone outside can open.", status, created_by: "ask-cue", result: null, error: null,
  created_at: now - 120, decided_at: null, ...extra });

const TOKENS = ["ink", "panel", "panel2", "panel3", "line", "text", "muted", "faint", "accent", "violet", "ok", "warn", "danger"];

function Swatches() {
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      {TOKENS.map((t) => (
        <li key={t} className="text-xs"><span className="mb-1 block h-10 rounded-lg border border-line" style={{ background: `var(--${t})` }} />{t}</li>
      ))}
    </ul>
  );
}

function Kit() {
  const [tab, setTab] = useState("one");
  const [seg, setSeg] = useState("simple");
  return (
    <div className="space-y-5 rounded-2xl bg-ink p-4 text-text">
      <Swatches />
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary">Primary</button><button className="btn">Secondary</button>
        <button className="btn btn-ghost">Ghost</button><button className="btn btn-danger">Danger</button>
        <button className="btn" disabled>Disabled</button><button className="btn btn-icon" aria-label="Icon button"><Icon name="plus" /></button>
      </div>
      <div className="flex flex-wrap gap-2">
        {(["ok", "info", "accent", "warn", "danger", "muted"] as const).map((t) => <StatusPill key={t} label={t} tone={t} />)}
        <StatusPill label="Processing" tone="info" busy />
      </div>
      <label className="block space-y-1"><span className="label">Input</span><input className="input min-h-11" placeholder="Placeholder" /></label>
      <Tabs label="Sample tabs" value={tab} onChange={setTab} tabs={[{ id: "one", label: "One" }, { id: "two", label: "Two", badge: 2 }]} />
      <Segmented label="Sample segmented" value={seg} onChange={setSeg} options={[{ id: "simple", label: "Simple" }, { id: "pro", label: "Pro" }]} />
      <Progress value={0.4} label="Upload (bytes sent, real)" />
      <div className="flex items-center gap-2 text-sm"><Spinner /> Spinner</div>
    </div>
  );
}

function Gallery() {
  const { toast } = useShell();
  const [dialog, setDialog] = useState(false);
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted">All examples below use sample data. Buttons on sample action cards will report that the action doesn&apos;t exist.</p>
      <Section title="Tokens and controls">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div data-theme="dark"><p className="mb-1 text-xs text-muted">Dark</p><Kit /></div>
          <div data-theme="light"><p className="mb-1 text-xs text-muted">Light</p><Kit /></div>
        </div>
      </Section>
      <Section title="Project card, row and processing">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ul><ProjectCardView p={SAMPLE_PROJECT} /></ul>
          <div className="space-y-3"><ul className="card p-1"><ProjectRow p={SAMPLE_PROJECT} /></ul><ProcessingList jobs={[SAMPLE_JOB]} /><ProcessingList jobs={[]} /></div>
        </div>
      </Section>
      <Section title="Action cards: proposed vs. executed vs. failed">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <ActionCard a={action("proposed")} />
          <ActionCard a={action("executed", { result: { note: "Sample result note" } })} />
          <ActionCard a={action("failed", { error: "Sample: texting isn't set up, so nothing was sent." })} />
        </div>
      </Section>
      <Section title="Empty, error and loading states">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="card"><Empty icon="folder" title="Empty state">Explains what will appear and how to start.</Empty></div>
          <div className="card"><ErrorState title="Error state" onRetry={() => toast("Retry pressed", "info")}>Plain explanation plus a way to recover.</ErrorState></div>
          <div className="card p-4"><Loading label="Loading sample" rows={3} /></div>
        </div>
      </Section>
      <Section title="Dialogs and toasts">
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={() => setDialog(true)}>Open dialog</button>
          <button className="btn" onClick={() => toast("Saved (sample)")}>Success toast</button>
          <button className="btn" onClick={() => toast("Couldn't save (sample)", "error")}>Error toast</button>
          <button className="btn" onClick={() => toast("For your information (sample)", "info")}>Info toast</button>
        </div>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Sample dialog">
          <p className="text-sm text-muted">Focus is trapped here; Escape closes and returns focus. On phones this is a bottom sheet.</p>
          <div className="mt-4 flex justify-end"><button className="btn btn-primary" onClick={() => setDialog(false)}>Done</button></div>
        </Dialog>
      </Section>
    </div>
  );
}

export default function Page() {
  return <AppShell title="Component gallery"><Gallery /></AppShell>;
}
