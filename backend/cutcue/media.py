"""FFmpeg/FFprobe helpers: probing, thumbnails, proxies, silence and scene analysis.

Every call uses an argument list (never a shell) and paths that the server built
itself from opaque asset IDs.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable

ProgressFn = Callable[[float], None]


class Cancelled(Exception):
    pass


class CancelToken:
    """Lets a job cancel the subprocess it is currently waiting on."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()
        with self._lock:
            if self._proc and self._proc.poll() is None:
                self._proc.kill()

    def attach(self, proc: subprocess.Popen | None) -> None:
        with self._lock:
            self._proc = proc
        if proc and self.cancelled:
            proc.kill()

    def check(self) -> None:
        if self.cancelled:
            raise Cancelled()


def tool_available(name: str) -> bool:
    return shutil.which(name) is not None


def run_ffmpeg(args: list[str], *, duration: float | None = None, progress: ProgressFn | None = None,
               cancel: CancelToken | None = None, timeout: float | None = None,
               cwd: Path | None = None) -> str:
    """Run ffmpeg with machine-readable progress. Returns stderr text. Raises on failure."""
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", *args]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=cwd)
    if cancel:
        cancel.attach(proc)
    stderr_chunks: list[str] = []

    def drain() -> None:
        assert proc.stderr
        for line in proc.stderr:
            stderr_chunks.append(line)
            if len(stderr_chunks) > 4000:
                del stderr_chunks[:2000]

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    timer = threading.Timer(timeout, proc.kill) if timeout else None
    if timer:
        timer.start()
    try:
        assert proc.stdout
        for line in proc.stdout:
            if progress and duration and line.startswith("out_time_us="):
                try:
                    seconds = int(line.split("=", 1)[1]) / 1e6
                    progress(max(0.0, min(1.0, seconds / duration)))
                except ValueError:
                    pass
        proc.wait()
    finally:
        if timer:
            timer.cancel()
        reader.join(timeout=5)
        if cancel:
            cancel.attach(None)
    stderr = "".join(stderr_chunks)
    if cancel and cancel.cancelled:
        raise Cancelled()
    if proc.returncode != 0:
        tail = "\n".join(stderr.strip().splitlines()[-8:])
        raise RuntimeError(f"ffmpeg failed (exit {proc.returncode}): {tail}")
    return stderr


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise ValueError("File is not a readable media file")
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float(data.get("format", {}).get("duration") or 0) or None
    fps = None
    if video and video.get("avg_frame_rate") and video["avg_frame_rate"] != "0/0":
        num, _, den = video["avg_frame_rate"].partition("/")
        try:
            fps = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError):
            fps = None
    return {
        "duration": duration,
        "has_video": video is not None,
        "has_audio": audio is not None,
        "width": int(video["width"]) if video else None,
        "height": int(video["height"]) if video else None,
        "fps": fps,
        "video_codec": video.get("codec_name") if video else None,
        "audio_codec": audio.get("codec_name") if audio else None,
        "format_name": data.get("format", {}).get("format_name"),
        "raw": {"format": data.get("format", {}), "streams": streams},
    }


def make_thumbnail(source: Path, dest: Path, duration: float | None) -> None:
    at = min(5.0, (duration or 0) * 0.1)
    run_ffmpeg(["-ss", f"{at:.3f}", "-i", str(source), "-frames:v", "1",
                "-vf", "scale=320:-2", "-q:v", "4", str(dest)], timeout=120)


BROWSER_VIDEO = {"h264"}
BROWSER_AUDIO = {"aac", "mp3", None}


def needs_proxy(info: dict) -> bool:
    if not info["has_video"]:
        return False
    container_ok = "mp4" in (info.get("format_name") or "") or "mov" in (info.get("format_name") or "")
    return not (container_ok and info["video_codec"] in BROWSER_VIDEO and info["audio_codec"] in BROWSER_AUDIO)


def make_proxy(source: Path, dest: Path, duration: float | None, progress: ProgressFn | None = None,
               cancel: CancelToken | None = None) -> None:
    """540p H.264 browser-playable proxy. ultrafast keeps Intel CPUs responsive."""
    run_ffmpeg(["-i", str(source), "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", "scale=-2:540", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(dest)],
               duration=duration, progress=progress, cancel=cancel)


def extract_audio_wav(source: Path, dest: Path, cancel: CancelToken | None = None,
                      duration: float | None = None, progress: ProgressFn | None = None) -> None:
    """16 kHz mono WAV: what Whisper wants, and small enough to keep in RAM on 16 GB."""
    run_ffmpeg(["-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dest)],
               cancel=cancel, duration=duration, progress=progress)


_SILENCE_START = re.compile(r"silence_start: (-?[\d.]+)")
_SILENCE_END = re.compile(r"silence_end: (-?[\d.]+) \| silence_duration: ([\d.]+)")


def detect_silences(source: Path, duration: float | None, *, noise_db: float = -35.0, min_duration: float = 0.6,
                    cancel: CancelToken | None = None, progress: ProgressFn | None = None) -> list[dict]:
    stderr = run_ffmpeg(["-i", str(source), "-vn", "-af", f"silencedetect=noise={noise_db}dB:d={min_duration}",
                         "-f", "null", "-"], duration=duration, cancel=cancel, progress=progress)
    silences: list[dict] = []
    start: float | None = None
    for line in stderr.splitlines():
        if m := _SILENCE_START.search(line):
            start = max(0.0, float(m.group(1)))
        elif (m := _SILENCE_END.search(line)) and start is not None:
            silences.append({"start": round(start, 3), "end": round(float(m.group(1)), 3)})
            start = None
    if start is not None and duration:
        silences.append({"start": round(start, 3), "end": round(duration, 3)})
    return silences


_SCENE = re.compile(r"lavfi\.scd\.time: ([\d.]+)")


def detect_scenes(source: Path, duration: float | None, *, threshold: float = 10.0,
                  cancel: CancelToken | None = None, progress: ProgressFn | None = None) -> list[float]:
    """Scene cuts via FFmpeg's scdet on a 4 fps, 160px-wide sample: sparse and cheap on Intel CPUs."""
    stderr = run_ffmpeg(["-i", str(source), "-an", "-vf", f"fps=4,scale=160:-2,scdet=threshold={threshold}",
                         "-f", "null", "-"], duration=duration, cancel=cancel, progress=progress)
    return [round(float(m.group(1)), 3) for m in _SCENE.finditer(stderr)]


_encoder_cache: dict[str, str] = {}


def pick_video_encoder(preference: str) -> str:
    """libx264 everywhere; h264_videotoolbox on Macs whose GPU supports it (opt-in or auto)."""
    if preference in _encoder_cache:
        return _encoder_cache[preference]
    choice = "libx264"
    if preference in ("auto", "h264_videotoolbox"):
        try:
            test = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=320x240:d=0.2",
                 "-c:v", "h264_videotoolbox", "-f", "null", "-"], capture_output=True, timeout=30)
            if test.returncode == 0:
                choice = "h264_videotoolbox"
        except (OSError, subprocess.TimeoutExpired):
            pass
    _encoder_cache[preference] = choice
    return choice
