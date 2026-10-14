"""Podcast Auto-Editor and speaker detection on the two-speaker fixture, with real renders."""
import hashlib
import json
import re
import subprocess

import pytest
from conftest import upload, wait_jobs

from cutcue.podcast import AutoEditOptions, auto_edit, map_to_output
from cutcue.timeline import Clip


def truth(fixture_dir, name):
    sha = hashlib.sha256((fixture_dir / name).read_bytes()).hexdigest()
    return json.loads((fixture_dir / f"{sha}.transcript.json").read_text())["segments"]


def speaker_accuracy(segments, truth_segments):
    mapping = {}
    for seg, t in zip(segments, truth_segments):
        mapping.setdefault(seg["speaker"], t["speaker_truth"])
    return sum(mapping[s["speaker"]] == t["speaker_truth"] for s, t in zip(segments, truth_segments)) / len(segments)


def podcast_project(client, services, fixture_dir, name="market-mocha-podcast.mp4"):
    pid = client.post("/api/projects", json={"name": "Podcast"}).json()["id"]
    asset = upload(client, pid, fixture_dir / name, chunk=8 * 1024 * 1024)
    wait_jobs(services)
    return pid, asset


@pytest.mark.parametrize("name,method", [("market-mocha-podcast.mp4", "acoustic"), ("market-mocha-podcast-stereo.m4a", "channels")])
def test_speakers_identified(client, services, fixture_dir, name, method):
    pid, asset = podcast_project(client, services, fixture_dir, name)
    jobs = {j["type"]: j["status"] for j in client.get(f"/api/projects/{pid}/jobs").json()}
    assert jobs.get("diarize") == "succeeded", jobs
    speakers = client.get(f"/api/projects/{pid}/assets/{asset['id']}/speakers").json()
    assert speakers["method"] == method and set(speakers["labels"]) == {"S1", "S2"}
    segments = client.get(f"/api/projects/{pid}/assets/{asset['id']}/transcript").json()
    assert speaker_accuracy(segments, truth(fixture_dir, name)) >= 0.9
    assert all(w.get("speaker") for s in segments for w in s["words"])
    # Rename and frame a speaker; re-running keeps names.
    r = client.patch(f"/api/projects/{pid}/assets/{asset['id']}/speakers",
                     json={"labels": {"S1": {"name": "Host", "focus_x": 0.3}}}).json()
    assert r["labels"]["S1"] == {**r["labels"]["S1"], "name": "Host", "focus_x": 0.3}
    assert client.post(f"/api/projects/{pid}/assets/{asset['id']}/diarize", json={"num_speakers": 2}).status_code == 201
    wait_jobs(services)
    assert client.get(f"/api/projects/{pid}/assets/{asset['id']}/speakers").json()["labels"]["S1"]["name"] == "Host"


def test_auto_edit_flow_rules_and_render(client, services, fixture_dir, tmp_path):
    pid, asset = podcast_project(client, services, fixture_dir)
    segs_truth = truth(fixture_dir, "market-mocha-podcast.mp4")
    r = client.post(f"/api/projects/{pid}/auto-edit", json={"asset_id": asset["id"]})
    assert r.status_code == 201, r.text
    proposal = r.json()
    assert proposal["status"] == "pending" and proposal["created_by"] == "auto-editor"
    report = proposal["plan"]["notes"]["auto_edit"]
    assert [f["word"] for f in report["fillers_removed"]] == ["Um.", "Uh."]
    assert report["dead_air_trimmed"] == pytest.approx(1.25 + 1.5, abs=0.05)
    assert report["pauses_tightened"] >= 6 and report["removed_seconds"] > 8

    clips = [Clip(**c) for c in proposal["plan"]["sequences"][0]["timeline"]["clips"]]
    # Fillers are gone from the cut.
    for f in report["fillers_removed"]:
        assert map_to_output(clips, (f["start"] + f["end"]) / 2) is None
    # Every utterance survives, and the pause before it follows the flow rules.
    speech = [s for s in segs_truth if s["text"] not in ("Um.", "Uh.")]
    for prev, nxt in zip(speech, speech[1:]):
        a, b = map_to_output(clips, prev["end"] - 0.01), map_to_output(clips, nxt["start"] + 0.01)
        assert a is not None and b is not None, (prev["text"], nxt["text"])
        out_gap, src_gap = b - a - 0.02, nxt["start"] - prev["end"]
        turn = prev["speaker_truth"] != nxt["speaker_truth"] or prev["text"].endswith("?")
        target = 0.6 if turn else 0.35
        if src_gap <= target + 0.12:
            assert out_gap == pytest.approx(src_gap, abs=0.03)  # short pauses untouched
        else:
            assert out_gap == pytest.approx(target, abs=0.06), (prev["text"], nxt["text"], out_gap)

    approved = client.post(f"/api/projects/{pid}/proposals/{proposal['id']}/approve").json()
    wait_jobs(services, timeout=600)
    render = client.get(f"/api/projects/{pid}/renders").json()[0]
    assert render["status"] == "succeeded", render
    out = services.renders_dir(pid) / render["output_name"]
    duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
                                    capture_output=True, text=True, check=True).stdout)
    assert duration == pytest.approx(approved["plan"]["sequences"][0]["duration"], abs=0.35)
    # No dead air left: no silence of 0.75 s or more anywhere in the rendered program.
    log = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(out), "-af", "silencedetect=noise=-45dB:d=0.75", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    assert not re.findall(r"silence_duration: ([\d.]+)", log), log[-500:]


def test_auto_edit_can_drop_a_speaker(client, services, fixture_dir):
    pid, asset = podcast_project(client, services, fixture_dir)
    segments = client.get(f"/api/projects/{pid}/assets/{asset['id']}/transcript").json()
    host = segments[0]["speaker"]
    r = client.post(f"/api/projects/{pid}/auto-edit", json={"asset_id": asset["id"], "options": {"exclude_speakers": [host]}}).json()
    clips = [Clip(**c) for c in r["plan"]["sequences"][0]["timeline"]["clips"]]
    for seg in segments:
        mid = (seg["start"] + seg["end"]) / 2
        kept = map_to_output(clips, mid) is not None
        assert kept == (seg["speaker"] != host and seg["text"] not in ("Um.", "Uh.")), seg["text"]


def test_auto_edit_respects_untranscribed_sound():
    """A long gap that is NOT silent (laughter, music) must not be cut."""
    segs = [{"start": 0.0, "end": 1.0, "text": "Hello there.", "speaker": "S1",
             "words": [{"start": 0.0, "end": 0.5, "word": " Hello"}, {"start": 0.5, "end": 1.0, "word": " there."}]},
            {"start": 4.0, "end": 5.0, "text": "Back again.", "speaker": "S1",
             "words": [{"start": 4.0, "end": 4.5, "word": " Back"}, {"start": 4.5, "end": 5.0, "word": " again."}]}]
    clips, report = auto_edit("ast_x", 5.0, segs, [{"start": 1.0, "end": 1.6}], AutoEditOptions())
    removed = 5.0 - sum(c.end - c.start for c in clips)
    assert removed == pytest.approx(1.6 - (1.0 + 0.175), abs=0.01)  # only the silent part of the gap is cut
    clips, _ = auto_edit("ast_x", 5.0, segs, None, AutoEditOptions())  # no silence data: gap retimed fully
    assert 5.0 - sum(c.end - c.start for c in clips) == pytest.approx(3.0 - 0.35, abs=0.01)


def test_auto_edit_needs_transcript(client, services, fixture_dir, tmp_path):
    pid = client.post("/api/projects", json={"name": "No transcript"}).json()["id"]
    plain = tmp_path / "tone.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", str(plain)], check=True)
    asset = upload(client, pid, plain)
    wait_jobs(services)
    r = client.post(f"/api/projects/{pid}/auto-edit", json={"asset_id": asset["id"]})
    assert r.status_code == 400 and "transcript" in r.json()["detail"]
