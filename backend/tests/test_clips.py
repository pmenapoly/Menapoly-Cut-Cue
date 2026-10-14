"""AI Clip Factory: moment scoring, brief-driven 9:16 clips, caption accuracy on real renders."""
import hashlib
import json
import re
import subprocess

import pytest
from conftest import upload, wait_jobs

import make_fixture
from cutcue.brief import extract_requirements
from cutcue.documents import parse_captions
from cutcue.moments import TERMINAL, WEAK_OPENERS, find_moments, title_from
from cutcue.podcast import map_to_output
from cutcue.timeline import Clip


def podcast_truth(fixture_dir):
    sha = hashlib.sha256((fixture_dir / "market-mocha-podcast.mp4").read_bytes()).hexdigest()
    segs = json.loads((fixture_dir / f"{sha}.transcript.json").read_text())["segments"]
    return [{**s, "speaker": "S1" if s["speaker_truth"] == "H" else "S2"} for s in segs]


def norm(text):
    return " ".join(re.findall(r"[a-z0-9']+", text.lower()))


def test_moments_are_self_contained_and_brief_driven(fixture_dir):
    segs = podcast_truth(fixture_dir)
    req = extract_requirements(make_fixture.BRIEF)
    chosen, ranked = find_moments("ast_x", segs, req, count=2, min_s=10, max_s=30)
    assert len(chosen) == 2 and ranked[0].score >= ranked[-1].score
    for c in chosen:
        first_word = re.sub(r"[^a-z']", "", c.first_line.split()[0].lower())
        assert first_word not in WEAK_OPENERS
        assert TERMINAL.search(c.text.strip())
        assert 10 <= c.est_duration <= 30
        assert c.reasons
    assert chosen[0].end + 1 <= chosen[1].start
    assert any("consistency" in c.text.lower() or "doubled" in c.text.lower() for c in chosen)
    # A must-avoid phrase removes every window that contains it.
    chosen, ranked = find_moments("ast_x", segs, {**req, "must_avoid": ["secret"]}, count=3, min_s=10, max_s=30)
    assert all("secret" not in c.text.lower() for c in ranked)


def test_title_from():
    assert title_from("Here is the secret: we posted one honest video every single week.") == "Here is the secret"
    assert len(title_from("Consistency beats perfection every time and every single day of the year.")) <= 42


def test_clip_factory_end_to_end(client, services, fixture_dir, tmp_path):
    pid = client.post("/api/projects", json={"name": "Clips"}).json()["id"]
    asset = upload(client, pid, fixture_dir / "market-mocha-podcast.mp4", chunk=8 * 1024 * 1024)
    upload(client, pid, fixture_dir / "market-mocha-brief.txt")
    wait_jobs(services)
    guest = next(s["speaker"] for s in client.get(f"/api/projects/{pid}/assets/{asset['id']}/transcript").json()
                 if "roaster" not in s["text"] and s["text"].startswith("Thanks for having"))
    client.patch(f"/api/projects/{pid}/assets/{asset['id']}/speakers", json={"labels": {guest: {"focus_x": 0.2}}})

    preview = client.get(f"/api/projects/{pid}/moments", params={"count": 2}).json()
    assert preview["settings"]["count"] == 2 and preview["settings"]["from_brief"]  # "two vertical clips" in the brief
    r = client.post(f"/api/projects/{pid}/clip-factory", json={"min_s": 10, "max_s": 30, "titles": True})
    assert r.status_code == 201, r.text
    proposal = r.json()
    seqs = proposal["plan"]["sequences"]
    assert len(seqs) == 2 and proposal["created_by"] == "clip-factory"
    assert proposal["plan"]["notes"]["clip_factory"]["candidates"][0]["reasons"]
    for spec in seqs:
        tl = spec["timeline"]
        assert tl["aspect"] == "9:16" and tl["burn_captions"] and 0 < len(tl["title"]) <= 42
        assert tl["audio"]["loudness_target"] == -14.0
        assert 8 <= spec["duration"] <= 31
        assert spec["compliance"]["deliverable"]["kind"] == "clip"
    focus = {c["focus_x"] for s in seqs for c in s["timeline"]["clips"]}
    assert 0.2 in focus  # at least one clip is led by the guest and framed on them

    approved = client.post(f"/api/projects/{pid}/proposals/{proposal['id']}/approve").json()
    wait_jobs(services, timeout=600)
    renders = {r["sequence_id"]: r for r in client.get(f"/api/projects/{pid}/renders").json()}
    segments = services.transcript(asset["id"])
    for created, spec in zip(approved["result"]["created"], seqs):
        render = renders[created["sequence_id"]]
        assert render["status"] == "succeeded", render
        out = services.renders_dir(pid) / render["output_name"]
        info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height:format=duration",
                                          "-of", "json", str(out)], capture_output=True, text=True, check=True).stdout)
        v = next(st for st in info["streams"] if st.get("width"))
        assert (v["width"], v["height"]) == (360, 640)
        assert float(info["format"]["duration"]) == pytest.approx(spec["duration"], abs=0.35)

        cues = parse_captions(client.get(f"/api/projects/{pid}/renders/{render['id']}/srt").text)
        clips = [Clip(**c) for c in spec["timeline"]["clips"]]
        expected = [w for s in segments for w in s["words"] if map_to_output(clips, (w["start"] + w["end"]) / 2) is not None]
        assert norm(" ".join(c["text"] for c in cues)) == norm(" ".join(w["word"] for w in expected))
        for a, b in zip(cues, cues[1:]):
            assert a["start"] < a["end"] <= b["start"]
        assert cues[-1]["end"] <= spec["duration"] + 0.3
        # Each cue starts where its first word lands in the output (caption sync).
        words_iter = iter(expected)
        for cue in cues:
            first = next(words_iter)
            for _ in range(len(cue["text"].split()) - 1):
                next(words_iter)
            assert cue["start"] == pytest.approx(map_to_output(clips, max(first["start"], clips[0].start)) or 0.0, abs=0.06)

    # Asking again avoids the moments already used: either new, non-overlapping clips or a clear message.
    again = client.post(f"/api/projects/{pid}/clip-factory", json={"min_s": 10, "max_s": 30})
    if again.status_code == 201:
        used = [(c["start"], c["end"]) for s in seqs for c in s["timeline"]["clips"]]
        for s in again.json()["plan"]["sequences"]:
            for c in s["timeline"]["clips"]:
                assert all(c["end"] <= a or c["start"] >= b for a, b in used)
    else:
        assert again.status_code == 400 and "No self-contained moment" in again.json()["detail"]
