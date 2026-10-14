"use client";
// Version history with before/after comparison (two instant previews side by side) and restore.
import { useEffect, useState } from "react";
import { api, Compare, Timeline } from "@/lib/api";
import { duration, timeAgo } from "@/lib/format";
import { useStore } from "@/lib/project";
import { Player } from "./Player";
import { Dialog, Icon } from "./ui";

export function VersionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pid, seq, assets, segments, run } = useStore();
  const versions = seq ? [...seq.versions].reverse() : [];
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [tl, setTl] = useState<Record<string, Timeline>>({});
  const [cmp, setCmp] = useState<Compare | null>(null);

  useEffect(() => {
    if (!open || !seq) return;
    const cur = seq.current_version_id;
    const idx = seq.versions.findIndex((v) => v.id === cur);
    setB(cur);
    setA(idx > 0 ? seq.versions[idx - 1].id : null);
  }, [open, seq?.id, seq?.current_version_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const id of [a, b]) {
      if (id && !tl[id]) api.get<{ timeline: Timeline }>(`/projects/${pid}/versions/${id}`).then((v) => setTl((t) => ({ ...t, [id]: v.timeline })));
    }
    setCmp(null);
    if (a && b && a !== b) api.get<Compare>(`/projects/${pid}/compare?a=${a}&b=${b}`).then(setCmp);
  }, [a, b, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (id: string | null) => seq?.versions.find((v) => v.id === id)?.number;
  return (
    <Dialog open={open} onClose={onClose} title={seq ? `History · ${seq.name}` : "History"} wide>
      {!seq ? <p className="text-sm text-muted">No edit yet.</p> : (
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          <ol className="space-y-1.5" aria-label="Versions">
            {versions.map((v) => {
              const current = v.id === seq.current_version_id;
              return (
                <li key={v.id} className={`rounded-xl border p-2.5 text-sm ${current ? "border-accent/60 bg-accent-soft" : "border-line bg-panel2"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Version {v.number}{current && <span className="ml-1.5 text-xs text-violet">current</span>}</span>
                    <span className="text-[11px] text-faint">{timeAgo(v.created_at)}</span>
                  </div>
                  <p className="truncate text-xs text-muted" title={v.label}>{v.label}</p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button className={`btn btn-sm ${a === v.id ? "border-accent text-violet" : ""}`} aria-pressed={a === v.id} onClick={() => setA(v.id)}>Before</button>
                    <button className={`btn btn-sm ${b === v.id ? "border-accent text-violet" : ""}`} aria-pressed={b === v.id} onClick={() => setB(v.id)}>After</button>
                    {!current && (
                      <button className="btn btn-sm ml-auto" onClick={() => run(() => api.post(`/projects/${pid}/versions/${v.id}/restore`), `Restored version ${v.number}`)}>
                        <Icon name="history" size={13} /> Restore
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="space-y-3">
            {!a || !b || a === b ? (
              <p className="rounded-xl border border-line p-4 text-sm text-muted">Pick a “Before” and an “After” version to compare them side by side.</p>
            ) : (
              <>
                <div className="grid gap-3 md:grid-cols-2" data-testid="compare-view">
                  {[a, b].map((id, i) => (
                    <div key={id} className="space-y-1.5">
                      <p className="label">{i === 0 ? "Before" : "After"} · version {num(id)}</p>
                      {tl[id] ? <Player pid={pid} source={{ kind: "timeline", timeline: tl[id], label: "" }} assets={assets} segments={segments} compact shortcuts={false} />
                        : <div className="skeleton aspect-video" />}
                    </div>
                  ))}
                </div>
                {cmp && (
                  <div className="rounded-xl border border-line bg-panel2 p-3 text-sm">
                    <p>
                      Length {duration(cmp.a.duration)} → <span className="font-medium">{duration(cmp.b.duration)}</span>
                      {" "}({cmp.b.duration - cmp.a.duration >= 0 ? "+" : "−"}{Math.abs(cmp.b.duration - cmp.a.duration).toFixed(1)} s) · cuts {cmp.a.clips} → {cmp.b.clips}
                      {cmp.a.aspect !== cmp.b.aspect && ` · format ${cmp.a.aspect} → ${cmp.b.aspect}`}
                    </p>
                    {cmp.only_in_a.length > 0 && <p className="mt-1 text-xs text-danger">Removed: {cmp.only_in_a.slice(0, 6).map((c) => `${duration(c.start)}–${duration(c.end)}`).join(", ")}{cmp.only_in_a.length > 6 ? "…" : ""}</p>}
                    {cmp.only_in_b.length > 0 && <p className="mt-1 text-xs text-ok">Added: {cmp.only_in_b.slice(0, 6).map((c) => `${duration(c.start)}–${duration(c.end)}`).join(", ")}{cmp.only_in_b.length > 6 ? "…" : ""}</p>}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
