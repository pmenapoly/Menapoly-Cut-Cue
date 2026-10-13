"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { api, ApiError, Health, Project } from "@/lib/api";

function Status({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok ? "bg-ok" : "bg-danger"}`} />
      <div>
        <div>{label}</div>
        {detail && <div className="text-xs text-muted">{detail}</div>}
      </div>
    </div>
  );
}

function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = () => {
    api.get<Health>("/health").then(setHealth).catch(() => setHealth(null));
    api.get<Project[]>("/projects").then(setProjects).catch((e) => setError(String(e.message ?? e)));
  };
  useEffect(load, []);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Menapoly Cut Cue</h1>
          <p className="text-sm text-muted">Upload media and a brief, then edit by chatting.</p>
        </div>
        {health && <span className="text-xs text-muted">v{health.version}</span>}
      </header>

      <section className="mb-8 grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="card p-4">
          <h2 className="label mb-3">New project</h2>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const p = await api.post<Project>("/projects", { name });
                window.location.href = `/project/?id=${p.id}`;
              } catch (err) {
                setError(err instanceof ApiError ? err.message : String(err));
              }
            }}
          >
            <input className="input min-w-0 flex-1" placeholder="e.g. Market Mocha Test" value={name}
                   onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary" disabled={!name.trim()}>Create</button>
          </form>
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </div>
        <div className="card space-y-2 p-4">
          <h2 className="label mb-1">System</h2>
          {!health ? <Status ok={false} label="API server not reachable" /> : (
            <>
              <Status ok={health.ffmpeg && health.ffprobe} label="FFmpeg / FFprobe" detail={health.ffmpeg ? "installed" : "brew install ffmpeg"} />
              <Status ok={health.assistant_mode === "claude"} label={health.assistant_mode === "claude" ? "Claude connected" : "Local test mode"}
                      detail={health.assistant_mode === "claude" ? health.claude_model ?? "" : "Set ANTHROPIC_API_KEY in .env for Claude"} />
              <Status ok={health.transcriber !== "none"} label={`Transcription: ${health.transcriber}`}
                      detail={health.transcriber === "faster-whisper" ? `Whisper '${health.whisper_model}' on CPU` : undefined} />
              <Status ok label={`Processing: local${health.cloud_configured ? " (cloud available per project)" : ""}`} />
            </>
          )}
        </div>
      </section>

      <section>
        <h2 className="label mb-3">Projects</h2>
        {projects.length === 0 ? (
          <p className="text-sm text-muted">No projects yet.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <li key={p.id} className="card flex items-center justify-between p-4">
                <Link href={`/project/?id=${p.id}`} className="min-w-0">
                  <div className="truncate font-medium hover:text-accent">{p.name}</div>
                  <div className="text-xs text-muted">
                    {p.asset_count ?? 0} files · {new Date(p.created_at * 1000).toLocaleDateString()} · AI spend ${p.spent_usd.toFixed(2)}
                  </div>
                </Link>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    if (!confirm(`Delete "${p.name}" and all its files?`)) return;
                    await api.del(`/projects/${p.id}`);
                    load();
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}
