"use client";
// Project details: overview, media, brief, edits, reviews and delivery — all from /api/cue/projects/{id}.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, fmtBytes, renderUrl, uploadFile } from "@/lib/api";
import { CueAction, Overview, ReviewLink, shareUrl, STAGES, Stage } from "@/lib/cue";
import { duration, timeAgo } from "@/lib/format";
import { ACCEPT } from "./MediaPanel";
import { ActionCard, CopyField, ProcessingList } from "./cue";
import { useShell } from "./shell";
import { Dialog, Empty, ErrorState, Icon, Loading, Progress, Spinner, StatusPill, Tabs } from "./ui";

const TABS = [
  { id: "overview", label: "Overview" }, { id: "media", label: "Media" }, { id: "brief", label: "Brief" },
  { id: "edits", label: "Edits" }, { id: "reviews", label: "Reviews" }, { id: "delivery", label: "Delivery" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function ProjectDetails({ pid, tab, onTab }: { pid: string; tab: string; onTab: (t: string) => void }) {
  const { toast, refreshBadges } = useShell();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string>("");
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const load = useCallback(() => api.get<Overview>(`/cue/projects/${pid}`).then((d) => { setO(d); setError(""); })
    .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "missing" : "down")), [pid]);
  useEffect(() => { load(); api.get<{ public_url: string | null }>("/cue/meta").then((m) => setPublicUrl(m.public_url)).catch(() => {}); }, [load]);
  useEffect(() => {
    const t = setInterval(load, o?.processing.length ? 3000 : 12000);
    return () => clearInterval(t);
  }, [load, o?.processing.length]);

  if (error === "missing") return <ErrorState title="Project not found">It may have been deleted. <Link className="text-violet underline" href="/projects/">Back to projects</Link></ErrorState>;
  if (error && !o) return <ErrorState title="Couldn't load this project" onRetry={load}>Check that Cue is running.</ErrorState>;
  if (!o) return <Loading label="Loading project" rows={4} />;
  const p = o.project;
  const current = (TABS.some((t) => t.id === tab) ? tab : "overview") as TabId;
  const patch = async (body: Record<string, unknown>, msg: string) => {
    try { await api.patch(`/cue/projects/${pid}`, body); toast(msg); load(); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't save", "error"); }
  };

  return (
    <div className="space-y-5">
      <Link href="/projects/" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:text-text"><Icon name="arrowLeft" size={16} /> Projects</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-semibold tracking-tight" data-testid="project-title">{p.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>{p.client_name ?? "No client"}</span>
            <StatusPill label={p.status.label} tone={p.status.tone} busy={p.status.key === "processing"} />
            {p.archived_at && <span className="chip">Archived</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-primary min-h-11" href={`/project/?id=${pid}&mode=simple`}><Icon name="scissors" /> Open in Cut Cue</Link>
          <Link className="btn hidden min-h-11 md:inline-flex" href={`/project/?id=${pid}&mode=pro`}>Pro editor</Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-muted">Stage
          <select aria-label="Stage" className="input min-h-10 w-auto" value={p.stage} onChange={(e) => patch({ stage: e.target.value as Stage }, "Stage updated")}>
            {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <ClientEditor current={p.client_name} onSave={(name) => patch(name ? { client_name: name } : { clear_client: true }, "Client saved")} />
        <button className="btn btn-ghost min-h-10 text-sm" onClick={() => patch({ archived: !p.archived_at }, p.archived_at ? "Restored" : "Archived. Find it under Projects → Archived.")}>
          <Icon name="archive" size={16} /> {p.archived_at ? "Restore" : "Archive"}
        </button>
      </div>

      <Tabs label="Project sections" value={current} onChange={(t) => onTab(t)}
            tabs={TABS.map((t) => ({ ...t, badge: t.id === "reviews" ? p.open_feedback : t.id === "overview" ? o.problems.length : 0 }))} />

      <div role="tabpanel" aria-labelledby={`tab-${current}`} className="min-w-0">
        {current === "overview" && <OverviewTab o={o} reload={load} onTab={onTab} />}
        {current === "media" && <MediaTab o={o} reload={load} publicUrl={publicUrl} />}
        {current === "brief" && <BriefTab o={o} />}
        {current === "edits" && <EditsTab o={o} />}
        {current === "reviews" && <ReviewsTab o={o} reload={() => { load(); refreshBadges(); }} publicUrl={publicUrl} />}
        {current === "delivery" && <DeliveryTab o={o} onDelivered={() => patch({ stage: "delivered" }, "Marked as delivered")} />}
      </div>
    </div>
  );
}

function ClientEditor({ current, onSave }: { current: string | null; onSave: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(current ?? "");
  return (
    <>
      <button className="btn btn-ghost min-h-10 text-sm" onClick={() => { setName(current ?? ""); setOpen(true); }}><Icon name="user" size={16} /> {current ? "Change client" : "Add client"}</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Client">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave(name.trim()); setOpen(false); }}>
          <label className="block space-y-1.5"><span className="label">Client name</span>
            <input className="input min-h-11" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Leave empty to remove" />
          </label>
          <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary">Save</button></div>
        </form>
      </Dialog>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-xl border border-line bg-panel p-3"><div className="text-xl font-semibold">{value}</div><div className="text-xs text-muted">{label}</div></div>;
}

function OverviewTab({ o, reload, onTab }: { o: Overview; reload: () => void; onTab: (t: string) => void }) {
  const { toast } = useShell();
  const p = o.project;
  const pending = o.proposals.filter((x) => x.status === "pending");
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Media files" value={p.media_count} /><Stat label="Saved edit versions" value={p.version_count} />
        <Stat label="Finished renders" value={p.render_count} /><Stat label="Open client notes" value={p.open_feedback} />
      </div>
      {o.problems.length > 0 && (
        <section aria-label="Problems" className="space-y-2">
          {o.problems.map((pr, i) => (
            <div key={i} role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-3">
              <p className="font-medium text-danger">{pr.label} failed</p>
              <p className="text-sm">{pr.help}</p>
              {pr.error && <details className="mt-1 text-xs text-muted"><summary className="cursor-pointer">Technical details</summary>{pr.error}</details>}
              {pr.can_retry && pr.job_id && (
                <button className="btn btn-sm mt-2 min-h-9" onClick={async () => {
                  try { await api.post(`/projects/${p.id}/jobs/${pr.job_id}/retry`); toast("Retrying…", "info"); reload(); }
                  catch (e) { toast(e instanceof ApiError ? e.message : "Retry failed", "error"); }
                }}>Retry</button>
              )}
            </div>
          ))}
        </section>
      )}
      <section aria-label="Next step" className="rounded-2xl border border-line bg-panel p-4">
        {p.media_count === 0 ? <p className="text-sm">Start by adding your recording. <button className="text-violet underline" onClick={() => onTab("media")}>Add media</button></p>
          : pending.length ? <p className="text-sm">Cue proposed {pending.length === 1 ? "an edit" : `${pending.length} edits`}. <Link className="text-violet underline" href={`/project/?id=${p.id}&mode=simple`}>Preview and approve in Cut Cue</Link></p>
          : p.open_feedback ? <p className="text-sm">The client left notes. <button className="text-violet underline" onClick={() => onTab("reviews")}>Read the notes and prepare a revision</button></p>
          : p.render_count && p.stage !== "in_review" && p.stage !== "approved" && p.stage !== "delivered" ? <p className="text-sm">An edit is rendered. <button className="text-violet underline" onClick={() => onTab("reviews")}>Share it for review</button></p>
          : p.version_count === 0 && p.status.key === "ready" ? <p className="text-sm">Media is ready. <Link className="text-violet underline" href={`/project/?id=${p.id}&mode=simple`}>Ask Cue for a first edit</Link></p>
          : o.processing.length ? <p className="text-sm">Cue is working on this project (see below). You can leave this page: you&apos;ll get a notification when it has actually finished.</p>
          : <p className="text-sm text-muted">{p.status.label}.</p>}
      </section>
      <section aria-label="Processing" className="space-y-2"><h3 className="text-sm font-semibold text-muted">Processing</h3><ProcessingList jobs={o.processing} showProject={false} /></section>
      {o.actions.length > 0 && (
        <section className="space-y-2"><h3 className="text-sm font-semibold text-muted">Cue actions for this project</h3>
          {o.actions.slice(0, 5).map((a) => <ActionCard key={a.id} a={a} onChange={reload} />)}
        </section>
      )}
    </div>
  );
}

function MediaTab({ o, reload, publicUrl }: { o: Overview; reload: () => void; publicUrl: string | null }) {
  const { toast } = useShell();
  const input = useRef<HTMLInputElement>(null);
  const [ups, setUps] = useState<{ name: string; progress: number; error?: string }[]>([]);
  const [link, setLink] = useState<string>("");
  const [drag, setDrag] = useState(false);
  const pid = o.project.id;
  const send = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUps((u) => [...u, { name: f.name, progress: 0 }]);
      try {
        await uploadFile(pid, f, (fr) => setUps((u) => u.map((x) => (x.name === f.name ? { ...x, progress: fr } : x))));
        setUps((u) => u.filter((x) => x.name !== f.name));
        toast(`${f.name} uploaded. Cue is analyzing it.`);
      } catch (e) {
        setUps((u) => u.map((x) => (x.name === f.name ? { ...x, error: e instanceof ApiError ? e.message : "Upload failed" } : x)));
      }
      reload();
    }
  };
  return (
    <div className="space-y-4">
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
           onDrop={(e) => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files); }}
           className={`rounded-2xl border-2 border-dashed p-5 text-center ${drag ? "border-accent bg-accent-soft" : "border-line2"}`}>
        <p className="font-medium">Add recordings, photos or the brief</p>
        <p className="mt-1 text-xs text-muted">Video, audio, images, PDF/DOCX/TXT briefs and SRT captions. Identical files are stored once.</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <button className="btn btn-primary min-h-11" onClick={() => input.current?.click()}><Icon name="upload" /> Choose files</button>
          <button className="btn min-h-11" onClick={async () => {
            try { const r = await api.post<{ path: string }>(`/cue/projects/${pid}/upload-links`); setLink(shareUrl(r.path, publicUrl)); }
            catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't create link", "error"); }
          }}><Icon name="phone" /> Upload from a phone</button>
        </div>
        <input ref={input} type="file" multiple hidden accept={ACCEPT} data-testid="details-file-input" onChange={(e) => { if (e.target.files) send(e.target.files); e.target.value = ""; }} />
      </div>
      {link && (
        <div className="rounded-xl border border-line bg-panel p-3 text-sm">
          <p className="mb-2">Open this private link on a phone to upload straight into this project. It works for 7 days and 10 files.</p>
          <CopyField label="Upload link" value={link} />
        </div>
      )}
      {ups.map((u) => (
        <div key={u.name} className="rounded-xl border border-line bg-panel2 p-3 text-sm">
          <div className="flex justify-between gap-2"><span className="truncate">{u.name}</span><span className="text-xs text-muted">{u.error ? "" : `Uploading ${Math.round(u.progress * 100)}%`}</span></div>
          {u.error ? <p role="alert" className="text-xs text-danger">{u.error}</p> : <div className="mt-2"><Progress value={u.progress} label={`Uploading ${u.name}`} /></div>}
        </div>
      ))}
      {o.assets.length === 0 ? <Empty icon="film" title="No files yet">Add a recording to get started.</Empty> : (
        <ul className="card divide-y divide-line/60 p-1" aria-label="Project media">
          {o.assets.map((a) => (
            <li key={a.id} className="flex min-h-14 items-center gap-3 p-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-panel2 text-muted"><Icon name={a.kind === "document" ? "doc" : a.kind === "audio" ? "wave" : a.kind === "image" ? "grid" : "film"} size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{a.original_name}</span>
                <span className="block text-xs text-muted">{a.kind}{a.duration ? ` · ${duration(a.duration)}` : ""} · {fmtBytes(a.size)}{a.has_transcript ? " · transcript" : ""}</span>
              </span>
              <StatusPill label={a.status === "ready" ? (a.kind === "document" ? "Brief ready" : a.has_transcript || a.kind === "image" ? "Ready" : "Analyzing") : a.status === "error" ? "Couldn't process" : "Processing"}
                          tone={a.status === "error" ? "danger" : a.status === "ready" ? "ok" : "info"} busy={a.status === "processing"} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BriefTab({ o }: { o: Overview }) {
  const r = o.brief.requirements;
  if (!o.brief.has_brief) return <Empty icon="doc" title="No brief yet">Upload a brief (PDF, DOCX or TXT) in Media, or add requirements in Cut Cue → Tools → Brief.</Empty>;
  const row = (label: string, value?: string | string[] | null) => value && (Array.isArray(value) ? value.length : true) ? (
    <div className="grid gap-1 py-2 sm:grid-cols-[160px_1fr]"><dt className="text-sm text-muted">{label}</dt><dd className="text-sm">{Array.isArray(value) ? value.join(", ") : value}</dd></div>) : null;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Read from {o.brief.sources.map((s) => s.name).join(", ") || "your notes"}. Briefs are treated as information, never as instructions to Cue.</p>
      <dl className="card divide-y divide-line/60 px-4">
        {row("Client", r.client)}{row("Goals", r.goals)}{row("Audience", r.audience)}{row("Tone", r.tone)}{row("Platforms", r.platforms)}
        {row("Deliverables", (r.deliverables ?? []).map((d) => d.text || d.kind))}{row("Key messages", r.key_messages)}
        {row("Must include", r.must_include)}{row("Avoid", r.must_avoid)}{row("Call to action", r.cta)}{row("Deadline", r.deadline)}
      </dl>
      <Link className="btn min-h-11" href={`/project/?id=${o.project.id}&mode=pro`}>Edit requirements in Cut Cue</Link>
    </div>
  );
}

function EditsTab({ o }: { o: Overview }) {
  const pid = o.project.id;
  return (
    <div className="space-y-4">
      {o.sequences.length === 0 && o.proposals.length === 0 ? (
        <Empty icon="scissors" title="No edits yet">
          <p>Open Cut Cue and ask for an edit, or ask Cue on Home.</p>
          <Link className="btn btn-primary mt-3 min-h-11" href={`/project/?id=${pid}&mode=simple`}>Open in Cut Cue</Link>
        </Empty>
      ) : (
        <>
          {!!o.sequences.length && (
            <ul className="card divide-y divide-line/60 p-1" aria-label="Edits">
              {o.sequences.map((s) => (
                <li key={s.id} className="flex min-h-14 flex-wrap items-center gap-3 p-2">
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{s.name}</span>
                    <span className="block text-xs text-muted">{duration(s.duration)} · {s.versions} version{s.versions === 1 ? "" : "s"}</span></span>
                  <Link className="btn btn-sm min-h-9" href={`/project/?id=${pid}&mode=simple`}>Simple</Link>
                  <Link className="btn btn-sm hidden min-h-9 md:inline-flex" href={`/project/?id=${pid}&mode=pro`}>Pro</Link>
                </li>
              ))}
            </ul>
          )}
          {!!o.proposals.length && (
            <section><h3 className="mb-2 text-sm font-semibold text-muted">Cue&apos;s proposals</h3>
              <ul className="space-y-1">{o.proposals.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel p-3 text-sm">
                  <span className="min-w-0 truncate">{x.title}</span>
                  <StatusPill label={x.status === "pending" ? "Waiting for you" : x.status === "approved" ? "Approved" : "Rejected"} tone={x.status === "pending" ? "accent" : x.status === "approved" ? "ok" : "muted"} />
                </li>))}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ReviewsTab({ o, reload, publicUrl }: { o: Overview; reload: () => void; publicUrl: string | null }) {
  const { toast } = useShell();
  const pid = o.project.id;
  const done = o.renders.filter((r) => r.status === "succeeded");
  const [renderId, setRenderId] = useState(done[0]?.id ?? "");
  const [label, setLabel] = useState("Client review");
  const [download, setDownload] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [created, setCreated] = useState<string>("");
  const [revision, setRevision] = useState<CueAction | null>(null);
  const open = o.feedback.filter((f) => f.kind !== "approved" && !f.resolved_at);
  return (
    <div className="space-y-6">
      <section className="card space-y-3 p-4">
        <h3 className="font-semibold">Share for review</h3>
        {done.length === 0 ? <p className="text-sm text-muted">{o.processing.some((j) => j.type === "render")
          ? "A preview is rendering now. As soon as it has finished, you can share it here."
          : "Nothing is rendered yet. Approve an edit in Cut Cue; when its preview has finished rendering you can share it here."}</p> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1"><span className="label">Which render</span>
                <select className="input min-h-11" value={renderId} onChange={(e) => setRenderId(e.target.value)}>
                  {done.map((r) => <option key={r.id} value={r.id}>{r.sequence_name ?? "Edit"} v{r.version_number} · {r.preset ?? r.quality} · {timeAgo(r.created_at)}</option>)}
                </select>
              </label>
              <label className="block space-y-1"><span className="label">Link name</span>
                <input className="input min-h-11" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={download} onChange={(e) => setDownload(e.target.checked)} /> Let the reviewer download the video</label>
            {confirm ? (
              <div className="rounded-xl border border-warn/40 p-3 text-sm">
                <p>Anyone with this link can watch this render and leave notes for 30 days, until you turn it off. Create it?</p>
                <div className="mt-2 flex gap-2">
                  <button className="btn btn-primary min-h-11" onClick={async () => {
                    try {
                      const r = await api.post<ReviewLink>(`/cue/projects/${pid}/review-links`, { render_id: renderId, label, allow_download: download });
                      setCreated(shareUrl(r.path!, publicUrl)); setConfirm(false); toast("Review link created"); reload();
                    } catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't create the link", "error"); }
                  }}>Yes, create link</button>
                  <button className="btn min-h-11" onClick={() => setConfirm(false)}>Cancel</button>
                </div>
              </div>
            ) : <button className="btn btn-primary min-h-11" onClick={() => setConfirm(true)}><Icon name="link" /> Create review link</button>}
            {created && <div className="space-y-1"><p className="text-sm text-ok">Link ready. It&apos;s shown only now, so copy it.</p><CopyField label="Review link" value={created} /></div>}
          </>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted">Review links</h3>
        {o.reviews.length === 0 ? <p className="text-sm text-muted">No links yet.</p> : (
          <ul className="space-y-2" aria-label="Review links">
            {o.reviews.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-3 text-sm">
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{l.label}</span>
                  <span className="block text-xs text-muted">Created {timeAgo(l.created_at)} · {l.comments ?? 0} note{l.comments === 1 ? "" : "s"}{l.last_viewed_at ? ` · viewed ${timeAgo(l.last_viewed_at)}` : " · not opened yet"}</span></span>
                {l.decision && <StatusPill label={l.decision.kind === "approved" ? `Approved by ${l.decision.author}` : `Changes from ${l.decision.author}`} tone={l.decision.kind === "approved" ? "ok" : "warn"} />}
                <StatusPill label={l.active ? "Active" : l.revoked_at ? "Turned off" : "Expired"} tone={l.active ? "info" : "muted"} />
                {l.active && <button className="btn btn-sm min-h-9" onClick={async () => { await api.post(`/cue/projects/${pid}/review-links/${l.id}/revoke`); toast("Link turned off"); reload(); }}>Turn off</button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-muted">Client notes {open.length ? `(${open.length} open)` : ""}</h3>
          {open.length > 0 && !revision && (
            <button className="btn min-h-10" onClick={async () => {
              try { setRevision(await api.post<CueAction>("/cue/actions", { kind: "request_revision", project_id: pid, reason: "Address the open client notes" })); }
              catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't prepare", "error"); }
            }}><Icon name="sparkle" /> Prepare a revision</button>
          )}
        </div>
        {revision && <ActionCard a={revision} onChange={(a) => { setRevision(a); reload(); }} />}
        {o.feedback.length === 0 ? <p className="text-sm text-muted">No notes yet.</p> : (
          <ul className="space-y-2" aria-label="Client notes">
            {o.feedback.map((f) => (
              <li key={f.id} className={`rounded-xl border p-3 text-sm ${f.resolved_at ? "border-line opacity-70" : "border-line2 bg-panel"}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-semibold text-text">{f.author}</span>
                  {f.kind === "approved" ? <StatusPill label="Approved" tone="ok" /> : f.kind === "changes_requested" ? <StatusPill label="Requested changes" tone="warn" /> : null}
                  {f.at_seconds != null && <span>at {duration(f.at_seconds)}</span>}
                  <span>{timeAgo(f.created_at)}</span>
                </div>
                {f.body && <p className="mt-1 whitespace-pre-wrap">{f.body}</p>}
                {f.kind !== "approved" && (
                  <label className="mt-2 flex min-h-9 items-center gap-2 text-xs">
                    <input type="checkbox" className="h-4 w-4" checked={!!f.resolved_at}
                           onChange={async (e) => { await api.post(`/cue/projects/${pid}/feedback/${f.id}`, { resolved: e.target.checked }); reload(); }} />
                    Done
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type RelayStatus = { configured: boolean; problem: string | null; url: string | null;
  publications: { id: string; render_id: string; status: string; error: string | null; attempts: number; published_at: number | null; updated_at: number }[] };

function PortalPublish({ o }: { o: Overview }) {
  const { toast } = useShell();
  const pid = o.project.id;
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [action, setAction] = useState<CueAction | null>(null);
  const load = useCallback(() => api.get<RelayStatus>(`/cue/relay?project_id=${pid}`).then(setRelay).catch(() => {}), [pid]);
  useEffect(() => { load(); }, [load]);
  const done = o.renders.filter((r) => r.status === "succeeded");
  if (!relay) return null;
  return (
    <section className="card space-y-3 p-4" aria-labelledby="portal-h">
      <h3 id="portal-h" className="font-semibold">Client portal</h3>
      {!relay.configured ? (
        <p className="text-sm text-muted">Not connected. {relay.problem} See docs/cue2/relay-connector.md.</p>
      ) : (
        <>
          <p className="text-sm text-muted">Publishes the latest finished render to your Menapoly Cue client portal as a new review version. It runs only after you approve, and publishing the same render twice never makes a second copy.</p>
          {action ? <ActionCard a={action} onChange={(a) => { setAction(a); load(); }} />
            : done.length === 0 ? <p className="text-sm text-muted">Render an edit first.</p>
            : <button className="btn min-h-11" onClick={async () => {
                try { setAction(await api.post<CueAction>("/cue/actions", { kind: "publish_to_relay", project_id: pid, reason: "Share with the client in the portal" })); }
                catch (e) { toast(e instanceof ApiError ? e.message : "Couldn't prepare", "error"); }
              }}><Icon name="link" /> Publish to client portal</button>}
        </>
      )}
      {relay.publications.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Portal publications">
          {relay.publications.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2">
              <StatusPill label={x.status === "published" ? "Published" : x.status === "failed" ? "Failed" : x.status === "uploading" ? "Uploading" : "Pending"}
                          tone={x.status === "published" ? "ok" : x.status === "failed" ? "danger" : "info"} busy={x.status === "uploading"} />
              <span className="text-muted">{timeAgo(x.published_at ?? x.updated_at)}{x.attempts > 1 ? ` · ${x.attempts} attempts` : ""}</span>
              {x.error && <span className="w-full text-xs text-danger">{x.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeliveryTab({ o, onDelivered }: { o: Overview; onDelivered: () => void }) {
  const pid = o.project.id;
  return (
    <div className="space-y-4">
      <PortalPublish o={o} />
      <div className="flex flex-wrap gap-2">
        <Link className="btn btn-primary min-h-11" href={`/project/?id=${pid}&mode=simple&export=1`}><Icon name="download" /> Export formats in Cut Cue</Link>
        {o.project.stage !== "delivered" && <button className="btn min-h-11" onClick={onDelivered}><Icon name="check" /> Mark as delivered</button>}
      </div>
      {o.renders.length === 0 ? <Empty icon="download" title="No renders yet">Approved edits render here. Final exports for each platform are made in Cut Cue.</Empty> : (
        <ul className="card divide-y divide-line/60 p-1" aria-label="Renders">
          {o.renders.map((r) => (
            <li key={r.id} className="flex min-h-14 flex-wrap items-center gap-3 p-2">
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{r.sequence_name ?? "Edit"} v{r.version_number} · {r.preset ?? (r.quality === "final" ? "Final" : "Preview")}</span>
                <span className="block text-xs text-muted">{r.duration ? duration(r.duration) : ""} · {timeAgo(r.created_at)}{r.status === "running" && r.message ? ` · ${r.message}` : ""}</span></span>
              {r.status === "succeeded"
                ? <a className="btn btn-sm min-h-9" href={renderUrl(pid, r.id, "mp4", true)}><Icon name="download" size={14} /> MP4</a>
                : <StatusPill label={r.status === "failed" ? "Failed" : r.status === "cancelled" ? "Cancelled" : r.status === "queued" ? "Waiting" : "Rendering"}
                              tone={r.status === "failed" ? "danger" : "info"} busy={r.status === "running"} />}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">{o.processing.some((j) => j.type === "render") ? <><Spinner size={10} /> A render is running. It appears here when it has actually finished.</> : null}</p>
    </div>
  );
}
