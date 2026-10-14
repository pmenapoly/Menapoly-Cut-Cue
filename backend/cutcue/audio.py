"""Audio enhancement, measurement and processed-audio alignment. FFmpeg built-ins only
(afftdn, highpass/equalizer, acompressor, sidechaincompress, loudnorm), so it runs the same
on an Intel Mac, Linux and any FFmpeg >= 5.

Finishing pipeline for a rendered program (see ``finish_audio``):
  voice  → [afftdn denoise] → [voice EQ] → [compressor] ─┬───────────────────────┐
                                                        └→ sidechain ┐           │
  music  → loop/trim → gain → fades ──────────── sidechaincompress ─┴→ amix ─────┴→ loudnorm (2-pass)
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Callable

import numpy as np

from .media import CancelToken, run_ffmpeg
from .timeline import AudioSettings

# Denoise = spectral reduction (afftdn) tuned to the measured noise floor + a soft downward gate
# for pauses. Measured on the fixtures: ~13 dB (light) / ~20+ dB (strong) less noise in pauses,
# speech level unchanged within 0.1 dB.
DENOISE = {"light": {"nr": 12, "gate_range": 0.25, "gate_ratio": 2},
           "strong": {"nr": 24, "gate_range": 0.1, "gate_ratio": 3}}
# Rumble cut + gentle low-mid cleanup + presence lift: a safe default for spoken word.
VOICE_EQ = "highpass=f=80,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1:g=2.5"
COMPRESS = "acompressor=threshold=-20dB:ratio=3:attack=10:release=150:makeup=2"
SAMPLE_RATE = 48000


def denoise_filter(level: str, noise_floor_db: float) -> str:
    preset = DENOISE[level]
    floor = max(-80, min(-20, round(noise_floor_db)))
    # Gate opens 12 dB above the noise floor, never below -60 dBFS or above -30 dBFS.
    threshold = 10 ** (max(-60.0, min(-30.0, noise_floor_db + 12)) / 20)
    return (f"afftdn=nr={preset['nr']}:nf={floor}:tn=1,"
            f"agate=threshold={threshold:.5f}:ratio={preset['gate_ratio']}:range={preset['gate_range']}:attack=5:release=250")


def estimate_noise_floor(path: Path, frame_s: float = 0.05, percentile: float = 10.0) -> float:
    """Noise floor (dBFS): low percentile of short-frame RMS levels, streamed so hours of audio stay cheap."""
    rate = 8000
    frame = int(rate * frame_s)
    proc = subprocess.Popen(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-vn", "-ac", "1",
                             "-ar", str(rate), "-f", "f32le", "-"], stdout=subprocess.PIPE)
    levels: list[np.ndarray] = []
    assert proc.stdout
    while chunk := proc.stdout.read(frame * 4 * 600):
        data = np.frombuffer(chunk[: len(chunk) - len(chunk) % (frame * 4)], dtype=np.float32)
        if data.size:
            rms = np.sqrt(np.mean(data.reshape(-1, frame).astype(np.float64) ** 2, axis=1))
            levels.append(20 * np.log10(np.maximum(rms, 1e-7)))
    proc.wait()
    if not levels:
        return -70.0
    return float(np.percentile(np.concatenate(levels), percentile))


def voice_chain(settings: AudioSettings, noise_floor_db: float = -60.0) -> list[str]:
    chain = []
    if settings.denoise != "off":
        chain.append(denoise_filter(settings.denoise, noise_floor_db))
    if settings.voice_eq:
        chain.append(VOICE_EQ)
    if settings.compress:
        chain.append(COMPRESS)
    return chain


def music_graph(voice_label: str, duration: float, settings: AudioSettings) -> str:
    """Filtergraph mixing input 1 (music) under ``voice_label``; output label [mix]."""
    fade = min(1.5, duration / 4)
    music = (f"[1:a]aresample={SAMPLE_RATE},aformat=channel_layouts=stereo,atrim=0:{duration:.3f},"
             f"volume={settings.music_volume_db}dB,afade=t=in:d={fade:.2f},"
             f"afade=t=out:st={max(0.0, duration - fade):.3f}:d={fade:.2f}[music]")
    if settings.duck:
        # Voice drives the compressor on the music bed: music dips ~10-15 dB while someone speaks.
        return (f"{music};{voice_label}asplit=2[vmain][vkey];"
                f"[music][vkey]sidechaincompress=threshold=0.015:ratio=12:attack=20:release=400:makeup=1[ducked];"
                f"[vmain][ducked]amix=inputs=2:duration=first:normalize=0[mix]")
    return f"{music};{voice_label}[music]amix=inputs=2:duration=first:normalize=0[mix]"


_LOUDNORM_JSON = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)


def measure_loudnorm(path: Path, target: float, cancel: CancelToken | None = None) -> dict:
    stderr = run_ffmpeg(["-i", str(path), "-vn", "-af", f"loudnorm=I={target}:TP=-1.5:LRA=11:print_format=json",
                         "-f", "null", "-"], cancel=cancel)
    m = _LOUDNORM_JSON.search(stderr)
    if not m:
        raise RuntimeError("loudnorm measurement failed")
    return json.loads(m.group(0))


def loudnorm_filter(target: float, measured: dict) -> str:
    """Second loudnorm pass using first-pass measurements (linear mode, accurate integrated loudness)."""
    if float(measured["input_i"]) == float("-inf") or measured["input_i"] in ("-inf", "inf"):
        return f"loudnorm=I={target}:TP=-1.5:LRA=11"
    return (f"loudnorm=I={target}:TP=-1.5:LRA=11:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
            f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
            f"offset={measured['target_offset']}:linear=true")


def finish_audio(source: Path, dest: Path, duration: float, settings: AudioSettings, normalize: bool,
                 music_path: Path | None, quality: str, cancel: CancelToken | None = None,
                 timeout: float | None = None, progress: Callable[[float], None] = lambda f: None) -> dict:
    """``source`` is the joined program (video+audio). Writes ``dest`` MP4 with video stream-copied."""
    tmp_wav = dest.with_suffix(".premaster.wav")
    noise_floor = estimate_noise_floor(source) if settings.denoise != "off" else None
    chain = voice_chain(settings, noise_floor if noise_floor is not None else -60.0)
    inputs = ["-i", str(source)]
    if music_path:
        inputs += ["-stream_loop", "-1", "-i", str(music_path)]
        pre = (f"[0:a]{','.join(chain)}[voice];" if chain else "[0:a]anull[voice];") + music_graph("[voice]", duration, settings)
        out_label = "[mix]"
    else:
        pre = f"[0:a]{','.join(chain) or 'anull'}[mix]"
        out_label = "[mix]"
    run_ffmpeg([*inputs, "-filter_complex", pre, "-map", out_label, "-t", f"{duration:.3f}", "-ac", "2",
                "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(tmp_wav)],
               duration=duration, cancel=cancel, timeout=timeout, progress=lambda f: progress(0.5 * f))
    info: dict = {"chain": chain, "music": bool(music_path), "duck": bool(music_path and settings.duck),
                  "noise_floor_db": round(noise_floor, 1) if noise_floor is not None else None}
    afilter = []
    if normalize:
        measured = measure_loudnorm(tmp_wav, settings.loudness_target, cancel)
        info["measured_input_lufs"] = float(measured["input_i"])
        afilter = ["-af", loudnorm_filter(settings.loudness_target, measured) + f",aresample={SAMPLE_RATE}"]
    progress(0.7)
    run_ffmpeg(["-i", str(source), "-i", str(tmp_wav), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", *afilter,
                "-c:a", "aac", "-b:a", "96k" if quality == "preview" else "192k", "-ar", str(SAMPLE_RATE),
                "-shortest", "-movflags", "+faststart", str(dest)],
               duration=duration, cancel=cancel, timeout=timeout, progress=lambda f: progress(0.7 + 0.3 * f))
    tmp_wav.unlink(missing_ok=True)
    return info


# --- measurement --------------------------------------------------------------------------------

_EBUR_I = re.compile(r"Integrated loudness:\s+I:\s+(-?[\d.]+|-inf) LUFS", re.S)


def integrated_loudness(path: Path) -> float:
    """EBU R128 integrated loudness of a file (LUFS)."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-i", str(path), "-vn", "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = _EBUR_I.search(r.stderr)
    if not m:
        raise RuntimeError("could not measure loudness")
    return float(m.group(1)) if m.group(1) != "-inf" else float("-inf")


def read_pcm(path: Path, rate: int = 16000, start: float = 0.0, duration: float | None = None,
             channels: int = 1, afilter: str | None = None) -> np.ndarray:
    """Decode audio to float32 numpy ([n] mono or [n, channels])."""
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-ss", f"{start:.3f}"]
    if duration is not None:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-i", str(path), "-vn"]
    if afilter:
        cmd += ["-af", afilter]
    cmd += ["-ac", str(channels), "-ar", str(rate), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    data = np.frombuffer(raw, dtype=np.float32)
    return data.reshape(-1, channels) if channels > 1 else data


def rms_db(samples: np.ndarray) -> float:
    if samples.size == 0:
        return float("-inf")
    value = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    return 20 * np.log10(value) if value > 0 else float("-inf")


def estimate_offset(reference: Path, candidate: Path, max_shift: float = 2.0, analyse_seconds: float = 120.0) -> tuple[float, float]:
    """Offset (seconds) of ``candidate`` relative to ``reference`` from 100 Hz energy envelopes.

    Returns (offset, correlation). Positive offset = candidate starts later (content delayed).
    """
    rate, hop = 8000, 80  # 10 ms envelope resolution
    env = []
    for path in (reference, candidate):
        pcm = read_pcm(path, rate=rate, duration=analyse_seconds)
        n = len(pcm) // hop
        e = np.sqrt(np.mean(pcm[: n * hop].reshape(n, hop) ** 2, axis=1))
        e = (e - e.mean()) / (e.std() + 1e-9)
        env.append(e)
    a, b = env
    shift = int(max_shift * rate / hop)
    n = min(len(a), len(b)) - shift
    if n <= 10:
        return 0.0, 0.0
    best, best_lag = -1e9, 0
    for lag in range(-shift, shift + 1):
        seg_b = b[shift + lag: shift + lag + n] if shift + lag >= 0 else None
        if seg_b is None or len(seg_b) < n:
            continue
        c = float(np.dot(a[shift: shift + n], seg_b) / n)
        if c > best:
            best, best_lag = c, lag
    return round(best_lag * hop / rate, 3), round(best, 3)
