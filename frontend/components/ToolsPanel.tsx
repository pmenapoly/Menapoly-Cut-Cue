"use client";
// Podcast Auto-Editor, AI Clip Factory, Creative Brief and per-source tools (speakers, processed audio).
// Every action creates a proposal that appears in the chat panel for approval.
import { useEffect, useState } from "react";
import { api, ApiError, Asset, Brief, Compliance, fmtTime, Speakers } from "@/lib/api";

function useError() {
  const [error, setError] = useState("");
  const wrap = async (fn: () => Promise<unknown>) => {
    setError("");
    try { await fn(); } catch (err) { setError(err instanceof ApiError ? [err.message, ...err.problems].join("; ") : String(err)); }
  };
  return { error, wrap };
}

const Err = ({ error }: { error: string }) => (error ? <p className="mt-1 text-xs text-danger">{error}</p> : null);

export function AutoEditPanel({ pid, assets, onCreated }: { pid: string; assets: Asset[]; onCreated: () => void }) {
  const media = assets.filter((a) => (a.kind === "video" || a.kind === "audio") && a.has_transcript);
  const [assetId, setAssetId] = useState("");
  const [opts, setOpts] = useState({ tighten_pauses: true, remove_fillers: true, trim_dead_air: true, same_speaker_pause: 0.35, turn_pause: 0.6 });
  const [busy, setBusy] = useState(false);
  const { error, wrap } = useError();
  const target = assetId || media[0]?.id || "";
  if (!media.length) return <p className="text-sm text-muted">Upload a podcast and wait for its transcript.</p>;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">Speaker-aware rough cut: pauses shortened between words (turns and questions keep a natural beat), fillers and dead air removed. Only silent audio is cut.</p>
      <select className="input" value={target} onChange={(e) => setAssetId(e.target.value)}>
        {media.map((a) => <option key={a.id} value={a.id}>{a.original_name}</option>)}
      </select>
      <div className="flex flex-wrap gap-3">
        {(["tighten_pauses", "remove_fillers", "trim_dead_air"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1">
            <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {k.replaceAll("_", " ")}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-1">Same-speaker pause
          <input className="input w-20" type="number" step="0.05" min="0.1" max="2" value={opts.same_speaker_pause}
                 onChange={(e) => setOpts({ ...opts, same_speaker_pause: Number(e.target.value) })} />s</label>
        <label className="flex items-center gap-1">Turn pause
          <input className="input w-20" type="number" step="0.05" min="0.1" max="3" value={opts.turn_pause}
                 onChange={(e) => setOpts({ ...opts, turn_pause: Number(e.target.value) })} />s</label>
      </div>
      <button className="btn btn-primary" disabled={busy || !target} onClick={() => wrap(async () => {
        setBusy(true);
        try { await api.post(`/projects/${pid}/auto-edit`, { asset_id: target, options: opts }); onCreated(); } finally { setBusy(false); }
      })}>{busy ? "Analysing…" : "Propose auto-edit"}</button>
      <Err error={error} />
    </div>
  );
}

type Moment = { start: number; end: number; est_duration: number; score: number; first_line: string; reasons: string[] };

export function ClipsPanel({ pid, onCreated }: { pid: string; onCreated: () => void }) {
  const [form, setForm] = useState<{ count?: number; min_s?: number; max_s?: number; titles: boolean }>({ titles: true });
  const [preview, setPreview] = useState<{ settings: { count: number; min_s: number; max_s: number; from_brief: boolean }; candidates: Moment[]; chosen: Moment[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const { error, wrap } = useError();
  const params = new URLSearchParams(Object.entries(form).filter(([k, v]) => k !== "titles" && v).map(([k, v]) => [k, String(v)]));
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">Finds self-contained moments (strong opener, proof, brief keywords) and makes 9:16 clips with captions. Blank fields use the brief.</p>
      <div className="flex flex-wrap gap-2">
        {(["count", "min_s", "max_s"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1">{k === "count" ? "Clips" : k === "min_s" ? "Min s" : "Max s"}
            <input className="input w-20" type="number" min={1} value={form[k] ?? ""}
                   onChange={(e) => setForm({ ...form, [k]: e.target.value ? Number(e.target.value) : undefined })} /></label>
        ))}
        <label className="flex items-center gap-1"><input type="checkbox" checked={form.titles} onChange={(e) => setForm({ ...form, titles: e.target.checked })} /> titles</label>
      </div>
      <div className="flex gap-2">
        <button className="btn" onClick={() => wrap(async () => setPreview(await api.get(`/projects/${pid}/moments?${params}`)))}>Preview moments</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => wrap(async () => {
          setBusy(true);
          try { await api.post(`/projects/${pid}/clip-factory`, form); onCreated(); } finally { setBusy(false); }
        })}>{busy ? "Scoring…" : "Propose clips"}</button>
      </div>
      <Err error={error} />
      {preview && (
        <div className="space-y-1">
          <p className="text-xs text-muted">{preview.settings.count} clips, {preview.settings.min_s}-{preview.settings.max_s}s ({preview.settings.from_brief ? "from brief" : "defaults"})</p>
          <ul className="scroll-thin max-h-48 space-y-1 overflow-y-auto">
            {preview.candidates.map((c) => {
              const picked = preview.chosen.some((x) => x.start === c.start && x.end === c.end);
              return (
                <li key={`${c.start}-${c.end}`} className={`rounded border p-1.5 text-xs ${picked ? "border-accent" : "border-line"}`}>
                  <div><span className="font-mono text-violet">{fmtTime(c.start)}–{fmtTime(c.end)}</span> · ~{c.est_duration.toFixed(0)}s · score {c.score.toFixed(1)}</div>
                  <div>“{c.first_line}”</div>
                  <div className="text-muted">{c.reasons.join(" · ")}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const listFields = ["key_messages", "must_include", "must_avoid", "tone"] as const;

export function BriefPanel({ pid, versionId }: { pid: string; versionId: string | null }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [comp, setComp] = useState<Compliance | null>(null);
  const { error, wrap } = useError();
  const load = () => api.get<Brief>(`/projects/${pid}/brief`).then(setBrief);
  useEffect(() => { load(); }, [pid]);
  useEffect(() => {
    setComp(null);
    if (versionId) api.get<Compliance>(`/projects/${pid}/versions/${versionId}/compliance`).then(setComp).catch(() => {});
  }, [pid, versionId, brief]);
  if (!brief) return <p className="text-sm text-muted">Loading…</p>;
  const r = brief.requirements;
  return (
    <div className="space-y-2 text-sm">
      {!brief.has_brief && <p className="text-muted">Upload a brief (PDF, DOCX, TXT) or add requirements here.</p>}
      {brief.sources.length > 0 && <p className="text-xs text-muted">From: {brief.sources.map((s) => s.name).join(", ")}{brief.override_source ? ` · edited (${brief.override_source})` : ""}</p>}
      {edit ? (
        <div className="space-y-1">
          <label className="block"><span className="label">CTA</span>
            <input className="input" value={edit.cta} onChange={(e) => setEdit({ ...edit, cta: e.target.value })} /></label>
          {listFields.map((k) => (
            <label key={k} className="block"><span className="label">{k.replace("_", " ")} (one per line)</span>
              <textarea className="input" rows={2} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></label>
          ))}
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => wrap(async () => {
              const fields: Record<string, unknown> = { cta: edit.cta };
              for (const k of listFields) fields[k] = edit[k].split("\n").map((x) => x.trim()).filter(Boolean);
              setBrief(await api.patch<Brief>(`/projects/${pid}/brief`, { fields }));
              setEdit(null);
            })}>Save</button>
            <button className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
            {r.client && <><dt className="text-muted">Client</dt><dd>{r.client}</dd></>}
            <dt className="text-muted">Deliverables</dt>
            <dd>{(r.deliverables ?? []).map((d, i) => (
              <div key={i}>{d.count}× {d.kind} {d.aspect}{d.max_s ? ` ${d.min_s ?? 0}-${d.max_s}s` : ""}{d.captions ? " · captions" : ""}{d.platforms.length ? ` · ${d.platforms.join("/")}` : ""}</div>
            ))}{!r.deliverables?.length && "—"}</dd>
            {listFields.map((k) => (r[k]?.length ? <><dt key={`${k}t`} className="text-muted">{k.replace("_", " ")}</dt><dd key={k}>{r[k]!.join(" · ")}</dd></> : null))}
            {r.cta && <><dt className="text-muted">CTA</dt><dd>{r.cta}</dd></>}
            {r.loudness_target != null && <><dt className="text-muted">Loudness</dt><dd>{r.loudness_target} LUFS</dd></>}
          </dl>
          <button className="btn btn-sm" onClick={() => setEdit({ cta: r.cta ?? "", ...Object.fromEntries(listFields.map((k) => [k, (r[k] ?? []).join("\n")])) })}>Edit requirements</button>
        </>
      )}
      <Err error={error} />
      {comp && comp.checks.length > 0 && (
        <div className="rounded border border-line p-2">
          <div className="label mb-1">Current version vs brief: {comp.summary}</div>
          <ul className="space-y-0.5 text-xs">
            {comp.checks.map((c) => (
              <li key={c.check}><span className={c.status === "pass" ? "text-ok" : c.status === "fail" ? "text-danger" : c.status === "warn" ? "text-accent" : "text-muted"}>{c.status}</span> {c.check}: <span className="text-muted">{c.detail}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SourcePanel({ pid, asset, assets, onChanged }: { pid: string; asset: Asset | null; assets: Asset[]; onChanged: () => void }) {
  const [speakers, setSpeakers] = useState<Speakers | null>(null);
  const [processed, setProcessed] = useState("");
  const [count, setCount] = useState("");
  const { error, wrap } = useError();
  const media = asset && (asset.kind === "video" || asset.kind === "audio");
  useEffect(() => {
    setSpeakers(null);
    if (media) api.get<Speakers>(`/projects/${pid}/assets/${asset!.id}/speakers`).then(setSpeakers).catch(() => {});
  }, [pid, asset?.id, asset?.has_transcript]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!media) return <p className="text-sm text-muted">Select a video or audio file in the media list.</p>;
  const audioAssets = assets.filter((a) => a.id !== asset!.id && a.has_audio && a.status === "ready");
  const patch = (key: string, value: Record<string, unknown>) =>
    wrap(async () => setSpeakers(await api.patch<Speakers>(`/projects/${pid}/assets/${asset!.id}/speakers`, { labels: { [key]: value } })));
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="label mb-1">Speakers · {asset!.original_name}</div>
        {!speakers?.method ? <p className="text-xs text-muted">Speakers are identified after transcription.</p> : (
          <>
            <p className="text-xs text-muted">Method: {speakers.method}{speakers.method === "acoustic" ? ` (confidence ${speakers.confidence})` : " (one speaker per stereo channel)"}</p>
            <ul className="mt-1 space-y-1">
              {Object.entries(speakers.labels).map(([key, l]) => (
                <li key={key} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-violet">{key}</span>
                  <input className="input w-28 py-0.5" defaultValue={l.name} onBlur={(e) => e.target.value !== l.name && patch(key, { name: e.target.value })} />
                  <span className="text-xs text-muted">{fmtTime(l.talk_seconds)}</span>
                  <label className="flex items-center gap-1 text-xs" title="Horizontal framing for vertical clips">frame
                    <input type="range" min={0} max={1} step={0.05} defaultValue={l.focus_x} onMouseUp={(e) => patch(key, { focus_x: Number((e.target as HTMLInputElement).value) })}
                           onTouchEnd={(e) => patch(key, { focus_x: Number((e.target as HTMLInputElement).value) })} /></label>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-1 flex items-center gap-2">
          <input className="input w-20 py-0.5" type="number" min={1} max={6} placeholder="auto" value={count} onChange={(e) => setCount(e.target.value)} />
          <button className="btn btn-sm" disabled={!asset!.has_transcript} onClick={() => wrap(async () => {
            await api.post(`/projects/${pid}/assets/${asset!.id}/diarize`, { num_speakers: count ? Number(count) : null }); onChanged();
          })}>Re-detect speakers</button>
        </div>
      </div>
      <div>
        <div className="label mb-1">Processed audio (WAV hand-off)</div>
        <p className="text-xs text-muted">Export this source&apos;s audio, clean it in another tool, upload the result, then attach it. Offset is detected; mismatched files are rejected.</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <a className="btn btn-sm" href={`/api/projects/${pid}/assets/${asset!.id}/audio.wav`}>Export WAV</a>
          {asset!.audio_override_id ? (
            <>
              <span className="text-xs text-ok">Using {assets.find((a) => a.id === asset!.audio_override_id)?.original_name ?? "processed audio"} (offset {asset!.audio_offset ?? 0}s)</span>
              <button className="btn btn-sm" onClick={() => wrap(async () => { await api.del(`/projects/${pid}/assets/${asset!.id}/processed-audio`); onChanged(); })}>Detach</button>
            </>
          ) : (
            <>
              <select className="input py-0.5" value={processed} onChange={(e) => setProcessed(e.target.value)}>
                <option value="">Choose uploaded audio…</option>
                {audioAssets.map((a) => <option key={a.id} value={a.id}>{a.original_name}</option>)}
              </select>
              <button className="btn btn-sm" disabled={!processed} onClick={() => wrap(async () => {
                await api.post(`/projects/${pid}/assets/${asset!.id}/processed-audio`, { audio_asset_id: processed }); onChanged();
              })}>Attach</button>
            </>
          )}
        </div>
      </div>
      <Err error={error} />
    </div>
  );
}
