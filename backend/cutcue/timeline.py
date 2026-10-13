"""Timeline schema, strict validation against real project assets, and timeline math.

A timeline is an ordered list of source ranges (edit decision list). Every clip must
reference a ready media asset of the same project, and every time must lie inside that
asset's probed duration. Nothing proposed by the AI reaches the renderer without passing
``validate_timeline``.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Aspect = Literal["16:9", "9:16", "1:1"]
MAX_CLIPS = 3000
MAX_TOTAL_SECONDS = 6 * 3600
MIN_CLIP_SECONDS = 0.1
DURATION_TOLERANCE = 0.05


class Clip(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str
    start: float = Field(description="Source in-point, seconds")
    end: float = Field(description="Source out-point, seconds")
    label: str = ""


class Timeline(BaseModel):
    model_config = ConfigDict(extra="forbid")
    aspect: Aspect = "16:9"
    clips: list[Clip] = Field(default_factory=list)
    burn_captions: bool = False
    normalize_audio: bool = True


class TimelineError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def timeline_duration(timeline: Timeline) -> float:
    return round(sum(c.end - c.start for c in timeline.clips), 3)


def validate_timeline(timeline: Timeline, assets: dict[str, dict]) -> None:
    """``assets`` maps asset_id -> asset row for *this project only*."""
    problems: list[str] = []
    if not timeline.clips:
        problems.append("Timeline has no clips")
    if len(timeline.clips) > MAX_CLIPS:
        problems.append(f"Too many clips ({len(timeline.clips)} > {MAX_CLIPS})")
    for i, clip in enumerate(timeline.clips):
        asset = assets.get(clip.asset_id)
        where = f"clip {i + 1} ({clip.asset_id})"
        if asset is None:
            problems.append(f"{where}: unknown asset for this project")
            continue
        if asset["kind"] not in ("video", "audio"):
            problems.append(f"{where}: asset is {asset['kind']}, not video or audio")
            continue
        if asset["status"] != "ready" or not asset.get("duration"):
            problems.append(f"{where}: asset is not ready (status {asset['status']})")
            continue
        if clip.start < 0:
            problems.append(f"{where}: start {clip.start} is negative")
        if clip.end - clip.start < MIN_CLIP_SECONDS:
            problems.append(f"{where}: end {clip.end} must be at least {MIN_CLIP_SECONDS}s after start {clip.start}")
        if clip.end > asset["duration"] + DURATION_TOLERANCE:
            problems.append(f"{where}: end {clip.end} exceeds source duration {asset['duration']:.3f}")
    if timeline_duration(timeline) > MAX_TOTAL_SECONDS:
        problems.append("Timeline is longer than 6 hours")
    if problems:
        raise TimelineError(problems)


def clamp_to_duration(timeline: Timeline, assets: dict[str, dict]) -> Timeline:
    """Snap ends that overshoot by less than the tolerance onto the true duration."""
    for clip in timeline.clips:
        asset = assets.get(clip.asset_id)
        if asset and asset.get("duration") and asset["duration"] < clip.end <= asset["duration"] + DURATION_TOLERANCE:
            clip.end = round(asset["duration"], 3)
    return timeline


def remove_pauses(clips: list[Clip], silences: dict[str, list[dict]], *, min_pause: float = 0.7,
                  keep_padding: float = 0.15, min_piece: float = 0.25) -> list[Clip]:
    """Split each clip around detected silences longer than ``min_pause``.

    ``keep_padding`` seconds of each pause stay on either side so speech is not clipped.
    """
    out: list[Clip] = []
    for clip in clips:
        cursor = clip.start
        for s in sorted(silences.get(clip.asset_id, []), key=lambda s: s["start"]):
            if s["end"] - s["start"] < min_pause:
                continue
            cut_start, cut_end = s["start"] + keep_padding, s["end"] - keep_padding
            if cut_end <= clip.start or cut_start >= clip.end:
                continue
            cut_start, cut_end = max(cut_start, clip.start), min(cut_end, clip.end)
            if cut_start - cursor >= min_piece:
                out.append(Clip(asset_id=clip.asset_id, start=round(cursor, 3), end=round(cut_start, 3), label=clip.label))
            cursor = max(cursor, cut_end)
        if clip.end - cursor >= min_piece:
            out.append(Clip(asset_id=clip.asset_id, start=round(cursor, 3), end=round(clip.end, 3), label=clip.label))
    return out


def caption_cues(timeline: Timeline, segments_by_asset: dict[str, list[dict]], *,
                 max_chars: int = 42, max_seconds: float = 3.5) -> list[dict]:
    """Map source transcript words onto output-timeline time and group into caption cues."""
    cues: list[dict] = []
    offset = 0.0
    for clip in timeline.clips:
        words: list[dict] = []
        for seg in segments_by_asset.get(clip.asset_id, []):
            if seg["end"] <= clip.start or seg["start"] >= clip.end:
                continue
            if seg.get("words"):
                words.extend(w for w in seg["words"] if w["start"] >= clip.start - 0.05 and w["end"] <= clip.end + 0.05)
            else:  # imported captions: segment-level timing only
                words.append({"start": max(seg["start"], clip.start), "end": min(seg["end"], clip.end), "word": seg["text"]})
        current: dict | None = None
        for w in words:
            text = w["word"].strip()
            if not text:
                continue
            start = offset + max(0.0, w["start"] - clip.start)
            end = offset + min(clip.end, w["end"]) - clip.start
            if current and (len(current["text"]) + 1 + len(text) > max_chars or end - current["start"] > max_seconds):
                cues.append(current)
                current = None
            if current is None:
                current = {"start": start, "end": end, "text": text}
            else:
                current["text"] += " " + text
                current["end"] = end
        if current:
            cues.append(current)
        offset += clip.end - clip.start
    for cue in cues:
        cue["start"], cue["end"] = round(cue["start"], 3), round(max(cue["end"], cue["start"] + 0.3), 3)
    return cues
