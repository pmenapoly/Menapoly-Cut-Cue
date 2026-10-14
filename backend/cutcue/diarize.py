"""Local speaker diarization (who spoke when), CPU-only numpy, no model downloads.

Two strategies, chosen automatically:

* ``channels``: stereo recordings where each speaker has their own channel (common for
  remote podcasts and two-mic setups). The dominant channel per word decides the speaker.
* ``acoustic``: mono or mixed recordings. MFCC timbre features over ~1.5 s speech windows,
  standardized, clustered with deterministic k-means; the number of speakers is chosen by
  silhouette score unless given. Labels are smoothed within transcript segments.

Accuracy on real recordings is lower than on the synthetic fixtures (different voices of
similar timbre, crosstalk, music). The result is stored with a confidence score and speaker
labels can be renamed, re-run with a fixed count, or ignored.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

RATE = 16000
FRAME, HOP, NFFT = 400, 160, 512  # 25 ms frames, 10 ms hop
N_MELS, N_MFCC = 26, 13


def _mel_filterbank(low: float = 80.0, high: float = 3800.0) -> np.ndarray:
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    inv = lambda m: 700 * (10 ** (m / 2595) - 1)
    points = inv(np.linspace(mel(low), mel(high), N_MELS + 2))
    bins = np.floor((NFFT + 1) * points / RATE).astype(int)
    fb = np.zeros((N_MELS, NFFT // 2 + 1))
    for i in range(1, N_MELS + 1):
        left, centre, right = bins[i - 1], bins[i], bins[i + 1]
        for k in range(left, centre):
            fb[i - 1, k] = (k - left) / max(1, centre - left)
        for k in range(centre, right):
            fb[i - 1, k] = (right - k) / max(1, right - centre)
    return fb


_FB = _mel_filterbank()
_DCT = np.cos(np.pi / N_MELS * (np.arange(N_MELS) + 0.5)[None, :] * np.arange(N_MFCC)[:, None])
_WINDOW = np.hamming(FRAME)


def mfcc_frames(path: Path, chunk_seconds: int = 300) -> np.ndarray:
    """MFCCs (frames x 13) at 100 frames/s, decoded in chunks so long episodes stay small in RAM."""
    proc = subprocess.Popen(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-vn", "-ac", "1",
                             "-ar", str(RATE), "-f", "f32le", "-"], stdout=subprocess.PIPE)
    assert proc.stdout
    out, carry = [], np.zeros(0, dtype=np.float32)
    while True:
        raw = proc.stdout.read(RATE * chunk_seconds * 4)
        data = np.concatenate([carry, np.frombuffer(raw, dtype=np.float32)]) if raw else carry
        n = (len(data) - FRAME) // HOP + 1 if len(data) >= FRAME else 0
        if n > 0:
            idx = np.arange(FRAME)[None, :] + HOP * np.arange(n)[:, None]
            frames = data[idx] * _WINDOW
            power = np.abs(np.fft.rfft(frames, NFFT)) ** 2 / NFFT
            logmel = np.log(np.maximum(power @ _FB.T, 1e-10))
            out.append((logmel @ _DCT.T).astype(np.float32))
            carry = data[n * HOP:]
        if not raw:
            break
    proc.wait()
    return np.concatenate(out) if out else np.zeros((0, N_MFCC), dtype=np.float32)


def _kmeans(x: np.ndarray, k: int, iters: int = 50) -> np.ndarray:
    """Deterministic k-means: farthest-point initialisation from the global mean."""
    centres = [x[np.argmax(np.linalg.norm(x - x.mean(0), axis=1))]]
    while len(centres) < k:
        d = np.min([np.linalg.norm(x - c, axis=1) for c in centres], axis=0)
        centres.append(x[np.argmax(d)])
    c = np.array(centres)
    labels = np.zeros(len(x), dtype=int)
    for _ in range(iters):
        new = np.argmin(((x[:, None, :] - c[None]) ** 2).sum(-1), axis=1)
        if np.array_equal(new, labels) and _ > 0:
            break
        labels = new
        c = np.array([x[labels == j].mean(0) if np.any(labels == j) else c[j] for j in range(k)])
    return labels


def _silhouette(x: np.ndarray, labels: np.ndarray, max_points: int = 1200) -> float:
    """Mean silhouette on an evenly spaced subsample (bounded memory: <= 1200^2 distances)."""
    if len(set(labels)) < 2:
        return 0.0
    step = max(1, len(x) // max_points)
    x, labels = x[::step], labels[::step]
    if len(set(labels)) < 2:
        return 0.0
    sq = (x ** 2).sum(1)
    d = np.sqrt(np.maximum(sq[:, None] + sq[None, :] - 2 * x @ x.T, 0))
    scores = []
    for i in range(len(x)):
        same = labels == labels[i]
        a = d[i, same].sum() / max(1, same.sum() - 1)
        b = min(d[i, labels == j].mean() for j in set(labels) if j != labels[i])
        scores.append((b - a) / max(a, b, 1e-9))
    return float(np.mean(scores))


def _speech_spans(words: list[dict], segments: list[dict]) -> list[tuple[float, float]]:
    if words:
        return [(w["start"], w["end"]) for w in words]
    return [(s["start"], s["end"]) for s in segments]


def channel_labels(path: Path, spans: list[tuple[float, float]], threshold_db: float = 6.0) -> list[int] | None:
    """Per-span dominant stereo channel, or None if the recording is not split by channel."""
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-vn", "-ac", "2",
                          "-ar", "8000", "-f", "f32le", "-"], capture_output=True).stdout
    pcm = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)
    labels, decisive = [], 0
    for start, end in spans:
        part = pcm[int(start * 8000): max(int(end * 8000), int(start * 8000) + 1)]
        if len(part) == 0:
            labels.append(-1)
            continue
        l, r = np.sqrt(np.mean(part.astype(np.float64) ** 2, axis=0)) + 1e-9
        diff = 20 * np.log10(l / r)
        decisive += abs(diff) >= threshold_db
        labels.append(0 if diff > 0 else 1)
    if not spans or decisive / len(spans) < 0.7 or len(set(x for x in labels if x >= 0)) < 2:
        return None
    return labels


def acoustic_labels(path: Path, spans: list[tuple[float, float]], num_speakers: int | None,
                    window: float = 1.5, hop: float = 0.75) -> tuple[list[int], float]:
    mf = mfcc_frames(path)
    if len(mf) == 0 or not spans:
        return [0] * len(spans), 0.0
    speech = np.zeros(len(mf), dtype=bool)
    for start, end in spans:
        speech[int(start * 100): int(end * 100) + 1] = True
    first, last = spans[0][0], spans[-1][1]
    centres, feats = [], []
    t = first
    while t < last:
        lo, hi = int(t * 100), int((t + window) * 100)
        sel = mf[lo:hi][speech[lo:hi]][:, 1:]  # drop c0 (loudness)
        if len(sel) >= 40:
            feats.append(np.concatenate([sel.mean(0), sel.std(0)]))
            centres.append(t + window / 2)
        t += hop
    if len(feats) < 4:
        return [0] * len(spans), 0.0
    x = np.array(feats)
    x = (x - x.mean(0)) / (x.std(0) + 1e-9)
    if num_speakers:
        k_best = max(1, min(num_speakers, len(x)))
        labels = _kmeans(x, k_best) if k_best > 1 else np.zeros(len(x), dtype=int)
        score = _silhouette(x, labels)
    else:
        k_best, labels, score = 1, np.zeros(len(x), dtype=int), 0.0
        for k in range(2, min(5, len(x))):
            cand = _kmeans(x, k)
            s = _silhouette(x, cand)
            if s > score + 0.02:
                k_best, labels, score = k, cand, s
        if score < 0.12:  # no convincing split: treat as one speaker
            k_best, labels = 1, np.zeros(len(x), dtype=int)
    centres = np.array(centres)
    out = []
    for start, end in spans:
        mid = (start + end) / 2
        out.append(int(labels[int(np.argmin(np.abs(centres - mid)))]))
    return out, round(score, 3)


def diarize(path: Path, segments: list[dict], channels: int, num_speakers: int | None = None) -> dict:
    """Returns {"method", "confidence", "segment_speakers": [...], "word_speakers": [[...] per segment]}."""
    words = [w for s in segments for w in (s.get("words") or [])]
    spans = _speech_spans(words, segments)
    method, confidence = "acoustic", 0.0
    labels = channel_labels(path, spans) if channels >= 2 and num_speakers in (None, 2) else None
    if labels is not None:
        method, confidence = "channels", 1.0
    else:
        labels, confidence = acoustic_labels(path, spans, num_speakers)
    # Map raw cluster ids to S1, S2… in order of first appearance.
    order: dict[int, str] = {}
    for lab in labels:
        if lab >= 0 and lab not in order:
            order[lab] = f"S{len(order) + 1}"
    names = [order.get(lab, "S1") for lab in labels]

    seg_speakers, word_speakers, i = [], [], 0
    for seg in segments:
        n = len(seg.get("words") or []) if words else 1
        own = names[i: i + n]
        i += n
        # Smooth isolated flips inside a segment (3-word majority), then segment majority.
        smooth = [max(set(own[max(0, j - 1): j + 2]), key=own[max(0, j - 1): j + 2].count) for j in range(len(own))]
        word_speakers.append(smooth if words else [])
        seg_speakers.append(max(set(smooth), key=smooth.count) if smooth else "S1")
    # Very short utterances ("Um.", "Yeah.") carry too little audio to classify: if both neighbours
    # agree, take their speaker.
    for j in range(1, len(segments) - 1):
        if segments[j]["end"] - segments[j]["start"] < 1.0 and seg_speakers[j - 1] == seg_speakers[j + 1] != seg_speakers[j]:
            seg_speakers[j] = seg_speakers[j - 1]
            if word_speakers[j]:
                word_speakers[j] = [seg_speakers[j]] * len(word_speakers[j])
    return {"method": method, "confidence": confidence, "segment_speakers": seg_speakers, "word_speakers": word_speakers,
            "speakers": sorted(set(seg_speakers))}
