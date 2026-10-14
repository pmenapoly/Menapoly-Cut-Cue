"""Turn a validated timeline into real FFmpeg output (MP4 + SRT, optional WAV).

Strategy (evolved from the original ``edit_engine.py``): encode each clip to an
intermediate with identical codec parameters, then concatenate with stream copy. One
clip in flight at a time keeps memory flat on a 16 GB Intel Mac, sync is preserved per
clip (audio padded/trimmed to the exact video length), and progress is per clip.
Each clip gets 12 ms audio fades so cuts never click. The joined program then goes
through the audio finishing chain (cutcue.audio) and optional caption/title burn-in.
"""
from __future__ import annotations

import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .audio import finish_audio
from .documents import to_srt
from .media import CancelToken, run_ffmpeg
from .timeline import Timeline, caption_cues, timeline_duration

SIZES = {
    "preview": {"16:9": (640, 360), "9:16": (360, 640), "1:1": (480, 480)},
    "final": {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)},
}
FPS = 30
CLIP_FADE = 0.012


@dataclass
class RenderResult:
    output: Path
    srt: Path
    duration: float
    cues: int
    audio: dict = field(default_factory=dict)


@dataclass
class SourceAudio:
    """Processed audio that replaces a source's own track (WAV re-import), with its measured offset."""
    path: Path
    offset: float = 0.0


def _video_encode_args(quality: str, encoder: str) -> list[str]:
    if quality == "preview":
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"]
    if encoder == "h264_videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]


def _clip_args(source: Path, asset: dict, start: float, length: float, width: int, height: int,
               quality: str, encoder: str, dest: Path, focus_x: float = 0.5,
               audio_override: SourceAudio | None = None) -> list[str]:
    abitrate = "96k" if quality == "preview" else "192k"
    # Fill the frame, then crop at focus_x (0 = left edge, 0.5 = centre, 1 = right edge).
    fill = (f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}:(iw-{width})*{focus_x:.3f}:(ih-{height})/2,setsar=1,fps={FPS}")
    args = ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(source)]
    if asset["has_video"]:
        vchain = f"[0:v:0]{fill},tpad=stop_mode=clone:stop_duration={length:.3f}[v]"
    else:  # audio-only: waveform visual on dark background
        vchain = (f"[0:a:0]showwaves=s={width}x{height // 3}:mode=cline:colors=0x9fd3c7:rate={FPS},"
                  f"pad={width}:{height}:0:(oh-ih)/2:color=0x101418,setsar=1,format=yuv420p[v]")
    fades = f"afade=t=in:d={CLIP_FADE},afade=t=out:st={max(0.0, length - CLIP_FADE):.3f}:d={CLIP_FADE}"
    if audio_override:
        args += ["-ss", f"{max(0.0, start + audio_override.offset):.3f}", "-t", f"{length:.3f}", "-i", str(audio_override.path)]
        achain = f"[1:a:0]aresample=48000:async=1,aformat=channel_layouts=stereo,apad,{fades}[a]"
    elif asset["has_audio"]:
        achain = f"[0:a:0]aresample=48000:async=1,aformat=channel_layouts=stereo,apad,{fades}[a]"
    else:
        args += ["-f", "lavfi", "-t", f"{length:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        achain = "[1:a]anull[a]"
    return [*args, "-filter_complex", f"{vchain};{achain}", "-map", "[v]", "-map", "[a]",
            "-t", f"{length:.3f}", *_video_encode_args(quality, encoder),
            "-c:a", "aac", "-b:a", abitrate, "-ar", "48000", "-ac", "2", str(dest)]


def _ass_time(seconds: float) -> str:
    cs = int(round(max(0.0, seconds) * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02}:{s:02}.{cs:02}"


def _ass_text(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def build_ass(cues: list[dict], width: int, height: int, aspect: str, title: str, duration: float) -> str:
    """ASS subtitles sized to the output frame: captions bottom-centre, optional title top-centre."""
    vertical = aspect == "9:16"
    cap_size = round(width * 0.068) if vertical else round(height * 0.055)
    cap_margin = round(height * (0.16 if vertical else 0.07))
    title_size = round(width * 0.075) if vertical else round(height * 0.06)
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Caption,Helvetica,{cap_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,"
        f"{max(2, cap_size // 14)},0,2,{width // 12},{width // 12},{cap_margin},1",
        f"Style: Title,Helvetica,{title_size},&H00101418,&H00101418,&H0058A4E0,&H0058A4E0,1,0,0,0,100,100,0,0,3,"
        f"{max(4, title_size // 5)},0,8,{width // 14},{width // 14},{round(height * 0.08)},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for cue in cues:
        lines.append(f"Dialogue: 0,{_ass_time(cue['start'])},{_ass_time(cue['end'])},Caption,,0,0,0,,{_ass_text(cue['text'])}")
    if title:
        lines.append(f"Dialogue: 1,{_ass_time(0)},{_ass_time(min(4.0, duration))},Title,,0,0,0,,{_ass_text(title)}")
    return "\n".join(lines) + "\n"


def render_timeline(timeline: Timeline, assets: dict[str, dict], source_paths: dict[str, Path],
                    segments_by_asset: dict[str, list[dict]], out_dir: Path, basename: str, *,
                    quality: str = "preview", encoder: str = "libx264", want_wav: bool = False,
                    audio_overrides: dict[str, SourceAudio] | None = None, music_path: Path | None = None,
                    progress: Callable[[float, str], None] = lambda p, m: None,
                    cancel: CancelToken | None = None, timeout: float | None = None) -> RenderResult:
    """Render ``timeline`` (already validated) into ``out_dir``. Returns output paths."""
    cancel = cancel or CancelToken()
    audio_overrides = audio_overrides or {}
    width, height = SIZES[quality][timeline.aspect]
    total = timeline_duration(timeline)
    out_dir.mkdir(parents=True, exist_ok=True)
    output = out_dir / f"{basename}.mp4"
    srt_path = out_dir / f"{basename}.srt"

    cues = caption_cues(timeline, segments_by_asset, max_chars=28 if timeline.aspect == "9:16" else 42)
    srt_path.write_text(to_srt(cues), encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="cutcue-render-") as tmp_name:
        tmp = Path(tmp_name)
        pieces: list[Path] = []
        done = 0.0
        # Weight: clips 80%, captions 5%, audio finishing 15%.
        for i, clip in enumerate(timeline.clips):
            cancel.check()
            length = round(clip.end - clip.start, 3)
            piece = tmp / f"clip_{i:05}.mp4"
            run_ffmpeg(_clip_args(source_paths[clip.asset_id], assets[clip.asset_id], clip.start, length, width, height,
                                  quality, encoder, piece, clip.focus_x, audio_overrides.get(clip.asset_id)),
                       duration=length, cancel=cancel, timeout=timeout,
                       progress=lambda f, d=done, n=length: progress(0.8 * (d + f * n) / total,
                                                                    f"Rendering clip {i + 1}/{len(timeline.clips)}"))
            pieces.append(piece)
            done += length
        manifest = tmp / "concat.txt"
        manifest.write_text("".join(f"file '{p.name}'\n" for p in pieces))
        joined = tmp / "joined.mp4"
        progress(0.81, "Joining clips")
        run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(manifest), "-c", "copy", str(joined)],
                   cancel=cancel, timeout=timeout)

        current = joined
        burn_cues = cues if timeline.burn_captions else []
        if burn_cues or timeline.title:
            progress(0.82, "Burning captions")
            (tmp / "overlay.ass").write_text(build_ass(burn_cues, width, height, timeline.aspect, timeline.title, total),
                                             encoding="utf-8")
            burned = tmp / "burned.mp4"
            # Relative filename inside the temp dir avoids filtergraph path escaping issues.
            run_ffmpeg(["-i", str(current), "-vf", "subtitles=overlay.ass", *_video_encode_args(quality, encoder),
                        "-c:a", "copy", str(burned)],
                       duration=total, cancel=cancel, timeout=timeout, cwd=tmp,
                       progress=lambda f: progress(0.82 + 0.05 * f, "Burning captions"))
            current = burned

        progress(0.87, "Finishing audio")
        audio_info = finish_audio(current, output, total, timeline.audio, timeline.normalize_audio, music_path, quality,
                                  cancel=cancel, timeout=timeout,
                                  progress=lambda f: progress(0.87 + 0.12 * f, "Finishing audio"))

    if want_wav:
        run_ffmpeg(["-i", str(output), "-vn", "-c:a", "pcm_s16le", "-ar", "48000", str(out_dir / f"{basename}.wav")],
                   cancel=cancel, timeout=timeout)
    progress(1.0, "Done")
    return RenderResult(output=output, srt=srt_path, duration=total, cues=len(cues), audio=audio_info)


def remux_with_audio(video_source: Path, audio: Path, dest: Path, offset: float = 0.0,
                     cancel: CancelToken | None = None) -> None:
    """Replace a render's audio with a processed WAV (video stream copied, not re-encoded)."""
    audio_in = ["-itsoffset", f"{-offset:.3f}", "-i", str(audio)] if offset else ["-i", str(audio)]
    run_ffmpeg(["-i", str(video_source), *audio_in, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart",
                str(dest)], cancel=cancel)
