"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { CueChat } from "@/components/CueChat";
import { ExportDialog, RenderRow } from "@/components/ExportDialog";
import { Inspector } from "@/components/Inspector";
import { FileList, UploadZone } from "@/components/MediaPanel";
import { Player, PlayerHandle, PlayerSource } from "@/components/Player";
import { Timeline } from "@/components/Timeline";
import { AutoEditPanel, BriefPanel, ClipsPanel, SourcePanel } from "@/components/ToolsPanel";
import { TranscriptEditor } from "@/components/TranscriptEditor";
import { Dialog, Icon, Logo, Segmented, Spinner, Tabs, Toasts } from "@/components/ui";
import { VersionsDialog } from "@/components/VersionsDialog";
import { Mode, MobileTab, PreviewTarget, useWorkspace, WorkspaceCtx } from "@/components/workspace";
import { api, Asset } from "@/lib/api";
import { duration } from "@/lib/format";
import { ProjectProvider, useStore } from "@/lib/project";
import { outputTime, removeClip, splitAt } from "@/lib/timeline";

function isTyping(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  return !!t && (t.isContentEditable || ["TEXTAREA", "SELECT"].includes(t.tagName) || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range"));
}

/* ---------- Guided first project: Create → Upload → Brief → Analyze → Ask Cue → Review → Export ---------- */
function Onboarding({ onDismiss }: { onDismiss: () => void }) {
  const { assets, messages, proposals, sequences, renders, brief } = useStore();
  const { setMobileTab, openExport } = useWorkspace();
  const media = assets.filter((a) => a.kind === "video" || a.kind === "audio");
  const steps = [
    { id: "create", label: "Create", done: true },
    { id: "upload", label: "Upload", done: media.length > 0 },
    { id: "brief", label: "Add brief", done: !!brief?.has_brief, optional: true },
    { id: "analyze", label: "Analyze", done: media.some((a) => a.has_transcript) },
    { id: "ask", label: "Ask Cue", done: messages.length > 0 || proposals.length > 0 },
    { id: "review", label: "Review", done: sequences.length > 0 },
    { id: "export", label: "Export", done: renders.some((r) => r.quality === "final" && r.status === "succeeded") },
  ];
  const current = steps.find((s) => !s.done && !s.optional);
  const hint: Record<string, string> = {
    upload: "Drop your recording, and the client brief if you have one, into Files.",
    analyze: "Cue is listening to your recording: transcribing and finding the speakers, right here on your Mac.",
    ask: "Ask Cue for an edit, or tap a suggestion like “Make a tight rough cut with a hook”.",
    review: "Preview Cue's proposal, then Approve it, or Revise it with a note.",
    export: "Export it for YouTube, a podcast, TikTok, Reels or LinkedIn.",
  };
  if (!current) return null;
  return (
    <nav aria-label="Getting started" className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 animate-fade-in" data-testid="onboarding">
      <ol className="flex flex-wrap items-center gap-1 text-xs">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-1" aria-current={s.id === current.id ? "step" : undefined}>
            <span className={`flex items-center gap-1 rounded-full px-2 py-1 ${s.done ? "text-ok" : s.id === current.id ? "bg-accent-soft font-semibold text-violet" : "text-faint"}`}>
              {s.done ? <Icon name="check" size={12} /> : <span className="w-3 text-center">{i + 1}</span>}{s.label}{s.optional && !s.done ? " (optional)" : ""}
            </span>
            {i < steps.length - 1 && <Icon name="chevron" size={12} className="text-line2" />}
          </li>
        ))}
      </ol>
      <p className="min-w-[14rem] flex-1 text-sm text-muted" data-testid="onboarding-hint">{hint[current.id]}</p>
      {current.id === "upload" && <button className="btn btn-sm lg:hidden" onClick={() => setMobileTab("files")}>Open files</button>}
      {current.id === "export" && <button className="btn btn-primary btn-sm" onClick={openExport}><Icon name="download" size={14} /> Export</button>}
      <button className="btn btn-ghost btn-sm text-faint" onClick={onDismiss} aria-label="Hide the getting-started guide">Hide</button>
    </nav>
  );
}

/* ---------- Top bar ---------- */
function TopBar() {
  const { project, pid, run, canUndo, canRedo, undo, redo, seq, dirty } = useStore();
  const { mode, setMode, openExport, openVersions } = useWorkspace();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-ink/80 backdrop-blur-xl">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-5">
        <Link href="/" className="btn btn-ghost btn-icon shrink-0" aria-label="All projects"><Logo compact /></Link>
        {renaming ? (
          <form className="min-w-0 flex-1" onSubmit={async (e) => { e.preventDefault(); await run(() => api.patch(`/projects/${pid}`, { name })); setRenaming(false); }}>
            <input className="input max-w-xs py-1" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(false)} autoFocus aria-label="Project name" />
          </form>
        ) : (
          <button className="min-w-0 truncate rounded-md px-1 text-left text-[15px] font-semibold tracking-tight hover:bg-panel2" title="Rename project"
                  onClick={() => { setName(project?.name ?? ""); setRenaming(true); }}>{project?.name ?? "…"}</button>
        )}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <div className="hidden items-center gap-0.5 sm:flex">
            <button className="btn btn-ghost btn-icon" onClick={undo} disabled={!canUndo} aria-label="Undo (⌘Z)" title="Undo"><Icon name="undo" /></button>
            <button className="btn btn-ghost btn-icon" onClick={redo} disabled={!canRedo} aria-label="Redo (⇧⌘Z)" title="Redo"><Icon name="redo" /></button>
            <button className="btn btn-ghost btn-icon" onClick={openVersions} disabled={!seq} aria-label="History and before/after" title="History"><Icon name="history" /></button>
          </div>
          <Segmented<Mode> label="Editing mode" value={mode} onChange={setMode}
                           options={[{ id: "simple", label: "Simple", hint: "Chat with Cue" }, { id: "pro", label: "Pro", hint: "Timeline editor" }]} />
          <button className="btn btn-primary" onClick={openExport} aria-label="Export"><Icon name="download" size={16} /><span className="hidden sm:inline">Export</span></button>
        </div>
      </div>
      {dirty && mode === "simple" && (
        <p className="border-t border-warn/30 bg-warn/10 px-5 py-1.5 text-xs text-warn">You have unsaved Pro changes. Switch to Pro to save or discard them.</p>
      )}
    </header>
  );
}

/* ---------- "Your edit" card (Simple) ---------- */
function EditCard() {
  const { sequences, seq, setSeqId, renders, canUndo, canRedo, undo, redo } = useStore();
  const { openVersions, openExport, setPreview } = useWorkspace();
  if (!seq) return null;
  const latest = renders.find((r) => r.version_id === seq.current_version_id);
  return (
    <section className="card space-y-3 p-4" aria-labelledby="edit-card-h" data-testid="edit-card">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="edit-card-h" className="label">Your edit</h2>
        <span className="text-xs text-faint">version {seq.versions.find((v) => v.id === seq.current_version_id)?.number} · {duration(seq.duration)} · {seq.timeline?.aspect}</span>
        <div className="ml-auto flex gap-0.5 sm:hidden">
          <button className="btn btn-ghost btn-icon" onClick={undo} disabled={!canUndo} aria-label="Undo"><Icon name="undo" /></button>
          <button className="btn btn-ghost btn-icon" onClick={redo} disabled={!canRedo} aria-label="Redo"><Icon name="redo" /></button>
        </div>
      </div>
      {sequences.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto scroll-thin" role="tablist" aria-label="Outputs">
          {sequences.map((s) => (
            <button key={s.id} role="tab" aria-selected={s.id === seq.id} onClick={() => { setSeqId(s.id); setPreview({ kind: "edit" }); }}
                    className={`btn btn-sm shrink-0 ${s.id === seq.id ? "border-accent text-violet" : ""}`}>
              {s.timeline?.aspect !== "16:9" && <span className="text-[10px] text-faint">{s.timeline?.aspect}</span>}{s.name}
            </button>
          ))}
        </div>
      )}
      {latest && latest.status !== "succeeded" && <ul><RenderRow r={latest} /></ul>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-sm" onClick={() => setPreview({ kind: "edit" })}><Icon name="play" size={12} /> Preview</button>
        {latest?.status === "succeeded" && <button className="btn btn-sm" onClick={() => setPreview({ kind: "render", id: latest.id })}><Icon name="film" size={13} /> Rendered preview</button>}
        <button className="btn btn-sm" onClick={openVersions}><Icon name="compare" size={13} /> Before / after</button>
        <button className="btn btn-primary btn-sm ml-auto" onClick={openExport}><Icon name="download" size={14} /> Export</button>
      </div>
    </section>
  );
}

/* ---------- The workspace ---------- */
function Workspace({ initialMode, welcome }: { initialMode: Mode; welcome: boolean }) {
  const store = useStore();
  const { pid, loaded, draft, seq, proposals, renders, assets, segments, edit, save, discard, dirty, undo, redo, toasts, sequences } = store;
  const router = useRouter();
  const [mode, setModeState] = useState<Mode>(initialMode);
  const [preview, setPreview] = useState<PreviewTarget>({ kind: "edit" });
  const [mobileTab, setMobileTab] = useState<MobileTab>(welcome ? "files" : "cue");
  const [dialog, setDialog] = useState<"" | "export" | "versions" | "brief">("");
  const [guide, setGuide] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [leftTab, setLeftTab] = useState<"media" | "transcript" | "tools" | "brief" | "speakers">("media");
  const [rightTab, setRightTab] = useState<"inspect" | "cue">("inspect");
  const [sourceAsset, setSourceAsset] = useState<Asset | null>(null);
  const player = useRef<PlayerHandle>(null);

  useEffect(() => {
    try { if (localStorage.getItem(`cutcue-guide-${pid}`) === "hidden") setGuide(false); } catch { /* storage unavailable */ }
  }, [pid]);
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try { localStorage.setItem("cutcue-mode", m); } catch { /* ignore */ }
    router.replace(`/project/?id=${pid}&mode=${m}`, { scroll: false });
  }, [pid, router]);

  const ws = useMemo(() => ({
    mode, setMode, preview, setPreview, mobileTab, setMobileTab,
    openBrief: () => setDialog("brief"), openExport: () => setDialog("export"), openVersions: () => setDialog("versions"),
  }), [mode, setMode, preview, mobileTab]);

  // What the player shows.
  const source: PlayerSource = useMemo(() => {
    if (preview.kind === "proposal") {
      const s = proposals.find((x) => x.id === preview.id)?.plan.sequences[preview.index];
      if (s) return { kind: "timeline", timeline: s.timeline, label: s.name };
    }
    if (preview.kind === "render") {
      const r = renders.find((x) => x.id === preview.id);
      if (r) {
        const aspect = r.preset && ["tiktok", "reels"].includes(r.preset) ? "9:16" : r.preset === "linkedin" ? "1:1"
          : r.preset === "youtube" ? "16:9" : sequences.find((s) => s.id === r.sequence_id)?.timeline?.aspect;
        return { kind: "render", render: r, label: r.sequence_name ?? "Render", aspect };
      }
    }
    if (draft?.clips.length) return { kind: "timeline", timeline: draft, label: seq?.name ?? "Edit" };
    // Nothing approved yet: show the newest proposal waiting for review.
    const waiting = [...proposals].reverse().find((p) => p.status === "pending");
    if (waiting?.plan.sequences[0]) return { kind: "timeline", timeline: waiting.plan.sequences[0].timeline, label: waiting.title };
    return { kind: "empty", label: assets.some((a) => a.kind === "video" || a.kind === "audio") ? "Ask Cue for an edit, then preview it here." : "Upload a recording to begin." };
  }, [preview, proposals, renders, draft, seq, assets, sequences]);

  // Editing shortcuts (undo/redo everywhere; split/delete/save in Pro).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || dialog) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (mode !== "pro" || !draft) return;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) save(); return; }
      if (mod || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "s") { e.preventDefault(); edit(splitAt(draft, playhead)); }
      if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) {
        e.preventDefault(); edit(removeClip(draft, selected)); setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, draft, playhead, selected, dirty, dialog, edit, save, undo, redo]);

  // Bring the player into view when something new is previewed (desktop scroll position, phone tab).
  const monitor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview.kind === "edit") return;
    const el = monitor.current;
    if (el && el.getBoundingClientRect().top < 64) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [preview]);

  const seekSource = (assetId: string, t: number) => {
    if (!draft) return;
    const i = draft.clips.findIndex((c) => c.asset_id === assetId && t >= c.start && t <= c.end);
    if (i >= 0) { setPreview({ kind: "edit" }); player.current?.seek(outputTime(draft, i, t)); }
  };

  if (!loaded) return <div className="grid min-h-dvh place-items-center text-muted"><Spinner size={22} /></div>;

  const playerEl = <Player ref={player} pid={pid} source={source} assets={assets} segments={segments} onTime={setPlayhead} shortcuts={!dialog} />;
  const showingProposal = preview.kind === "proposal" || (preview.kind === "edit" && !draft?.clips.length && proposals.some((p) => p.status === "pending"));
  const previewBanner = (showingProposal || preview.kind === "render") && (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-xs" data-testid="preview-banner">
      <span>{showingProposal ? "Previewing Cue's proposal: nothing is changed until you approve it." : "Playing a rendered file."}</span>
      {(preview.kind !== "edit" && !!draft?.clips.length) && <button className="btn btn-ghost btn-sm" onClick={() => setPreview({ kind: "edit" })}>Back to your edit</button>}
    </div>
  );
  const pending = proposals.filter((p) => p.status === "pending").length;

  return (
    <WorkspaceCtx.Provider value={ws}>
      <TopBar />
      <main id="main" className="mx-auto w-full max-w-[1600px] space-y-3 px-3 pb-24 pt-3 sm:px-5 lg:pb-5">
        {mode === "simple" && guide && <Onboarding onDismiss={() => { setGuide(false); try { localStorage.setItem(`cutcue-guide-${pid}`, "hidden"); } catch { /* */ } }} />}

        {mode === "simple" ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
            <div className={`space-y-4 ${mobileTab === "cue" ? "hidden lg:block" : ""}`}>
              <section ref={monitor} className={`card scroll-mt-20 space-y-3 p-3 sm:p-4 ${mobileTab === "files" ? "hidden lg:block" : ""}`} aria-label="Preview">
                {previewBanner}
                {playerEl}
              </section>
              <div className={mobileTab === "files" ? "hidden lg:block" : ""}><EditCard /></div>
              <section className={`card space-y-3 p-4 ${mobileTab === "preview" ? "hidden lg:block" : ""}`} aria-labelledby="files-h">
                <h2 id="files-h" className="label">Files</h2>
                <UploadZone compact={assets.length > 0} />
                <FileList />
              </section>
            </div>
            <aside className={`card p-4 lg:sticky lg:top-[4.5rem] lg:block lg:h-[calc(100dvh-5.5rem)] ${mobileTab === "cue" ? "h-[calc(100dvh-10rem)]" : "hidden"}`}>
              <CueChat />
            </aside>
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:h-[calc(100dvh-4.75rem)] lg:grid-rows-[minmax(0,1fr)_auto]">
            <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2 lg:grid-cols-[340px_minmax(0,1fr)_320px]">
              <section className="card flex min-h-0 flex-col gap-2 p-3 md:col-span-2 lg:col-span-1 lg:col-start-2 lg:row-start-1" aria-label="Program monitor">
                {previewBanner}
                <div className="min-h-0 flex-1">{playerEl}</div>
              </section>
              <aside className="card flex min-h-[340px] flex-col gap-3 p-3 lg:col-start-1 lg:row-start-1 lg:min-h-0" aria-label="Media and tools">
                <Tabs label="Panels" value={leftTab} onChange={setLeftTab} size="sm" tabs={[
                  { id: "media", label: "Media" }, { id: "transcript", label: "Transcript" }, { id: "tools", label: "Auto" },
                  { id: "brief", label: "Brief" }, { id: "speakers", label: "Voices" }]} />
                <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" role="tabpanel" aria-labelledby={`tab-${leftTab}`}>
                  {leftTab === "media" && (
                    <div className="space-y-3">
                      <UploadZone compact hint="Drag files here · drag a recording onto the timeline to add it" />
                      <FileList selectable selected={sourceAsset?.id} onSelect={setSourceAsset} />
                    </div>
                  )}
                  {leftTab === "transcript" && <TranscriptEditor playhead={playhead} onSeekSource={seekSource} />}
                  {leftTab === "tools" && (
                    <div className="space-y-5">
                      <div><h3 className="label mb-2">Podcast auto-edit</h3><AutoEditPanel pid={pid} assets={assets} onCreated={() => { store.refresh(); setRightTab("cue"); }} /></div>
                      <div><h3 className="label mb-2">Clip factory</h3><ClipsPanel pid={pid} onCreated={() => { store.refresh(); setRightTab("cue"); }} /></div>
                    </div>
                  )}
                  {leftTab === "brief" && <BriefPanel pid={pid} versionId={dirty ? null : seq?.current_version_id ?? null} />}
                  {leftTab === "speakers" && <SourcePanel pid={pid} asset={sourceAsset ?? assets.find((a) => a.kind === "video" || a.kind === "audio") ?? null} assets={assets} onChanged={store.refresh} />}
                </div>
              </aside>
              <aside className="card flex min-h-[420px] flex-col gap-3 p-3 lg:col-start-3 lg:row-start-1 lg:min-h-0" aria-label="Inspector and Cue">
                <Tabs label="Right panel" value={rightTab} onChange={setRightTab} size="sm" tabs={[
                  { id: "inspect", label: "Inspector", icon: "sliders" }, { id: "cue", label: "Cue", icon: "sparkle", badge: pending }]} />
                <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" role="tabpanel">
                  {rightTab === "inspect" ? (draft ? <Inspector timeline={draft} selected={selected} onEdit={edit} /> : <p className="text-sm text-faint">No edit yet.</p>) : <CueChat />}
                </div>
              </aside>
            </div>
            <section className="card flex flex-col gap-2 p-3" aria-label="Timeline">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex max-w-full gap-1.5 overflow-x-auto scroll-thin" role="tablist" aria-label="Outputs">
                  {sequences.map((s) => (
                    <button key={s.id} role="tab" aria-selected={s.id === seq?.id} className={`btn btn-sm shrink-0 ${s.id === seq?.id ? "border-accent text-violet" : ""}`}
                            onClick={() => { store.setSeqId(s.id); setSelected(null); setPreview({ kind: "edit" }); }}>{s.name.replace(/^Clip (\d+): .*/, "Clip $1")}</button>
                  ))}
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <button className="btn btn-sm" disabled={!draft} onClick={() => draft && edit(splitAt(draft, playhead))} title="Split at playhead (S)"><Icon name="scissors" size={14} /> Split</button>
                  <button className="btn btn-sm" disabled={!draft || selected === null} title="Delete cut (⌫)"
                          onClick={() => { if (draft && selected !== null) { edit(removeClip(draft, selected)); setSelected(null); } }}><Icon name="trash" size={14} /> Delete</button>
                  <button className="btn btn-ghost btn-icon" onClick={undo} disabled={!store.canUndo} aria-label="Undo (⌘Z)"><Icon name="undo" /></button>
                  <button className="btn btn-ghost btn-icon" onClick={redo} disabled={!store.canRedo} aria-label="Redo (⇧⌘Z)"><Icon name="redo" /></button>
                  {dirty && <button className="btn btn-sm" onClick={discard}>Discard</button>}
                  <button className="btn btn-primary btn-sm" disabled={!dirty} onClick={() => save()} title="Save version (⌘S)" data-testid="save-version">
                    {dirty ? <><span className="h-1.5 w-1.5 rounded-full bg-white" /> Save version</> : "Saved"}
                  </button>
                </div>
              </div>
              {draft && draft.clips.length ? (
                <div className="h-[210px]">
                  <Timeline pid={pid} timeline={draft} assets={assets} segments={segments} playhead={playhead}
                            onSeek={(t) => { setPreview({ kind: "edit" }); player.current?.seek(t); setPlayhead(t); }} onEdit={edit} selected={selected} onSelect={setSelected} />
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line2 p-5 text-sm text-muted">
                  No edit yet. Ask Cue for one, or start from the full recording.
                  {assets.filter((a) => (a.kind === "video" || a.kind === "audio") && a.status === "ready").slice(0, 1).map((a) => (
                    <button key={a.id} className="btn btn-sm" onClick={() => store.run(() => api.post(`/projects/${pid}/sequences`, {
                      name: "Main edit", timeline: { aspect: "16:9", clips: [{ asset_id: a.id, start: 0, end: a.duration }], burn_captions: false, normalize_audio: true } }), "Started from the full recording")}>
                      <Icon name="plus" size={14} /> Use {a.original_name}
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {mode === "simple" && (
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 border-t border-line bg-ink/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden" aria-label="Sections">
          {([["cue", "Cue", "sparkle"], ["preview", "Preview", "play"], ["files", "Files", "upload"]] as const).map(([id, label, icon]) => (
            <button key={id} onClick={() => setMobileTab(id)} aria-current={mobileTab === id ? "page" : undefined}
                    className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${mobileTab === id ? "text-violet" : "text-muted"}`}>
              <Icon name={icon} size={20} />{label}
              {id === "cue" && pending > 0 && <span className="absolute right-[calc(50%-18px)] top-2 h-2 w-2 rounded-full bg-violet" aria-label={`${pending} proposal waiting`} />}
            </button>
          ))}
        </nav>
      )}

      <ExportDialog open={dialog === "export"} onClose={() => setDialog("")} />
      <VersionsDialog open={dialog === "versions"} onClose={() => setDialog("")} />
      <Dialog open={dialog === "brief"} onClose={() => setDialog("")} title="Creative brief">
        <BriefPanel pid={pid} versionId={seq?.current_version_id ?? null} />
      </Dialog>
      <Toasts toasts={toasts} />
    </WorkspaceCtx.Provider>
  );
}

function Route() {
  const q = useSearchParams();
  const pid = q.get("id");
  const [mode, setMode] = useState<Mode | null>(null);
  useEffect(() => {
    const fromUrl = q.get("mode");
    let stored: string | null = null;
    try { stored = localStorage.getItem("cutcue-mode"); } catch { /* */ }
    setMode((m) => m ?? (fromUrl === "pro" || fromUrl === "simple" ? fromUrl : stored === "pro" ? "pro" : "simple"));
  }, [q]);
  if (!pid) return <p className="p-8 text-muted">Missing project. <Link href="/" className="text-violet underline">Back to projects</Link></p>;
  if (!mode) return null;
  return <ProjectProvider pid={pid}><Workspace initialMode={mode} welcome={q.get("welcome") === "1"} /></ProjectProvider>;
}

export default function Page() {
  return <AuthGate><Suspense fallback={null}><Route /></Suspense></AuthGate>;
}
