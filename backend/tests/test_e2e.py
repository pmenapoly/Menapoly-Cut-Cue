"""End-to-end acceptance workflow on real media and real FFmpeg renders.

Create 'Market Mocha Test' -> upload interview + brief -> analyze/transcribe -> ask the
(local test mode) editor for a rough cut with a hook, pause removal and two vertical
clips -> approve -> render real MP4 + SRT -> manual revision -> compare -> restore ->
final export with WAV.
"""
import json
import subprocess

import pytest
from conftest import upload, wait_jobs


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def test_full_workflow(client, services, fixture_dir, tmp_path):
    health = client.get("/api/health").json()
    assert health["app"] == "Menapoly Cut Cue" and health["ffmpeg"] and health["assistant_mode"] == "local-test"

    pid = client.post("/api/projects", json={"name": "Market Mocha Test"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=4 * 1024 * 1024)
    brief = upload(client, pid, fixture_dir / "market-mocha-brief.txt")
    assert video["kind"] == "video" and video["duration"] > 25
    assert brief["kind"] == "document" and brief["status"] == "ready"
    wait_jobs(services)

    vid = video["id"]
    asset = client.get(f"/api/projects/{pid}/assets/{vid}").json()
    assert asset["status"] == "ready" and asset["has_transcript"]
    assert len(asset["silences"]) >= 4, "silencedetect should find the inserted gaps"
    assert client.get(f"/api/projects/{pid}/assets/{vid}/thumbnail").status_code == 200
    media = client.get(f"/api/projects/{pid}/assets/{vid}/media", headers={"Range": "bytes=0-99"})
    assert media.status_code == 206 and len(media.content) == 100

    transcript = client.get(f"/api/projects/{pid}/assets/{vid}/transcript").json()
    assert transcript[0]["text"].startswith("Welcome back")
    hits = client.get(f"/api/projects/{pid}/search", params={"q": "consistency perfection"}).json()
    assert hits and "Consistency beats perfection" in hits[0]["text"]

    # Chat (local deterministic test mode, clearly labeled)
    reply = client.post(f"/api/projects/{pid}/chat",
                        json={"message": "Make a rough cut with a hook, remove pauses, and create two vertical clips"}).json()
    assert reply["mode"] == "local-test" and "Local test mode" in reply["reply"]
    assert len(reply["proposal_ids"]) == 1
    proposal = client.get(f"/api/projects/{pid}/proposals").json()[0]
    names = [s["name"] for s in proposal["plan"]["sequences"]]
    assert names == ["Rough cut", "Vertical clip 1", "Vertical clip 2"]
    rough = proposal["plan"]["sequences"][0]
    assert rough["timeline"]["clips"][0]["label"] == "Hook"
    assert rough["duration"] < video["duration"] + 6, "pause removal should tighten the main cut"
    assert rough["clip_count"] > 3

    approved = client.post(f"/api/projects/{pid}/proposals/{proposal['id']}/approve").json()
    assert approved["status"] == "approved" and len(approved["result"]["created"]) == 3
    wait_jobs(services, timeout=600)

    renders = client.get(f"/api/projects/{pid}/renders").json()
    assert len(renders) == 3 and all(r["status"] == "succeeded" for r in renders), renders
    for r in renders:
        mp4 = client.get(f"/api/projects/{pid}/renders/{r['id']}/mp4")
        assert mp4.status_code == 200 and mp4.headers["content-type"] == "video/mp4"
        path = tmp_path / f"{r['id']}.mp4"
        path.write_bytes(mp4.content)
        info = probe(path)
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        assert any(s["codec_type"] == "audio" for s in info["streams"])
        seq = next(s for s in approved["plan"]["sequences"] if s["name"] == r["sequence_name"])
        assert float(info["format"]["duration"]) == pytest.approx(seq["duration"], abs=0.35)
        if seq["timeline"]["aspect"] == "9:16":
            assert (v["width"], v["height"]) == (360, 640)
        else:
            assert (v["width"], v["height"]) == (640, 360)
        srt = client.get(f"/api/projects/{pid}/renders/{r['id']}/srt").text
        assert "-->" in srt

    # Manual revision of the rough cut: drop the hook clip.
    seqs = client.get(f"/api/projects/{pid}/sequences").json()
    main = next(s for s in seqs if s["name"] == "Rough cut")
    v1 = main["current_version_id"]
    edited = dict(main["timeline"], clips=main["timeline"]["clips"][1:])
    v2 = client.post(f"/api/projects/{pid}/sequences/{main['id']}/versions", json={"timeline": edited, "label": "No hook"}).json()
    assert v2["number"] == 2
    cmp = client.get(f"/api/projects/{pid}/compare", params={"a": v1, "b": v2["id"]}).json()
    assert len(cmp["only_in_a"]) == 1 and not cmp["only_in_b"]

    # Invalid manual edit is rejected with problems listed.
    bad = dict(edited, clips=[{"asset_id": vid, "start": 0, "end": 9999}])
    r = client.post(f"/api/projects/{pid}/sequences/{main['id']}/versions", json={"timeline": bad})
    assert r.status_code == 422 and "exceeds source duration" in r.json()["problems"][0]

    # Restore v1 creates v3 with v1's clips.
    v3 = client.post(f"/api/projects/{pid}/versions/{v1}/restore").json()
    assert v3["number"] == 3 and v3["timeline"] == client.get(f"/api/projects/{pid}/versions/{v1}").json()["timeline"]

    # Final export of the restored version with WAV handoff.
    final = client.post(f"/api/projects/{pid}/renders", json={"version_id": v3["id"], "quality": "final", "wav": True}).json()
    wait_jobs(services, timeout=600)
    final = next(r for r in client.get(f"/api/projects/{pid}/renders").json() if r["id"] == final["id"])
    assert final["status"] == "succeeded", final
    wav = client.get(f"/api/projects/{pid}/renders/{final['id']}/wav", params={"download": True})
    assert wav.status_code == 200 and wav.content[:4] == b"RIFF"
    assert "attachment" in wav.headers["content-disposition"]
    mp4 = tmp_path / "final.mp4"
    mp4.write_bytes(client.get(f"/api/projects/{pid}/renders/{final['id']}/mp4").content)
    v = next(s for s in probe(mp4)["streams"] if s["codec_type"] == "video")
    assert (v["width"], v["height"]) == (1920, 1080)

    jobs = client.get(f"/api/projects/{pid}/jobs").json()
    assert {j["type"] for j in jobs} >= {"analyze", "transcribe", "render"}
    assert all(j["status"] == "succeeded" for j in jobs)


def test_burned_captions_and_audio_only(client, services, fixture_dir, tmp_path):
    pid = client.post("/api/projects", json={"name": "Audio test"}).json()["id"]
    wav = tmp_path / "voice.m4a"
    subprocess.run(["ffmpeg", "-y", "-i", str(fixture_dir / "market-mocha-interview.mp4"), "-vn", "-c:a", "aac", str(wav)],
                   check=True, capture_output=True)
    audio = upload(client, pid, wav)
    assert audio["kind"] == "audio"
    wait_jobs(services)
    seq = client.post(f"/api/projects/{pid}/sequences", json={"name": "Square", "timeline": {
        "aspect": "1:1", "burn_captions": True, "clips": [{"asset_id": audio["id"], "start": 0.5, "end": 8.0}]}}).json()
    seqs = client.get(f"/api/projects/{pid}/sequences").json()
    r = client.post(f"/api/projects/{pid}/renders", json={"version_id": seqs[0]["current_version_id"]}).json()
    wait_jobs(services)
    r = client.get(f"/api/projects/{pid}/renders").json()[0]
    assert r["status"] == "succeeded", r
    out = tmp_path / "sq.mp4"
    out.write_bytes(client.get(f"/api/projects/{pid}/renders/{r['id']}/mp4").content)
    info = probe(out)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert (v["width"], v["height"]) == (480, 480)
    assert float(info["format"]["duration"]) == pytest.approx(7.5, abs=0.3)
    assert seq["name"] == "Square"


def test_cancel_and_retry_render(client, services, fixture_dir):
    pid = client.post("/api/projects", json={"name": "Cancel test"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    wait_jobs(services)
    client.post(f"/api/projects/{pid}/sequences", json={"name": "Main", "timeline": {
        "clips": [{"asset_id": video["id"], "start": 0, "end": video["duration"]}]}})
    vid = client.get(f"/api/projects/{pid}/sequences").json()[0]["current_version_id"]
    render = client.post(f"/api/projects/{pid}/renders", json={"version_id": vid, "quality": "final"}).json()
    client.post(f"/api/projects/{pid}/jobs/{render['job_id']}/cancel")
    wait_jobs(services)
    assert client.get(f"/api/projects/{pid}/renders").json()[0]["status"] == "cancelled"
    assert client.post(f"/api/projects/{pid}/jobs/{render['job_id']}/retry").status_code == 200
    wait_jobs(services, timeout=600)
    assert client.get(f"/api/projects/{pid}/renders").json()[0]["status"] == "succeeded"
