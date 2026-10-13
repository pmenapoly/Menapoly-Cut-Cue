"""Brief/document parsing (PDF, DOCX, TXT/MD) and caption parsing (SRT, VTT).

Document text is untrusted data: it is shown to Claude inside clearly delimited blocks
and never treated as instructions.
"""
from __future__ import annotations

import re
from pathlib import Path

MAX_DOC_CHARS = 200_000


def extract_text(path: Path, ext: str) -> str:
    ext = ext.lower()
    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(str(path))
        text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
    elif ext == ".docx":
        import docx

        document = docx.Document(str(path))
        text = "\n".join(p.text for p in document.paragraphs)
    elif ext in {".txt", ".md"}:
        text = path.read_bytes().decode("utf-8", errors="strict")
    else:
        raise ValueError(f"Unsupported document type {ext}")
    return text.strip()[:MAX_DOC_CHARS]


_TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")


def _ts(value: str) -> float:
    m = _TS.search(value)
    if not m:
        raise ValueError(f"Bad timestamp {value!r}")
    hours, minutes, seconds, frac = m.groups()
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int(frac.ljust(3, "0")) / 1000


def parse_captions(text: str) -> list[dict]:
    """Parse SRT or WebVTT into [{start, end, text}]."""
    cues: list[dict] = []
    blocks = re.split(r"\r?\n\s*\r?\n", text.replace("﻿", "").strip())
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        timing_index = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if timing_index is None:
            continue
        left, right = lines[timing_index].split("-->", 1)
        start, end = _ts(left), _ts(right.strip().split(" ")[0])
        body = " ".join(re.sub(r"<[^>]+>", "", ln).strip() for ln in lines[timing_index + 1:]).strip()
        if body and end > start:
            cues.append({"start": round(start, 3), "end": round(end, 3), "text": body, "words": []})
    if not cues:
        raise ValueError("No captions found")
    return cues


def format_srt_time(seconds: float) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def to_srt(cues: list[dict]) -> str:
    out = []
    for i, cue in enumerate(cues, start=1):
        out.append(f"{i}\n{format_srt_time(cue['start'])} --> {format_srt_time(cue['end'])}\n{cue['text']}\n")
    return "\n".join(out)
