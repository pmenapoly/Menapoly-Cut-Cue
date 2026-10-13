"use client";
import { useRef, useState } from "react";
import { api, ApiError, Asset, fmtBytes, fmtTime, thumbUrl, uploadFile } from "@/lib/api";

type Pending = { name: string; progress: number; error?: string };

const ACCEPT = ".mp4,.mov,.m4v,.mkv,.webm,.avi,.mts,.wav,.mp3,.m4a,.aac,.flac,.ogg,.aiff,.aif,.jpg,.jpeg,.png,.pdf,.docx,.txt,.md,.srt,.vtt";

export default function AssetPanel({ pid, assets, selectedId, onSelect, onChange }: {
  pid: string; assets: Asset[]; selectedId: string | null;
  onSelect: (a: Asset) => void; onChange: () => void;
}) {
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const start = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Date.now()}`;
      setPending((p) => ({ ...p, [key]: { name: file.name, progress: 0 } }));
      uploadFile(pid, file, (f) => setPending((p) => ({ ...p, [key]: { ...p[key], progress: f } })))
        .then(() => {
          setPending((p) => { const n = { ...p }; delete n[key]; return n; });
          onChange();
        })
        .catch((err) => setPending((p) => ({ ...p, [key]: { ...p[key], error: err instanceof ApiError ? err.message : String(err) } })));
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div
        className={`mb-2 rounded-lg border border-dashed p-3 text-center text-sm ${drag ? "border-accent bg-panel2" : "border-line"}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); start(e.dataTransfer.files); }}
      >
        <p className="text-muted">Drop video, audio, briefs (PDF/DOCX/TXT) or captions (SRT/VTT)</p>
        <button className="btn btn-sm mt-2" onClick={() => input.current?.click()}>Choose files</button>
        <input ref={input} type="file" multiple hidden accept={ACCEPT}
               onChange={(e) => { if (e.target.files) start(e.target.files); e.target.value = ""; }} />
      </div>
      {Object.entries(pending).map(([k, p]) => (
        <div key={k} className="mb-1 rounded border border-line px-2 py-1 text-xs">
          <div className="flex justify-between gap-2">
            <span className="truncate">{p.name}</span>
            {p.error ? (
              <button className="text-muted" onClick={() => setPending((s) => { const n = { ...s }; delete n[k]; return n; })}>✕</button>
            ) : <span>{Math.round(p.progress * 100)}%</span>}
          </div>
          {p.error ? <div className="text-danger">{p.error}</div> : (
            <div className="mt-1 h-1 rounded bg-line"><div className="h-1 rounded bg-accent" style={{ width: `${p.progress * 100}%` }} /></div>
          )}
        </div>
      ))}
      <ul className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto">
        {assets.map((a) => (
          <li key={a.id}>
            <button
              onClick={() => onSelect(a)}
              className={`flex w-full items-center gap-2 rounded-md border p-1.5 text-left ${selectedId === a.id ? "border-accent bg-panel2" : "border-transparent hover:bg-panel2"}`}
            >
              <div className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-ink text-[10px] uppercase text-muted">
                {a.thumb_name ? <img src={thumbUrl(pid, a.id)} alt="" className="h-full w-full object-cover" /> : a.kind}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{a.original_name}</div>
                <div className="flex flex-wrap gap-x-2 text-[11px] text-muted">
                  {a.duration ? <span>{fmtTime(a.duration)}</span> : null}
                  <span>{fmtBytes(a.size)}</span>
                  <span className={a.status === "ready" ? "text-ok" : a.status === "error" ? "text-danger" : "text-accent"}>{a.status}</span>
                  {a.has_transcript && <span className="text-accent2">transcript</span>}
                </div>
                {a.error && <div className="truncate text-[11px] text-danger" title={a.error}>{a.error}</div>}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {selectedId && (
        <button className="btn btn-sm mt-2 self-start" onClick={async () => {
          const a = assets.find((x) => x.id === selectedId);
          if (a && confirm(`Remove ${a.original_name} from this project?`)) {
            await api.del(`/projects/${pid}/assets/${a.id}`);
            onChange();
          }
        }}>Remove selected</button>
      )}
    </div>
  );
}
