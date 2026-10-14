"""Generate deterministic synthetic test media for Menapoly Cut Cue.

Produces, in the output directory:
  market-mocha-interview.mp4        one speaker, 1280x720 test pattern + speech
  market-mocha-podcast.mp4          two speakers (host/guest voices), fillers, dead air, long pauses
  market-mocha-podcast-stereo.m4a   same podcast as audio, host panned hard left, guest hard right
  music-bed.wav                     30 s 5.5 kHz tone (speech is band-limited below 3.8 kHz, so music level
                                    can be measured separately from speech, e.g. to verify ducking)
  market-mocha-brief.txt / .pdf     creative brief
  <sha256>.transcript.json          ground truth for the fixture transcriber (one per media file)

Speech is synthesized utterance by utterance (FFmpeg flite on Linux, macOS `say` on a Mac) and
joined with known gaps, so utterance start/end times are exact. Word times inside an utterance
are spread evenly (approximate). Ground-truth speaker labels are stored as ``speaker_truth``,
which the app never reads; diarization must find speakers on its own.
Usage: python scripts/make_fixture.py OUT_DIR
"""
from __future__ import annotations

import hashlib
import json
import shutil
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

# (speaker, text, gap after). H = host, G = guest.
PODCAST = [
    ("H", "Welcome to the Market Mocha podcast.", 0.5),
    ("H", "Today I am talking with a roaster who grew her coffee brand online.", 0.9),
    ("G", "Thanks for having me.", 0.4),
    ("G", "Um.", 0.5),
    ("G", "It is great to be here.", 1.1),
    ("H", "So what was the biggest mistake you made in the beginning?", 2.6),
    ("G", "Honestly, we waited far too long to tell our story.", 0.5),
    ("G", "Uh.", 0.4),
    ("G", "People want to know who roasts their beans and why.", 0.8),
    ("H", "That makes sense.", 0.6),
    ("H", "And what changed everything for you?", 1.0),
    ("G", "Here is the secret: we posted one honest video every single week.", 0.5),
    ("G", "Consistency beats perfection every time.", 2.4),
    ("G", "We doubled our subscription sales in three months.", 0.9),
    ("H", "That is an incredible result.", 0.5),
    ("H", "Thanks for listening, and see you next week.", 0.0),
]
PODCAST_LEAD, PODCAST_TAIL = 1.5, 2.0

BRIEF = """Client: Market Mocha (specialty coffee roaster)
Goal: promote the podcast episode about storytelling and weekly video.
Deliverables: a tight rough cut with a strong hook, plus two vertical clips for Instagram Reels.
Key message: consistency beats perfection; honest weekly video doubled subscription sales.
Tone: warm, confident, practical.
"""

FLITE_VOICES = {"H": "slt", "G": "rms"}
SAY_VOICES = {"H": "Samantha", "G": "Daniel"}


def run(args: list[str], cwd: Path | None = None) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True, cwd=cwd).stdout


def duration(path: Path) -> float:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)])
    return float(json.loads(out)["format"]["duration"])


def has_flite() -> bool:
    filters = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    return " flite " in filters


def synthesize(text_file: Path, dest: Path, tmp: Path, speaker: str = "H") -> None:
    """Speech for one utterance: FFmpeg's flite filter (Linux builds) or macOS `say` (Homebrew FFmpeg lacks flite)."""
    if has_flite():
        # Relative textfile path (cwd=tmp) avoids filtergraph escaping of absolute paths.
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"flite=textfile={text_file.name}:voice={FLITE_VOICES[speaker]}",
             "-ar", "48000", "-ac", "1", str(dest)], cwd=tmp)
    elif shutil.which("say"):
        aiff = dest.with_suffix(".aiff")
        run(["say", "-v", SAY_VOICES[speaker], "-o", str(aiff), "-f", str(text_file)])
        run(["ffmpeg", "-y", "-i", str(aiff), "-ar", "48000", "-ac", "1", str(dest)])
    else:
        raise SystemExit("Need FFmpeg built with libflite, or macOS `say`, to synthesize test speech.")


def silence(dest: Path, seconds: float) -> None:
    run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", f"{seconds:.3f}", str(dest)])


def build_speech(utterances: list[tuple[str, str, float]], tmp: Path, lead: float, tail: float, tag: str) -> tuple[Path, list[dict]]:
    """Synthesize utterances with exact gaps. Returns (mono WAV, segments with ground truth)."""
    pieces, segments, t = [], [], lead
    first = tmp / f"{tag}-lead.wav"
    silence(first, lead)
    pieces.append(first)
    for i, (speaker, text, gap) in enumerate(utterances):
        text_file = tmp / f"{tag}{i}.txt"
        text_file.write_text(text)
        speech = tmp / f"{tag}{i}.wav"
        synthesize(text_file, speech, tmp, speaker)
        length = duration(speech)
        words = text.split()
        step = length / len(words)
        segments.append({"start": round(t, 3), "end": round(t + length, 3), "text": text, "speaker_truth": speaker,
                         "words": [{"start": round(t + k * step, 3), "end": round(t + (k + 1) * step, 3), "word": " " + w}
                                   for k, w in enumerate(words)]})
        pieces.append(speech)
        if gap:
            g = tmp / f"{tag}g{i}.wav"
            silence(g, gap)
            pieces.append(g)
        t += length + gap
    if tail:
        end = tmp / f"{tag}-tail.wav"
        silence(end, tail)
        pieces.append(end)
    manifest = tmp / f"{tag}-list.txt"
    manifest.write_text("".join(f"file '{p.name}'\n" for p in pieces))
    audio = tmp / f"{tag}-voice.wav"
    # Band-limit below 3.8 kHz: identical on flite and `say`, and leaves the band above 5 kHz free for the music tests.
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(manifest), "-af", "lowpass=f=3800,lowpass=f=3800",
         "-c:a", "pcm_s16le", str(audio)])
    return audio, segments


def write_transcript(out_dir: Path, media: Path, segments: list[dict]) -> None:
    sha = hashlib.sha256(media.read_bytes()).hexdigest()
    (out_dir / f"{sha}.transcript.json").write_text(json.dumps({"segments": segments}, indent=1))


def video_with_audio(audio: Path, dest: Path) -> None:
    total = duration(audio)
    run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=30:duration={total:.3f}",
         "-i", str(audio), "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-shortest", str(dest)])


def write_pdf(dest: Path, text: str) -> None:
    """Minimal single-page PDF with real text objects (no external libraries)."""
    lines = [ln.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for ln in text.splitlines()]
    body = "BT /F1 11 Tf 50 780 Td 14 TL " + " ".join(f"({ln}) Tj T*" for ln in lines) + " ET"
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
               f"<< /Length {len(body)} >>\nstream\n{body}\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = "%PDF-1.4\n", []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out.encode("latin-1")))
        out += f"{i} 0 obj\n{obj}\nendobj\n"
    xref = len(out.encode("latin-1"))
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010} 00000 n \n" for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    dest.write_bytes(out.encode("latin-1"))


def main(out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        # 1. Single-speaker interview (unchanged timings).
        audio, segments = build_speech([("H", s, g) for s, g in SENTENCES], tmp, 0.6, 0.0, "i")
        for seg in segments:
            seg.pop("speaker_truth")
        video = out_dir / "market-mocha-interview.mp4"
        video_with_audio(audio, video)
        write_transcript(out_dir, video, segments)

        # 2. Two-speaker podcast: mono video + stereo (host left, guest right) audio-only version.
        p_audio, p_segments = build_speech(PODCAST, tmp, PODCAST_LEAD, PODCAST_TAIL, "p")
        podcast = out_dir / "market-mocha-podcast.mp4"
        video_with_audio(p_audio, podcast)
        write_transcript(out_dir, podcast, p_segments)
        host_mask = tmp / "host.wav"
        guest_mask = tmp / "guest.wav"
        expr = lambda who: "+".join(f"between(t,{s['start']:.3f},{s['end']:.3f})" for s in p_segments if s["speaker_truth"] == who)
        run(["ffmpeg", "-y", "-i", str(p_audio), "-af", f"volume='{expr('H')}':eval=frame", str(host_mask)])
        run(["ffmpeg", "-y", "-i", str(p_audio), "-af", f"volume='{expr('G')}':eval=frame", str(guest_mask)])
        stereo = out_dir / "market-mocha-podcast-stereo.m4a"
        run(["ffmpeg", "-y", "-i", str(host_mask), "-i", str(guest_mask), "-filter_complex",
             "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k", str(stereo)])
        write_transcript(out_dir, stereo, p_segments)

    run(["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=5500:sample_rate=48000:duration=30",
         "-ac", "2", str(out_dir / "music-bed.wav")])
    (out_dir / "market-mocha-brief.txt").write_text(BRIEF)
    write_pdf(out_dir / "market-mocha-brief.pdf", BRIEF)
    return video


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    print(main(Path(sys.argv[1])))
