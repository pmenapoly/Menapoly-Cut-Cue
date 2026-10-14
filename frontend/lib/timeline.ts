// Pure timeline operations shared by Cue Simple and Cue Pro. They never mutate their input.
import { Clip, Segment, Timeline } from "./api";

export const MIN_CLIP = 0.1;

export const clipLength = (c: Clip) => Math.max(0, c.end - c.start);
export const totalDuration = (t: Timeline | null | undefined) => (t ? t.clips.reduce((s, c) => s + clipLength(c), 0) : 0);

/** Output-time start of every clip. */
export function clipOffsets(t: Timeline): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const c of t.clips) { out.push(acc); acc += clipLength(c); }
  return out;
}

/** Output time -> (clip index, source time). */
export function locate(t: Timeline, time: number): { index: number; source: number } | null {
  let acc = 0;
  for (let i = 0; i < t.clips.length; i++) {
    const len = clipLength(t.clips[i]);
    if (time < acc + len || i === t.clips.length - 1) {
      return { index: i, source: t.clips[i].start + Math.min(Math.max(0, time - acc), len) };
    }
    acc += len;
  }
  return null;
}

/** Source time inside clip i -> output time. */
export const outputTime = (t: Timeline, index: number, source: number) =>
  clipOffsets(t)[index] + Math.min(Math.max(0, source - t.clips[index].start), clipLength(t.clips[index]));

const round = (x: number) => Math.round(x * 1000) / 1000;

export function splitAt(t: Timeline, time: number): Timeline {
  const hit = locate(t, time);
  if (!hit) return t;
  const c = t.clips[hit.index];
  if (hit.source - c.start < MIN_CLIP || c.end - hit.source < MIN_CLIP) return t;
  const clips = [...t.clips];
  clips.splice(hit.index, 1, { ...c, end: round(hit.source) }, { ...c, start: round(hit.source) });
  return { ...t, clips };
}

export function removeClip(t: Timeline, index: number): Timeline {
  return { ...t, clips: t.clips.filter((_, i) => i !== index) };
}

export function moveClip(t: Timeline, from: number, to: number): Timeline {
  if (from === to || from < 0 || to < 0 || from >= t.clips.length || to >= t.clips.length) return t;
  const clips = [...t.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(to, 0, c);
  return { ...t, clips };
}

/** Trim one edge; source bounds come from the asset duration. */
export function trimClip(t: Timeline, index: number, edge: "start" | "end", value: number, sourceDuration: number): Timeline {
  const c = t.clips[index];
  const next = edge === "start"
    ? { ...c, start: round(Math.min(Math.max(0, value), c.end - MIN_CLIP)) }
    : { ...c, end: round(Math.max(Math.min(sourceDuration, value), c.start + MIN_CLIP)) };
  return { ...t, clips: t.clips.map((x, i) => (i === index ? next : x)) };
}

export function updateClip(t: Timeline, index: number, patch: Partial<Clip>): Timeline {
  return { ...t, clips: t.clips.map((x, i) => (i === index ? { ...x, ...patch } : x)) };
}

/** Remove a source range (e.g. words selected in the transcript) from every clip of that asset. */
export function cutSourceRange(t: Timeline, assetId: string, start: number, end: number): Timeline {
  const clips: Clip[] = [];
  for (const c of t.clips) {
    if (c.asset_id !== assetId || end <= c.start || start >= c.end) { clips.push(c); continue; }
    if (start - c.start >= MIN_CLIP) clips.push({ ...c, end: round(start) });
    if (c.end - end >= MIN_CLIP) clips.push({ ...c, start: round(end) });
  }
  return { ...t, clips };
}

export function insertClip(t: Timeline, clip: Clip, at?: number): Timeline {
  const clips = [...t.clips];
  clips.splice(at ?? clips.length, 0, clip);
  return { ...t, clips };
}

/** Caption cues for an output timeline (mirrors the server's caption mapping, for live preview). */
export function previewCues(t: Timeline, segments: Record<string, Segment[]>, maxChars = 42) {
  const cues: { start: number; end: number; text: string }[] = [];

  let offset = 0;
  type Cue = { start: number; end: number; text: string };
  for (const c of t.clips) {
    let cur = null as Cue | null;
    for (const s of segments[c.asset_id] ?? []) {
      if (s.end <= c.start || s.start >= c.end) continue;
      const words = s.words?.length ? s.words : [{ start: s.start, end: s.end, word: s.text }];
      for (const w of words) {
        if (w.start < c.start - 0.05 || w.end > c.end + 0.05) continue;
        const ws = offset + Math.max(0, w.start - c.start), we = offset + Math.min(c.end, w.end) - c.start;
        const text = w.word.trim();
        if (!text) continue;
        if (cur && (cur.text.length + text.length + 1 > maxChars || we - cur.start > 3.5)) { cues.push(cur); cur = null; }
        cur = cur ? { start: cur.start, end: we, text: `${cur.text} ${text}` } : { start: ws, end: we, text };
      }
    }
    if (cur) cues.push(cur);
    offset += clipLength(c);
  }
  return cues;
}

export const sameTimeline = (a: Timeline | null | undefined, b: Timeline | null | undefined) => JSON.stringify(a) === JSON.stringify(b);
