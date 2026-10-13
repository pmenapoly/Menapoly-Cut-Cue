"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import AssetPanel from "@/components/AssetPanel";
import AuthGate from "@/components/AuthGate";
import ChatPanel from "@/components/ChatPanel";
import { JobsPanel, RendersPanel, VersionsPanel } from "@/components/OutputsPanel";
import TimelineEditor from "@/components/TimelineEditor";
import TranscriptPanel from "@/components/TranscriptPanel";
import {
  api, ApiError, Asset, Clip, Health, Job, mediaUrl, Project, Proposal, Render, renderUrl, Sequence, Timeline,
} from "@/lib/api";

type Source = { kind: "asset"; assetId: string } | { kind: "render"; render: Render } | null;

function Editor({ pid }: { pid: string }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [renders, setRenders] = useState<Render[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [seqId, setSeqId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Timeline | null>(null);
  const [dirty, setDirty] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"renders" | "versions" | "jobs">("renders");
  const [source, setSource] = useState<Source>(null);
  const [time, setTime] = useState(0);
  const [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const pendingSeek = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, a, s, pr, r, j] = await Promise.all([
        api.get<Project>(`/projects/${pid}`), api.get<Asset[]>(`/projects/${pid}/assets`),
        api.get<Sequence[]>(`/projects/${pid}/sequences`), api.get<Proposal[]>(`/projects/${pid}/proposals`),
        api.get<Render[]>(`/projects/${pid}/renders`), api.get<Job[]>(`/projects/${pid}/jobs`),
      ]);
      setProject(p); setAssets(a); setSequences(s); setProposals(pr); setRenders(r); setJobs(j);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [pid]);

  useEffect(() => { api.get<Health>("/health").then(setHealth); refresh(); }, [refresh]);
  useEffect(() => { const t = setInterval(refresh, 2000); return () => clearInterval(t); }, [refresh]);

  // Keep the selected asset fresh (status, transcript) and pick defaults.
  useEffect(() => {
    if (selectedAsset) {
      const fresh = assets.find((a) => a.id === selectedAsset.id);
      if (!fresh) setSelectedAsset(null);
      else if (fresh.status !== selectedAsset.status || fresh.has_transcript !== selectedAsset.has_transcript) selectAsset(fresh);
    } else {
      const firstMedia = assets.find((a) => a.kind === "video" || a.kind === "audio");
      if (firstMedia) selectAsset(firstMedia);
    }
  }, [assets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!seqId && sequences.length) setSeqId(sequences[0].id);
    if (seqId && !sequences.some((s) => s.id === seqId)) setSeqId(sequences[0]?.id ?? null);
  }, [sequences, seqId]);

  const seq = sequences.find((s) => s.id === seqId) ?? null;
  useEffect(() => {
    if (!dirty) { setDraft(seq?.timeline ?? null); setProblems([]); }
  }, [seq?.current_version_id, seqId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectAsset = async (a: Asset) => {
    const full = await api.get<Asset>(`/projects/${pid}/assets/${a.id}`);
    setSelectedAsset(full);
    if ((full.kind === "video" || full.kind === "audio") && (!source || source.kind === "asset")) setSource({ kind: "asset", assetId: full.id });
  };

  const seek = (assetId: string, t: number, until: number | null = null) => {
    stopAt.current = until;
    if (source?.kind === "asset" && source.assetId === assetId && video.current) {
      video.current.currentTime = t;
      video.current.play().catch(() => {});
    } else {
      pendingSeek.current = t;
      setSource({ kind: "asset", assetId });
    }
  };

  const editDraft = (t: Timeline) => { setDraft(t); setDirty(true); setProblems([]); };

  const addClip = async (assetId: string, start: number, end: number, label: string) => {
    const a = assets.find((x) => x.id === assetId);
    const clip: Clip = { asset_id: assetId, start: Math.round(start * 1000) / 1000, end: Math.min(a?.duration ?? end, Math.round(end * 1000) / 1000), label };
    if (!seq || !draft) {
      try {
        const created = await api.post<Sequence>(`/projects/${pid}/sequences`, {
          name: "Main", timeline: { aspect: "16:9", clips: [clip], burn_captions: false, normalize_audio: true } });
        setSeqId(created.id);
        refresh();
      } catch (err) { setError(err instanceof ApiError ? [err.message, ...err.problems].join("; ") : String(err)); }
    } else {
      editDraft({ ...draft, clips: [...draft.clips, clip] });
    }
  };

  const save = async (label: string) => {
    if (!seq || !draft) return;
    setBusy(true);
    try {
      await api.post(`/projects/${pid}/sequences/${seq.id}/versions`, { timeline: draft, label });
      setDirty(false);
      await refresh();
    } catch (err) {
      setProblems(err instanceof ApiError ? (err.problems.length ? err.problems : [err.message]) : [String(err)]);
    } finally { setBusy(false); }
  };

  const render = async (quality: "preview" | "final", wav: boolean) => {
    if (!seq?.current_version_id) return;
    setBusy(true);
    try {
      await api.post(`/projects/${pid}/renders`, { version_id: seq.current_version_id, quality, wav });
      setTab("renders");
      await refresh();
    } catch (err) {
      setProblems(err instanceof ApiError ? (err.problems.length ? err.problems : [err.message]) : [String(err)]);
    } finally { setBusy(false); }
  };

  const setMode = async (patch: Partial<{ processing_mode: string; cloud_approved: boolean; budget_usd: number }>) => {
    try { setProject(await api.patch<Project>(`/projects/${pid}`, patch)); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
  };

  const src = source?.kind === "asset" ? mediaUrl(pid, source.assetId) : source?.kind === "render" ? renderUrl(pid, source.render.id, "mp4") : null;
  const sourceAsset = source?.kind === "asset" ? assets.find((a) => a.id === source.assetId) : null;
  const assetMap = Object.fromEntries(assets.map((a) => [a.id, a]));
  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "queued").length;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <Link href="/" className="text-sm text-muted hover:text-accent">← Projects</Link>
        <h1 className="font-semibold">{project?.name ?? "…"}</h1>
        <span className="text-xs text-muted">Menapoly Cut Cue</span>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">Processing
            <select className="input py-0.5" value={project?.processing_mode ?? "local"}
                    onChange={(e) => setMode({ processing_mode: e.target.value })}>
              <option value="local">Local (this Mac)</option>
              <option value="cloud" disabled={!health?.cloud_configured}>Cloud{health?.cloud_configured ? "" : " (not configured)"}</option>
            </select>
          </label>
          {project?.processing_mode === "cloud" && (
            <label className="flex items-center gap-1 text-accent">
              <input type="checkbox" checked={!!project.cloud_approved} onChange={(e) => setMode({ cloud_approved: e.target.checked })} />
              I approve uploading this project&apos;s footage to my cloud worker
            </label>
          )}
          <label className="flex items-center gap-1" title="AI spend cap for this project">
            AI ${project?.spent_usd.toFixed(2) ?? "0.00"} /
            <input className="input w-16 py-0.5" type="number" min={0} step={1} defaultValue={project?.budget_usd}
                   key={project?.budget_usd} onBlur={(e) => setMode({ budget_usd: Number(e.target.value) })} />
          </label>
          {activeJobs > 0 && <span className="text-accent">{activeJobs} job{activeJobs > 1 ? "s" : ""} running</span>}
        </div>
      </header>
      {error && <div className="bg-danger/20 px-4 py-1 text-sm text-danger" onClick={() => setError("")}>{error} (click to dismiss)</div>}

      <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[300px_minmax(0,1fr)_380px]">
        <aside className="flex min-h-0 flex-col gap-3 lg:h-[calc(100vh-4.5rem)]">
          <section className="card flex max-h-[45%] min-h-[180px] flex-col p-3">
            <h2 className="label mb-2">Media & briefs</h2>
            <AssetPanel pid={pid} assets={assets} selectedId={selectedAsset?.id ?? null} onSelect={selectAsset} onChange={refresh} />
          </section>
          <section className="card flex min-h-[240px] flex-1 flex-col p-3">
            <h2 className="label mb-2 truncate">{selectedAsset ? `Transcript · ${selectedAsset.original_name}` : "Transcript"}</h2>
            <TranscriptPanel pid={pid} asset={selectedAsset} assets={assets}
                             currentTime={source?.kind === "asset" && source.assetId === selectedAsset?.id ? time : -1}
                             onSeek={(aid, t) => seek(aid, t)} onAdd={addClip} />
          </section>
        </aside>

        <main className="flex min-w-0 flex-col gap-3">
          <section className="card p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-muted">
              <span>{source?.kind === "render" ? `Render · ${source.render.sequence_name} v${source.render.version_number} (${source.render.quality})`
                : sourceAsset ? `Source · ${sourceAsset.original_name}${sourceAsset.proxy_name ? " (proxy)" : ""}` : "Player"}</span>
            </div>
            {src ? (
              <video ref={video} key={src} src={src} controls playsInline className="mx-auto max-h-[46vh] w-full rounded bg-black"
                     onLoadedMetadata={() => {
                       if (pendingSeek.current != null && video.current) {
                         video.current.currentTime = pendingSeek.current;
                         pendingSeek.current = null;
                         video.current.play().catch(() => {});
                       }
                     }}
                     onTimeUpdate={(e) => {
                       const t = e.currentTarget.currentTime;
                       setTime(t);
                       if (stopAt.current != null && t >= stopAt.current) { e.currentTarget.pause(); stopAt.current = null; }
                     }} />
            ) : (
              <div className="flex aspect-video items-center justify-center rounded bg-black text-sm text-muted">Upload a video or audio file to start.</div>
            )}
          </section>

          <section className="card p-3">
            <TimelineEditor sequences={sequences} seqId={seqId}
                            onSelectSeq={(id) => { if (!dirty || confirm("Discard unsaved timeline changes?")) { setDirty(false); setSeqId(id); } }}
                            draft={draft} setDraft={editDraft} dirty={dirty} assets={assetMap}
                            playhead={{ assetId: source?.kind === "asset" ? source.assetId : null, time }}
                            onSave={save} onRevert={() => { setDirty(false); setDraft(seq?.timeline ?? null); setProblems([]); }}
                            onNewSequence={async (name) => { const s = await api.post<Sequence>(`/projects/${pid}/sequences`, { name }); setDirty(false); setSeqId(s.id); setDraft({ aspect: "16:9", clips: [], burn_captions: false, normalize_audio: true }); refresh(); }}
                            onDeleteSequence={async (id) => { await api.del(`/projects/${pid}/sequences/${id}`); setDirty(false); refresh(); }}
                            onPreviewClip={(c) => seek(c.asset_id, c.start, c.end)}
                            onRender={render} busy={busy} problems={problems} />
          </section>

          <section className="card min-h-[200px] p-3">
            <div className="mb-2 flex gap-2">
              {(["renders", "versions", "jobs"] as const).map((t) => (
                <button key={t} className={`btn btn-sm capitalize ${tab === t ? "border-accent text-accent" : ""}`} onClick={() => setTab(t)}>{t}</button>
              ))}
            </div>
            {tab === "renders" && <RendersPanel pid={pid} renders={renders} playingId={source?.kind === "render" ? source.render.id : null}
                                                onPlay={(r) => { stopAt.current = null; setSource({ kind: "render", render: r }); }} />}
            {tab === "versions" && <VersionsPanel pid={pid} seq={seq} onChanged={() => { setDirty(false); refresh(); }} />}
            {tab === "jobs" && <JobsPanel pid={pid} jobs={jobs} onChanged={refresh} />}
          </section>
        </main>

        <aside className="card flex min-h-[420px] flex-col p-3 lg:h-[calc(100vh-4.5rem)]">
          <ChatPanel pid={pid} mode={health?.assistant_mode ?? "local-test"} proposals={proposals} onProposalsChanged={refresh} />
        </aside>
      </div>
    </div>
  );
}

function EditorRoute() {
  const pid = useSearchParams().get("id");
  if (!pid) return <p className="p-8 text-muted">Missing project id. <Link href="/" className="text-accent">Back to projects</Link></p>;
  return <Editor pid={pid} />;
}

export default function Page() {
  return (
    <AuthGate>
      <Suspense fallback={<div className="p-8 text-muted">Loading…</div>}>
        <EditorRoute />
      </Suspense>
    </AuthGate>
  );
}
