"""Check that this machine can run Menapoly Cut Cue. Prints fixes for anything missing."""
from __future__ import annotations

import importlib
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
ok = True


def report(good: bool, label: str, fix: str = "") -> None:
    global ok
    ok &= good
    print(f"  [{'ok' if good else '!!'}] {label}" + (f"\n       -> {fix}" if not good and fix else ""))


def main() -> int:
    print("Menapoly Cut Cue dependency check\n")
    print(f"  machine: {platform.system()} {platform.machine()}, {os.cpu_count()} CPU threads, Python {platform.python_version()}")
    report(sys.version_info >= (3, 10), "Python 3.10+", "brew install python@3.12")
    for tool in ("ffmpeg", "ffprobe"):
        report(shutil.which(tool) is not None, tool, "brew install ffmpeg")
    if shutil.which("ffmpeg"):
        filters = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        for name in ("silencedetect", "scdet", "loudnorm", "subtitles", "showwaves"):
            report(f" {name} " in filters, f"ffmpeg filter '{name}'", "brew reinstall ffmpeg (needs libass for subtitles)")
        from cutcue.media import pick_video_encoder
        enc = pick_video_encoder("auto")
        print(f"  [--] final-export encoder: {enc}" + (" (Mac hardware encoder)" if enc != "libx264" else ""))
    for module, pip in (("fastapi", "fastapi"), ("uvicorn", "uvicorn"), ("anthropic", "anthropic"),
                        ("faster_whisper", "faster-whisper"), ("pypdf", "pypdf"), ("docx", "python-docx")):
        try:
            importlib.import_module(module)
            report(True, f"python package {pip}")
        except ImportError:
            report(False, f"python package {pip}", "make setup")
    node = shutil.which("node")
    report(node is not None, "Node.js (for the browser UI)", "brew install node")
    report((ROOT / "frontend" / "node_modules").is_dir(), "frontend dependencies", "make setup")
    from cutcue.config import load_settings
    s = load_settings()
    report((ROOT / ".env").is_file(), ".env file", "cp .env.example .env")
    print(f"  [--] assistant: {'Claude (' + s.claude_model + ')' if s.claude_enabled else 'local test mode (set ANTHROPIC_API_KEY for Claude)'}")
    print(f"  [--] transcription: {s.transcriber} model={s.whisper_model} compute={s.whisper_compute_type}")
    if s.transcriber == "faster-whisper":
        cache = Path.home() / ".cache" / "huggingface" / "hub"
        cached = any(cache.glob(f"models--Systran--faster-whisper-{s.whisper_model}*")) if cache.is_dir() else False
        print(f"  [--] whisper model cached: {'yes' if cached else 'no (downloads ~75-500 MB on first transcription)'}")
    print(f"  [--] data directory: {s.data_dir}")
    print(f"  [--] cloud worker: {'configured' if s.cloud_configured else 'off (local only)'}")
    print("\nAll required dependencies found." if ok else "\nSome dependencies are missing (see -> fixes above).")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
