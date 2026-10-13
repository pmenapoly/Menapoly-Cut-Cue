"""Generate a synthetic test interview for Menapoly Cut Cue.

Produces, in the output directory:
  market-mocha-interview.mp4   1280x720 test-pattern video with synthesized speech (FFmpeg flite)
  market-mocha-brief.txt       a creative brief
  <sha256>.transcript.json     ground-truth sentence timings for the fixture transcriber

Speech is synthesized sentence by sentence and joined with known gaps, so sentence
start/end times are exact. Word times inside a sentence are spread evenly (approximate).
Usage: python scripts/make_fixture.py OUT_DIR
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SENTENCES = [
    ("Welcome back to the Market Mocha podcast.", 0.4),
    ("Today we are talking about how small coffee brands win online.", 1.8),
    ("The biggest mistake founders make is waiting too long to tell their story.", 0.5),
    ("Your customers want to know who roasts their beans and why.", 2.2),
    ("Here is the secret: post one honest video every single week.", 0.4),
    ("Consistency beats perfection every time.", 1.5),
    ("We doubled our subscription sales in three months with that one habit.", 0.6),
    ("Thanks for listening, and see you next week.", 1.0),
]

BRIEF = """Client: Market Mocha (specialty coffee roaster)
Goal: promote the podcast episode about storytelling and weekly video.
Deliverables: a tight rough cut with a strong hook, plus two vertical clips for Instagram Reels.
Key message: consistency beats perfection; honest weekly video doubled subscription sales.
Tone: warm, confident, practical.
"""


def run(args: list[str]) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def duration(path: Path) -> float:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)])
    return float(json.loads(out)["format"]["duration"])


def main(out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        pieces, segments, t = [], [], 0.6
        lead = tmp / "lead.wav"
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.6", str(lead)])
        pieces.append(lead)
        for i, (sentence, gap) in enumerate(SENTENCES):
            text_file = tmp / f"s{i}.txt"
            text_file.write_text(sentence)
            speech = tmp / f"s{i}.wav"
            # Relative textfile path (cwd=tmp) avoids filtergraph escaping of absolute paths.
            subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"flite=textfile={text_file.name}:voice=slt",
                            "-ar", "48000", "-ac", "1", str(speech)], check=True, capture_output=True, cwd=tmp)
            length = duration(speech)
            words = sentence.split()
            step = length / len(words)
            segments.append({"start": round(t, 3), "end": round(t + length, 3), "text": sentence,
                             "words": [{"start": round(t + k * step, 3), "end": round(t + (k + 1) * step, 3),
                                        "word": " " + w} for k, w in enumerate(words)]})
            silence = tmp / f"g{i}.wav"
            run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", str(gap), str(silence)])
            pieces += [speech, silence]
            t += length + gap
        manifest = tmp / "list.txt"
        manifest.write_text("".join(f"file '{p.name}'\n" for p in pieces))
        audio = tmp / "voice.wav"
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(manifest), "-c:a", "pcm_s16le", str(audio)])
        total = duration(audio)
        video = out_dir / "market-mocha-interview.mp4"
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=30:duration={total:.3f}",
             "-i", str(audio), "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "128k", "-shortest", str(video)])
    (out_dir / "market-mocha-brief.txt").write_text(BRIEF)
    sha = hashlib.sha256(video.read_bytes()).hexdigest()
    (out_dir / f"{sha}.transcript.json").write_text(json.dumps({"segments": segments}, indent=1))
    return video


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    print(main(Path(sys.argv[1])))
