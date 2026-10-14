"""Export presets: platform-ready settings applied at render time (the saved edit is not changed)."""
from __future__ import annotations

PRESETS: dict[str, dict] = {
    "original": {"label": "As edited", "description": "Full quality, exactly as your edit is set up.", "overrides": {}},
    "youtube": {"label": "YouTube", "description": "1080p landscape, -14 LUFS, captions as a separate SRT file.",
                "overrides": {"aspect": "16:9", "loudness_target": -14.0, "burn_captions": False}},
    "podcast": {"label": "Podcast", "description": "Broadcast-friendly -16 LUFS mix plus a WAV for audio platforms.",
                "overrides": {"loudness_target": -16.0, "burn_captions": False}, "wav": True},
    "tiktok": {"label": "TikTok", "description": "Vertical 1080x1920 with burned-in captions, -14 LUFS.",
               "overrides": {"aspect": "9:16", "loudness_target": -14.0, "burn_captions": True}},
    "reels": {"label": "Instagram Reels", "description": "Vertical 1080x1920 with burned-in captions, -14 LUFS.",
              "overrides": {"aspect": "9:16", "loudness_target": -14.0, "burn_captions": True}},
    "linkedin": {"label": "LinkedIn", "description": "Square 1080x1080 with burned-in captions (feeds autoplay muted).",
                 "overrides": {"aspect": "1:1", "loudness_target": -14.0, "burn_captions": True}},
}


def apply_overrides(timeline: dict, overrides: dict) -> dict:
    out = {**timeline, "audio": {**(timeline.get("audio") or {})}}
    if "aspect" in overrides:
        out["aspect"] = overrides["aspect"]
    if "burn_captions" in overrides:
        out["burn_captions"] = overrides["burn_captions"]
    if "loudness_target" in overrides:
        out["audio"]["loudness_target"] = overrides["loudness_target"]
        out["normalize_audio"] = True
    return out
