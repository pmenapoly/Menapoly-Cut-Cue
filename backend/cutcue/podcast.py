"""Podcast Auto-Editor: speaker-aware pause tightening, filler removal and dead-air trimming.

Works from word timestamps (Whisper) plus detected silences, so cuts land between words,
never inside them. Natural flow rules:

* pauses within one speaker are shortened to ``same_speaker_pause`` (default 0.35 s);
* pauses at a speaker change, or after a question, keep ``turn_pause`` (default 0.6 s), so
  turn-taking still breathes;
* a gap is only cut where the audio is actually silent (silencedetect), unless the gap held a
  removed filler word: untranscribed laughter or crosstalk is never cut;
* fillers ("um", "uh", …) are removed with the gap around them retimed by the same rules;
* leading/trailing dead air is trimmed to a short lead-in and tail.

Output: explicit source clips (an EDL) plus a report of every change, for review before approval.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from .timeline import Clip

FILLERS = {"um", "uh", "umm", "uhm", "erm", "er", "ah", "hmm", "mm", "mhm"}


@dataclass
class AutoEditOptions:
    tighten_pauses: bool = True
    same_speaker_pause: float = 0.35
    turn_pause: float = 0.6
    remove_fillers: bool = True
    trim_dead_air: bool = True
    lead_in: float = 0.25
    tail: float = 0.5
    exclude_speakers: list[str] = field(default_factory=list)
    min_cut: float = 0.12  # shorter cuts are not worth a join

    @classmethod
    def from_dict(cls, data: dict | None) -> "AutoEditOptions":
        data = dict(data or {})
        opts = cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        opts.same_speaker_pause = min(max(float(opts.same_speaker_pause), 0.1), 2.0)
        opts.turn_pause = min(max(float(opts.turn_pause), opts.same_speaker_pause), 3.0)
        opts.lead_in = min(max(float(opts.lead_in), 0.0), 3.0)
        opts.tail = min(max(float(opts.tail), 0.0), 5.0)
        return opts


def normalize_word(word: str) -> str:
    return re.sub(r"[^a-z']", "", word.lower())


def is_filler(word: str) -> bool:
    return normalize_word(word) in FILLERS


def _subtract(keep: list[tuple[float, float]], cut: tuple[float, float]) -> list[tuple[float, float]]:
    out = []
    for a, b in keep:
        if cut[1] <= a or cut[0] >= b:
            out.append((a, b))
            continue
        if cut[0] > a:
            out.append((a, cut[0]))
        if cut[1] < b:
            out.append((cut[1], b))
    return out


def _intersect(region: tuple[float, float], silences: list[dict]) -> list[tuple[float, float]]:
    out = []
    for s in silences:
        a, b = max(region[0], s["start"]), min(region[1], s["end"])
        if b > a:
            out.append((a, b))
    return out


def auto_edit(asset_id: str, duration: float, segments: list[dict], silences: list[dict] | None,
              options: AutoEditOptions) -> tuple[list[Clip], dict]:
    """Return (clips, report) for one source. ``segments`` come from the transcript (with words/speakers)."""
    words: list[dict] = []
    for seg in segments:
        seg_words = seg.get("words") or [{"start": seg["start"], "end": seg["end"], "word": seg["text"]}]
        speakers = seg.get("word_speakers") or []
        for i, w in enumerate(seg_words):
            own = w.get("speaker") or (speakers[i] if i < len(speakers) else None)
            words.append({**w, "speaker": own or seg.get("speaker")})
    words.sort(key=lambda w: w["start"])
    report: dict = {"options": asdict(options), "source_duration": round(duration, 3), "fillers_removed": [],
                    "pauses_tightened": 0, "turn_pauses_kept": 0, "dead_air_trimmed": 0.0, "speakers_excluded": [],
                    "silence_checked": silences is not None}
    if not words:
        return [Clip(asset_id=asset_id, start=0.0, end=round(duration, 3), label="Full")], {**report, "note": "no transcript words"}

    kept, dropped = [], []
    for w in words:
        if options.remove_fillers and is_filler(w["word"]):
            dropped.append(("filler", w))
        elif w.get("speaker") and w["speaker"] in options.exclude_speakers:
            dropped.append(("speaker", w))
        else:
            kept.append(w)
    report["fillers_removed"] = [{"start": w["start"], "end": w["end"], "word": w["word"].strip()} for kind, w in dropped if kind == "filler"]
    report["speakers_excluded"] = sorted({w["speaker"] for kind, w in dropped if kind == "speaker"})
    if not kept:
        return [], {**report, "note": "every word was removed"}

    start = max(0.0, kept[0]["start"] - options.lead_in) if options.trim_dead_air else 0.0
    end = min(duration, kept[-1]["end"] + options.tail) if options.trim_dead_air else duration
    report["dead_air_trimmed"] = round(start + (duration - end), 3)
    keep = [(start, end)]
    dropped_spans = [(w["start"], w["end"]) for _, w in dropped]

    for prev, nxt in zip(kept, kept[1:]):
        gap = nxt["start"] - prev["end"]
        turn = bool(prev.get("speaker") and nxt.get("speaker") and prev["speaker"] != nxt["speaker"])
        question = prev["word"].strip().endswith("?")
        target = options.turn_pause if (turn or question) else options.same_speaker_pause
        held_dropped = any(prev["end"] - 0.01 <= a and b <= nxt["start"] + 0.01 for a, b in dropped_spans)
        if gap <= target + options.min_cut or not (options.tighten_pauses or held_dropped):
            if turn and gap > 0:
                report["turn_pauses_kept"] += 1
            continue
        region = (prev["end"] + target / 2, nxt["start"] - target / 2)
        if held_dropped or silences is None:
            cuts = [region]
        else:
            cuts = _intersect(region, silences)
        cuts = [c for c in cuts if c[1] - c[0] >= options.min_cut]
        for c in cuts:
            keep = _subtract(keep, c)
        if cuts:
            report["pauses_tightened"] += 1
            if turn:
                report["turn_pauses_kept"] += 1
    # Words of excluded speakers: cut their whole span (plus gaps are retimed above).
    for kind, w in dropped:
        if kind == "speaker":
            keep = _subtract(keep, (w["start"], w["end"]))
    clips = [Clip(asset_id=asset_id, start=round(a, 3), end=round(b, 3), label="Podcast") for a, b in keep if b - a >= 0.1]
    new_duration = sum(c.end - c.start for c in clips)
    report.update({"output_duration": round(new_duration, 3), "removed_seconds": round(duration - new_duration, 3),
                   "clips": len(clips)})
    return clips, report


def map_to_output(clips: list[Clip], t: float) -> float | None:
    """Source time -> output time for a single-source timeline (None if t was cut)."""
    offset = 0.0
    for c in clips:
        if c.start <= t <= c.end:
            return offset + (t - c.start)
        offset += c.end - c.start
    return None


def summarize(report: dict) -> str:
    fillers = len(report.get("fillers_removed", []))
    return (f"Removed {report.get('removed_seconds', 0):.1f}s of {report.get('source_duration', 0):.1f}s: "
            f"{report.get('pauses_tightened', 0)} pauses tightened, {fillers} filler word(s) cut, "
            f"{report.get('dead_air_trimmed', 0):.1f}s dead air trimmed; {report.get('turn_pauses_kept', 0)} speaker "
            f"turn(s) keep a natural pause.")
