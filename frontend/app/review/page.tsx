"use client";
// Public client review page (/review/?t=TOKEN). No owner sign-in: access is the hashed, expiring, revocable token.
import { useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Icon, Logo, Spinner, StatusPill } from "@/components/ui";
import { duration, timeAgo } from "@/lib/format";
import { ReviewEvent } from "@/lib/cue";

type View = { project_name: string; label: string; duration: number | null; allow_download: boolean; has_captions: boolean;
  expires_at: number; events: ReviewEvent[] };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/public/review/${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Something went wrong. Try again.");
  return data as T;
}

function Review() {
  const token = useSearchParams().get("t") ?? "";
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [atTime, setAtTime] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<"approved" | "changes_requested" | null>(null);
  const [message, setMessage] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const base = encodeURIComponent(token);
  const load = useCallback(() => call<View>(base).then(setView).catch((e) => setError(e.message)), [base]);
  useEffect(() => {
    if (!token) { setError("This review link is incomplete. Open the full link you were sent."); return; }
    load();
    try { setName(localStorage.getItem("cue-reviewer") ?? ""); } catch { /* ignore */ }
  }, [token, load]);

  const post = async (kind: "comment" | "approved" | "changes_requested", e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setMessage("");
    try {
      try { localStorage.setItem("cue-reviewer", name); } catch { /* ignore */ }
      const t = video.current?.currentTime ?? 0;
      await call(`${base}/events`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, author: name, body: note, at_seconds: kind === "approved" || !atTime ? null : Math.round(t * 10) / 10 }) });
      setNote(""); setDeciding(null);
      setMessage(kind === "approved" ? "Thanks! The editor has been told you approved it." : kind === "changes_requested" ? "Sent. The editor will work on your changes." : "Note sent.");
      load();
    } catch (err) { setMessage((err as Error).message); }
    setBusy(false);
  };

  if (error) return (
    <main id="main" className="mx-auto grid min-h-dvh max-w-md place-items-center px-6 text-center">
      <div className="space-y-3"><div className="flex justify-center"><Logo product="cue" /></div><p role="alert" className="font-medium">{error}</p>
        <p className="text-sm text-muted">Ask the person who sent it for a new link.</p></div>
    </main>
  );
  if (!view) return <div className="grid min-h-dvh place-items-center text-muted"><Spinner size={22} /></div>;
  const decided = [...view.events].reverse().find((e) => e.kind !== "comment");
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between gap-3 py-4"><Logo product="cue" /><span className="text-xs text-muted">Private review link</span></header>
      <main id="main" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{view.project_name}</h1>
          <p className="text-sm text-muted">{view.label}{view.duration ? ` · ${duration(view.duration)}` : ""}</p>
          <video ref={video} controls playsInline preload="metadata" className="aspect-video w-full rounded-2xl bg-black" data-testid="review-video">
            <source src={`/api/public/review/${base}/media`} type="video/mp4" />
            {view.has_captions && <track kind="captions" src={`/api/public/review/${base}/captions`} srcLang="en" label="Captions" />}
            Your browser can&apos;t play this video. {view.allow_download ? "Use the download button instead." : ""}
          </video>
          {view.allow_download && <a className="btn min-h-11" href={`/api/public/review/${base}/download`}><Icon name="download" /> Download video</a>}
        </div>
        <aside className="min-w-0 space-y-4">
          {decided && <StatusPill label={decided.kind === "approved" ? `Approved by ${decided.author}` : `Changes requested by ${decided.author}`} tone={decided.kind === "approved" ? "ok" : "warn"} />}
          <form className="card space-y-3 p-4" onSubmit={(e) => post("comment", e)}>
            <label className="block space-y-1"><span className="label">Your name</span>
              <input className="input min-h-11" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} /></label>
            <label className="block space-y-1"><span className="label">Note</span>
              <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000}
                        placeholder="What should change? Pause the video where it matters." /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} /> Pin to the current moment in the video</label>
            <button className="btn min-h-11 w-full" disabled={busy || !name.trim() || !note.trim()}>{busy ? <Spinner /> : <Icon name="chat" />} Send note</button>
          </form>
          <div className="card space-y-2 p-4">
            <p className="text-sm font-medium">Ready to decide?</p>
            {deciding ? (
              <div className="space-y-2 text-sm">
                <p>{deciding === "approved" ? "Approve this version as final?" : "Send this as a change request? Write what should change in the note above."}</p>
                <div className="flex gap-2">
                  <button className="btn btn-primary min-h-11" disabled={busy || !name.trim() || (deciding === "changes_requested" && !note.trim())} onClick={() => post(deciding)}>Confirm</button>
                  <button className="btn min-h-11" onClick={() => setDeciding(null)}>Back</button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button className="btn btn-primary min-h-11" onClick={() => setDeciding("approved")}><Icon name="check" /> Approve</button>
                <button className="btn min-h-11" onClick={() => setDeciding("changes_requested")}>Request changes</button>
              </div>
            )}
          </div>
          {message && <p role="status" className="text-sm">{message}</p>}
          <section aria-label="Notes" className="space-y-2">
            <h2 className="text-sm font-semibold text-muted">Notes ({view.events.length})</h2>
            {view.events.length === 0 ? <p className="text-sm text-muted">No notes yet.</p> : (
              <ul className="space-y-2">
                {view.events.map((e) => (
                  <li key={e.id} className="rounded-xl border border-line bg-panel p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span className="font-semibold text-text">{e.author}</span>
                      {e.kind !== "comment" && <StatusPill label={e.kind === "approved" ? "Approved" : "Requested changes"} tone={e.kind === "approved" ? "ok" : "warn"} />}
                      {e.at_seconds != null && <button className="text-violet underline" onClick={() => { if (video.current) { video.current.currentTime = e.at_seconds!; video.current.focus(); } }}>at {duration(e.at_seconds)}</button>}
                      <span>{timeAgo(e.created_at)}</span>{e.resolved_at && <span className="text-ok">done</span>}
                    </div>
                    {e.body && <p className="mt-1 whitespace-pre-wrap">{e.body}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><Review /></Suspense>;
}
