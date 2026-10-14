"use client";
// Cue Pro inspector: selected cut (in/out, framing) and the whole edit (format, captions, title, audio).
import { AudioSettings, DEFAULT_AUDIO, Timeline } from "@/lib/api";
import { duration } from "@/lib/format";
import { useStore } from "@/lib/project";
import { clipLength, updateClip } from "@/lib/timeline";
import { Icon } from "./ui";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1"><span className="label">{label}</span>{children}</label>;
}

export function Inspector({ timeline, selected, onEdit }: { timeline: Timeline; selected: number | null; onEdit: (t: Timeline) => void }) {
  const { assets } = useStore();
  const clip = selected !== null ? timeline.clips[selected] : null;
  const asset = clip ? assets.find((a) => a.id === clip.asset_id) : null;
  const audio: AudioSettings = { ...DEFAULT_AUDIO, ...timeline.audio };
  const setAudio = (patch: Partial<AudioSettings>) => onEdit({ ...timeline, audio: { ...audio, ...patch } });
  const music = assets.filter((a) => a.has_audio && a.status === "ready");
  return (
    <div className="space-y-5 text-sm">
      <section aria-labelledby="clip-h" className="space-y-3">
        <h3 id="clip-h" className="label">Selected cut</h3>
        {!clip ? <p className="text-xs text-faint">Click a cut on the timeline to adjust it.</p> : (
          <>
            <p className="truncate text-xs text-muted">{asset?.original_name} · {duration(clipLength(clip))}</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Starts at (s)">
                <input className="input" type="number" step={0.05} min={0} value={clip.start}
                       onChange={(e) => onEdit(updateClip(timeline, selected!, { start: Math.max(0, Math.min(Number(e.target.value), clip.end - 0.1)) }))} />
              </Field>
              <Field label="Ends at (s)">
                <input className="input" type="number" step={0.05} value={clip.end}
                       onChange={(e) => onEdit(updateClip(timeline, selected!, { end: Math.min(asset?.duration ?? 1e9, Math.max(Number(e.target.value), clip.start + 0.1)) }))} />
              </Field>
            </div>
            {timeline.aspect !== "16:9" && (
              <Field label="Framing (who to keep in shot)">
                <input type="range" min={0} max={1} step={0.05} value={clip.focus_x ?? 0.5} className="w-full accent-[#8b7cf8]"
                       onChange={(e) => onEdit(updateClip(timeline, selected!, { focus_x: Number(e.target.value) }))} aria-valuetext={`${Math.round((clip.focus_x ?? 0.5) * 100)}% from left`} />
              </Field>
            )}
            <Field label="Label"><input className="input" value={clip.label ?? ""} onChange={(e) => onEdit(updateClip(timeline, selected!, { label: e.target.value }))} /></Field>
          </>
        )}
      </section>

      <section aria-labelledby="edit-h" className="space-y-3">
        <h3 id="edit-h" className="label">Whole edit</h3>
        <Field label="Format">
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Format">
            {(["16:9", "9:16", "1:1"] as const).map((a) => (
              <button key={a} role="radio" aria-checked={timeline.aspect === a} onClick={() => onEdit({ ...timeline, aspect: a })}
                      className={`btn btn-sm ${timeline.aspect === a ? "border-accent text-violet" : ""}`}>{a === "16:9" ? "Wide" : a === "9:16" ? "Vertical" : "Square"}</button>
            ))}
          </div>
        </Field>
        <label className="flex items-center justify-between gap-2"><span>Burn in captions</span>
          <input type="checkbox" checked={timeline.burn_captions} onChange={(e) => onEdit({ ...timeline, burn_captions: e.target.checked })} /></label>
        <Field label="On-screen title (first 4 s)">
          <input className="input" maxLength={80} placeholder="Optional" value={timeline.title ?? ""} onChange={(e) => onEdit({ ...timeline, title: e.target.value })} />
        </Field>
      </section>

      <section aria-labelledby="audio-h" className="space-y-3">
        <h3 id="audio-h" className="label flex items-center gap-1.5"><Icon name="sliders" size={13} /> Audio</h3>
        <Field label="Background noise reduction">
          <select className="input" value={audio.denoise} onChange={(e) => setAudio({ denoise: e.target.value as AudioSettings["denoise"] })}>
            <option value="off">Off</option><option value="light">Light</option><option value="strong">Strong</option>
          </select>
        </Field>
        <label className="flex items-center justify-between gap-2"><span>Voice clarity (EQ)</span>
          <input type="checkbox" checked={audio.voice_eq} onChange={(e) => setAudio({ voice_eq: e.target.checked })} /></label>
        <label className="flex items-center justify-between gap-2"><span>Even out levels (compressor)</span>
          <input type="checkbox" checked={audio.compress} onChange={(e) => setAudio({ compress: e.target.checked })} /></label>
        <Field label="Loudness">
          <select className="input" value={audio.loudness_target} onChange={(e) => setAudio({ loudness_target: Number(e.target.value) })}>
            <option value={-16}>Podcast (−16 LUFS)</option><option value={-14}>Social & YouTube (−14 LUFS)</option><option value={-23}>Broadcast (−23 LUFS)</option>
          </select>
        </Field>
        <Field label="Background music">
          <select className="input" value={audio.music_asset_id ?? ""} onChange={(e) => setAudio({ music_asset_id: e.target.value || null })}>
            <option value="">None</option>
            {music.map((a) => <option key={a.id} value={a.id}>{a.original_name}</option>)}
          </select>
        </Field>
        {audio.music_asset_id && (
          <>
            <Field label={`Music volume (${audio.music_volume_db} dB)`}>
              <input type="range" min={-40} max={0} step={1} value={audio.music_volume_db} className="w-full accent-[#8b7cf8]"
                     onChange={(e) => setAudio({ music_volume_db: Number(e.target.value) })} />
            </Field>
            <label className="flex items-center justify-between gap-2"><span>Lower music when people talk</span>
              <input type="checkbox" checked={audio.duck} onChange={(e) => setAudio({ duck: e.target.checked })} /></label>
          </>
        )}
        <p className="text-[11px] leading-relaxed text-faint">Audio processing is applied when you render or export. The instant preview plays the original sound.</p>
      </section>
    </div>
  );
}
