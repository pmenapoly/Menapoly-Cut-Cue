"""Transcription engines.

* ``faster-whisper`` (default): local CPU int8 inference, suited to Intel Macs. The model
  downloads once from Hugging Face into the local cache on first use.
* ``fixture``: test-only. Loads a ground-truth transcript keyed by the file's SHA-256 from
  ``CUTCUE_FIXTURE_DIR``. Used by the automated tests for synthetic speech whose exact
  wording and timing are known. Never enabled by default.
* ``none``: transcription disabled; import SRT/VTT captions instead.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Callable

from .media import CancelToken

Segment = dict  # {"start": float, "end": float, "text": str, "words": [{"start","end","word"}]}


class TranscriptionUnavailable(RuntimeError):
    pass


_model_lock = threading.Lock()
_model_cache: dict[tuple, object] = {}


def _whisper_model(name: str, compute_type: str, cpu_threads: int):
    key = (name, compute_type, cpu_threads)
    with _model_lock:
        if key not in _model_cache:
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:  # pragma: no cover - depends on install
                raise TranscriptionUnavailable("faster-whisper is not installed (pip install -r backend/requirements.txt)") from exc
            threads = cpu_threads or max(1, (os.cpu_count() or 4))
            _model_cache.clear()  # keep only one model resident: 16 GB machines
            _model_cache[key] = WhisperModel(name, device="cpu", compute_type=compute_type, cpu_threads=threads)
        return _model_cache[key]


def transcribe_faster_whisper(wav: Path, duration: float | None, *, model: str, compute_type: str,
                              cpu_threads: int, language: str, progress: Callable[[float], None],
                              cancel: CancelToken) -> list[Segment]:
    try:
        whisper = _whisper_model(model, compute_type, cpu_threads)
    except TranscriptionUnavailable:
        raise
    except Exception as exc:  # model download / load failures
        raise TranscriptionUnavailable(f"Could not load Whisper model '{model}': {exc}") from exc
    segments_iter, _info = whisper.transcribe(
        str(wav), language=language or None, word_timestamps=True, vad_filter=True,
        beam_size=1, condition_on_previous_text=False,
    )
    out: list[Segment] = []
    for seg in segments_iter:
        cancel.check()
        words = [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word} for w in (seg.words or [])]
        text = seg.text.strip()
        if text:
            out.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": text, "words": words})
        if duration:
            progress(min(1.0, seg.end / duration))
    return out


def transcribe_fixture(sha256: str) -> list[Segment]:
    directory = os.environ.get("CUTCUE_FIXTURE_DIR")
    if not directory:
        raise TranscriptionUnavailable("Fixture transcriber selected but CUTCUE_FIXTURE_DIR is not set")
    path = Path(directory) / f"{sha256}.transcript.json"
    if not path.is_file():
        raise TranscriptionUnavailable("No fixture transcript for this file")
    return json.loads(path.read_text())["segments"]
