"use client";
// Public upload page (/upload/?t=TOKEN): send photos/videos straight into one project from a phone.
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Icon, Logo, Progress, Spinner } from "@/components/ui";

const CHUNK = 8 * 1024 * 1024;
type Item = { name: string; progress: number; state: "uploading" | "done" | "error"; error?: string };

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Upload failed");
  return data as T;
}

function Upload() {
  const token = useSearchParams().get("t") ?? "";
  const base = `/api/public/upload/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<{ project_name: string; uses_left: number } | null>(null);
  const [error, setError] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!token) { setError("This upload link is incomplete."); return; }
    fetch(base).then((r) => j<{ project_name: string; uses_left: number }>(r)).then(setInfo).catch((e) => setError(e.message));
  }, [base, token]);
  const set = (name: string, patch: Partial<Item>) => setItems((all) => all.map((i) => (i.name === name ? { ...i, ...patch } : i)));
  const send = async (files: FileList) => {
    for (const f of Array.from(files)) {
      setItems((all) => [...all, { name: f.name, progress: 0, state: "uploading" }]);
      try {
        const up = await j<{ id: string }>(await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: f.name, size: f.size }) }));
        let offset = 0, failures = 0;
        while (offset < f.size) {
          try {
            const r = await j<{ received: number }>(await fetch(`${base}/${up.id}?offset=${offset}`, { method: "PUT", body: f.slice(offset, offset + CHUNK),
              headers: { "Content-Type": "application/octet-stream" } }));
            offset = r.received; failures = 0; set(f.name, { progress: offset / f.size });
          } catch (err) {
            if (++failures > 4) throw err;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
            offset = (await j<{ received: number }>(await fetch(`${base}/${up.id}`))).received;
          }
        }
        await j(await fetch(`${base}/${up.id}/complete`, { method: "POST" }));
        set(f.name, { state: "done", progress: 1 });
      } catch (err) { set(f.name, { state: "error", error: (err as Error).message }); }
    }
  };
  if (error) return <main id="main" className="mx-auto grid min-h-dvh max-w-md place-items-center px-6 text-center"><div className="space-y-3"><div className="flex justify-center"><Logo product="cue" /></div><p role="alert" className="font-medium">{error}</p><p className="text-sm text-muted">Ask for a new upload link.</p></div></main>;
  if (!info) return <div className="grid min-h-dvh place-items-center text-muted"><Spinner size={22} /></div>;
  return (
    <main id="main" className="mx-auto max-w-md space-y-5 px-4 py-6">
      <Logo product="cue" />
      <div><h1 className="text-xl font-semibold">Send files to “{info.project_name}”</h1><p className="text-sm text-muted">Photos, videos, audio or a brief. They go straight to the editor.</p></div>
      <button className="btn btn-primary min-h-12 w-full text-base" onClick={() => input.current?.click()}><Icon name="upload" /> Choose files</button>
      <input ref={input} type="file" multiple hidden accept="video/*,audio/*,image/jpeg,image/png,.pdf,.docx,.txt" onChange={(e) => { if (e.target.files) send(e.target.files); e.target.value = ""; }} />
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.name} className="rounded-xl border border-line bg-panel p-3 text-sm">
            <div className="flex justify-between gap-2"><span className="truncate">{i.name}</span>
              <span className={i.state === "error" ? "text-danger" : i.state === "done" ? "text-ok" : "text-muted"}>{i.state === "done" ? "Sent" : i.state === "error" ? "Failed" : `${Math.round(i.progress * 100)}%`}</span></div>
            {i.state === "uploading" && <div className="mt-2"><Progress value={i.progress} label={`Uploading ${i.name}`} /></div>}
            {i.error && <p role="alert" className="mt-1 text-xs text-danger">{i.error}</p>}
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function Page() {
  return <Suspense fallback={null}><Upload /></Suspense>;
}
