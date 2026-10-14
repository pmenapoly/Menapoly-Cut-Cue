"""Endpoints added for the redesigned interface: presets, waveform, frames, undo/redo, transcript edits, activity."""
import json
import subprocess

import pytest
from conftest import upload, wait_jobs


def project_with_video(client, services, fixture_dir):
    pid = client.post("/api/projects", json={"name": "UX"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    wait_jobs(services)
    return pid, video


def test_project_list_and_activity(client, services, fixture_dir):
    pid, video = project_with_video(client, services, fixture_dir)
    row = next(p for p in client.get("/api/projects").json() if p["id"] == pid)
    assert row["thumb_asset_id"] == video["id"] and row["active_jobs"] == 0 and row["last_activity"] >= row["created_at"]
    activity = client.get("/api/activity").json()
    assert activity[0]["project_id"] == pid and activity[0]["kind"] == "upload"


def test_waveform_and_frames(client, services, fixture_dir):
    pid, video = project_with_video(client, services, fixture_dir)
    wf = client.get(f"/api/projects/{pid}/assets/{video['id']}/waveform", params={"points": 200}).json()
    assert len(wf["peaks"]) == 200 and max(wf["peaks"]) == 1.0 and min(wf["peaks"]) >= 0
    segs = services.transcript(video["id"])
    # Peaks are high during speech and near zero in the long pause.
    gap = next((a["end"], b["start"]) for a, b in zip(segs, segs[1:]) if b["start"] - a["end"] > 1.2)
    per_s = 200 / wf["duration"]
    assert max(wf["peaks"][int((gap[0] + 0.2) * per_s): int((gap[1] - 0.2) * per_s)]) < 0.05
    img = client.get(f"/api/projects/{pid}/assets/{video['id']}/frame", params={"t": 3.3})
    assert img.status_code == 200 and img.content[:2] == b"\xff\xd8"
    assert client.get(f"/api/projects/{pid}/assets/{video['id']}/frame", params={"t": 3.4}).content == img.content  # cached 0.5 s grid


def test_undo_redo_versions(client, services, fixture_dir):
    pid, video = project_with_video(client, services, fixture_dir)
    clip = lambda e: {"clips": [{"asset_id": video["id"], "start": 0, "end": e}]}
    seq = client.post(f"/api/projects/{pid}/sequences", json={"name": "Main", "timeline": clip(10)}).json()
    client.post(f"/api/projects/{pid}/sequences/{seq['id']}/versions", json={"timeline": clip(20)})
    undo = client.post(f"/api/projects/{pid}/sequences/{seq['id']}/undo").json()
    assert undo["timeline"]["clips"][0]["end"] == 10 and len(undo["versions"]) == 2
    assert client.post(f"/api/projects/{pid}/sequences/{seq['id']}/undo").status_code == 400
    redo = client.post(f"/api/projects/{pid}/sequences/{seq['id']}/redo").json()
    assert redo["timeline"]["clips"][0]["end"] == 20
    assert client.post(f"/api/projects/{pid}/sequences/{seq['id']}/redo").status_code == 400


def test_transcript_correction_feeds_captions_and_search(client, services, fixture_dir):
    pid, video = project_with_video(client, services, fixture_dir)
    seg = services.transcript(video["id"])[0]
    r = client.patch(f"/api/projects/{pid}/assets/{video['id']}/transcript/{seg['idx']}",
                     json={"text": "Welcome back to the Market Mocha show."}).json()
    assert r["text"].endswith("show.") and r["words"][-1]["word"].strip() == "show." and r["start"] == seg["start"]
    assert client.get(f"/api/projects/{pid}/search", params={"q": "show"}).json()[0]["text"].endswith("show.")
    assert client.patch(f"/api/projects/{pid}/assets/{video['id']}/transcript/{seg['idx']}", json={"text": "  "}).status_code == 400


def test_export_presets_render_platform_formats(client, services, fixture_dir, tmp_path):
    pid, video = project_with_video(client, services, fixture_dir)
    presets = {p["id"]: p for p in client.get("/api/presets").json()}
    assert {"youtube", "podcast", "tiktok", "reels", "linkedin"} <= set(presets)
    client.post(f"/api/projects/{pid}/sequences", json={"name": "Main", "timeline": {
        "clips": [{"asset_id": video["id"], "start": 0, "end": 8}]}})
    vid = client.get(f"/api/projects/{pid}/sequences").json()[0]["current_version_id"]
    expected = {"reels": (1080, 1920), "linkedin": (1080, 1080), "podcast": (1920, 1080)}
    ids = {p: client.post(f"/api/projects/{pid}/renders", json={"version_id": vid, "preset": p}).json()["id"] for p in expected}
    assert client.post(f"/api/projects/{pid}/renders", json={"version_id": vid, "preset": "myspace"}).status_code == 400
    wait_jobs(services, timeout=900)
    renders = {r["id"]: r for r in client.get(f"/api/projects/{pid}/renders").json()}
    for preset, size in expected.items():
        r = renders[ids[preset]]
        assert r["status"] == "succeeded" and r["preset"] == preset and r["quality"] == "final"
        path = services.renders_dir(pid) / r["output_name"]
        info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                          "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout)
        assert (info["streams"][0]["width"], info["streams"][0]["height"]) == size
    assert renders[ids["podcast"]]["wav_name"]
    # The saved edit itself is unchanged by presets.
    assert client.get(f"/api/projects/{pid}/versions/{vid}").json()["timeline"]["aspect"] == "16:9"
