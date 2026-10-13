"""Turn a validated timeline into real FFmpeg output (MP4 + SRT, optional WAV).

Strategy (evolved from the original ``edit_engine.py``): encode each clip to an
intermediate with identical codec parameters, then concatenate with stream copy. One
clip in flight at a time keeps memory flat on a 16 GB Intel Mac, sync is preserved per
clip (audio padded/trimmed to the exact video length), and progress is per clip.
"""
from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .documents import to_srt
from .media import CancelToken, run_ffmpeg
from .timeline import Timeline, caption_cues, timeline_duration

SIZES = {
    "preview": {"16:9": (640, 360), "9:16": (360, 640), "1:1": (480, 480)},
    "final": {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)},
}
FPS = 30


@dataclass
class RenderResult:
    output: Path
    srt: Path
    duration: float
    cues: int


def _video_encode_args(quality: str, encoder: str) -> list[str]:
    if quality == "preview":
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"]
    if encoder == "h264_videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]


def _clip_args(source: Path, asset: dict, start: float, length: float, width: int, height: int,
               quality: str, encoder: str, dest: Path) -> list[str]:
    abitrate = "96k" if quality == "preview" else "192k"
    # Fill the frame (center crop) so 16:9 sources work for 9:16 and 1:1 outputs.
    fill = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps={FPS}"
    args = ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(source)]
    if asset["has_video"]:
        vchain = f"[0:v:0]{fill},tpad=stop_mode=clone:stop_duration={length:.3f}[v]"
    else:  # audio-only: waveform visual on dark background
        vchain = (f"[0:a:0]showwaves=s={width}x{height // 3}:mode=cline:colors=0x9fd3c7:rate={FPS},"
                  f"pad={width}:{height}:0:(oh-ih)/2:color=0x101418,setsar=1,format=yuv420p[v]")
    if asset["has_audio"]:
        achain = "[0:a:0]aresample=48000:async=1,aformat=channel_layouts=stereo,apad[a]"
        inputs: list[str] = []
    else:
        args += ["-f", "lavfi", "-t", f"{length:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        achain = "[1:a]anull[a]"
        inputs = []
    return [*args, *inputs, "-filter_complex", f"{vchain};{achain}", "-map", "[v]", "-map", "[a]",
            "-t", f"{length:.3f}", *_video_encode_args(quality, encoder),
            "-c:a", "aac", "-b:a", abitrate, "-ar", "48000", "-ac", "2", str(dest)]


def render_timeline(timeline: Timeline, assets: dict[str, dict], source_paths: dict[str, Path],
                    segments_by_asset: dict[str, list[dict]], out_dir: Path, basename: str, *,
                    quality: str = "preview", encoder: str = "libx264", want_wav: bool = False,
                    progress: Callable[[float, str], None] = lambda p, m: None,
                    cancel: CancelToken | None = None, timeout: float | None = None) -> RenderResult:
    """Render ``timeline`` (already validated) into ``out_dir``. Returns output paths."""
    cancel = cancel or CancelToken()
    width, height = SIZES[quality][timeline.aspect]
    total = timeline_duration(timeline)
    out_dir.mkdir(parents=True, exist_ok=True)
    output = out_dir / f"{basename}.mp4"
    srt_path = out_dir / f"{basename}.srt"

    cues = caption_cues(timeline, segments_by_asset)
    srt_path.write_text(to_srt(cues), encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="cutcue-render-") as tmp_name:
        tmp = Path(tmp_name)
        pieces: list[Path] = []
        done = 0.0
        # Weight: clips 85%, finishing passes 15%.
        for i, clip in enumerate(timeline.clips):
            cancel.check()
            length = round(clip.end - clip.start, 3)
            piece = tmp / f"clip_{i:05}.mp4"
            asset = assets[clip.asset_id]
            run_ffmpeg(_clip_args(source_paths[clip.asset_id], asset, clip.start, length, width, height,
                                  quality, encoder, piece),
                       duration=length, cancel=cancel, timeout=timeout,
                       progress=lambda f, d=done, n=length: progress(0.85 * (d + f * n) / total,
                                                                    f"Rendering clip {i + 1}/{len(timeline.clips)}"))
            pieces.append(piece)
            done += length
        manifest = tmp / "concat.txt"
        manifest.write_text("".join(f"file '{p.name}'\n" for p in pieces))
        joined = tmp / "joined.mp4"
        progress(0.86, "Joining clips")
        run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(manifest), "-c", "copy", str(joined)],
                   cancel=cancel, timeout=timeout)

        current = joined
        if timeline.burn_captions and cues:
            progress(0.88, "Burning captions")
            shutil.copy(srt_path, tmp / "captions.srt")
            font_size = 14 if timeline.aspect == "16:9" else 11
            burned = tmp / "burned.mp4"
            # Relative filename inside the temp dir avoids filtergraph path escaping issues.
            run_ffmpeg(["-i", str(current), "-vf",
                        f"subtitles=captions.srt:force_style='FontName=Helvetica,FontSize={font_size},"
                        f"Outline=2,MarginV=40'",
                        *_video_encode_args(quality, encoder), "-c:a", "copy", str(burned)],
                       duration=total, cancel=cancel, timeout=timeout, cwd=tmp,
                       progress=lambda f: progress(0.88 + 0.06 * f, "Burning captions"))
            current = burned

        progress(0.95, "Finishing audio")
        audio_filter = ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"] if timeline.normalize_audio else []
        run_ffmpeg(["-i", str(current), "-c:v", "copy", *audio_filter, "-c:a", "aac",
                    "-b:a", "96k" if quality == "preview" else "192k", "-ar", "48000",
                    "-movflags", "+faststart", str(output)],
                   cancel=cancel, timeout=timeout, duration=total,
                   progress=lambda f: progress(0.95 + 0.04 * f, "Finishing audio"))

    if want_wav:
        run_ffmpeg(["-i", str(output), "-vn", "-c:a", "pcm_s16le", "-ar", "48000", str(out_dir / f"{basename}.wav")],
                   cancel=cancel, timeout=timeout)
    progress(1.0, "Done")
    return RenderResult(output=output, srt=srt_path, duration=total, cues=len(cues))
