"""Audio enhancement + WAV re-import, measured on real FFmpeg renders.

Fixture speech is band-limited below 3.8 kHz and the music bed is a 5.5 kHz tone, so music level
can be measured independently of speech (high-pass band) to verify ducking and processed-audio
markers.
"""
import hashlib
import json
import subprocess

import pytest
from conftest import upload, wait_jobs

from cutcue.audio import estimate_offset, integrated_loudness, read_pcm, rms_db

MUSIC_BAND = "highpass=f=5000,highpass=f=5000,highpass=f=5000"
SPEECH_BAND = "lowpass=f=3000"


def fixture_segments(fixture_dir, name):
    sha = hashlib.sha256((fixture_dir / name).read_bytes()).hexdigest()
    return json.loads((fixture_dir / f"{sha}.transcript.json").read_text())["segments"]


def band_db(path, start, length, band):
    return rms_db(read_pcm(path, rate=48000, start=start, duration=length, afilter=band))


def setup_interview(client, services, fixture_dir, extra=()):
    pid = client.post("/api/projects", json={"name": "Audio"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    others = [upload(client, pid, p) for p in extra]
    wait_jobs(services)
    return pid, video, others


def render(client, services, pid, timeline, quality="preview", name="T", wav=False):
    seq = client.post(f"/api/projects/{pid}/sequences", json={"name": name, "timeline": timeline})
    assert seq.status_code == 201, seq.text
    vid = client.get(f"/api/projects/{pid}/sequences").json()
    vid = next(s for s in vid if s["id"] == seq.json()["id"])["current_version_id"]
    r = client.post(f"/api/projects/{pid}/renders", json={"version_id": vid, "quality": quality, "wav": wav}).json()
    wait_jobs(services, timeout=600)
    r = next(x for x in client.get(f"/api/projects/{pid}/renders").json() if x["id"] == r["id"])
    assert r["status"] == "succeeded", r
    return r, services.renders_dir(pid) / r["output_name"]


def pause_windows(services, asset_id, min_gap=1.0, until=30.0):
    segs = services.transcript(asset_id)
    return [(a["end"] + 0.25, b["start"] - 0.25) for a, b in zip(segs, segs[1:])
            if b["start"] - a["end"] >= min_gap and b["start"] < until]


def speech_windows(services, asset_id, until=30.0):
    return [(s["start"] + 0.2, s["end"] - 0.2) for s in services.transcript(asset_id) if s["end"] < until and s["end"] - s["start"] > 1.5]


def test_two_pass_loudness_hits_target(client, services, fixture_dir):
    pid, video, _ = setup_interview(client, services, fixture_dir)
    for target in (-16.0, -14.0):
        r, out = render(client, services, pid, {"clips": [{"asset_id": video["id"], "start": 0, "end": 30}],
                                                "audio": {"loudness_target": target}}, name=f"L{target}")
        measured = integrated_loudness(out)
        assert measured == pytest.approx(target, abs=1.0), (target, measured)
        assert r["info"]["measured_input_lufs"] < target  # quiet fixture was actually raised


def test_denoise_lowers_noise_floor_keeps_speech(client, services, fixture_dir, tmp_path):
    noisy = tmp_path / "noisy-interview.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(fixture_dir / "market-mocha-interview.mp4"),
                    "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.02:seed=7:sample_rate=48000",
                    "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", str(noisy)], check=True)
    pid = client.post("/api/projects", json={"name": "Denoise"}).json()["id"]
    asset = upload(client, pid, noisy, chunk=8 * 1024 * 1024)
    wait_jobs(services)
    base = {"clips": [{"asset_id": asset["id"], "start": 0, "end": 30}], "normalize_audio": False}
    _, plain = render(client, services, pid, {**base, "audio": {"denoise": "off"}}, name="plain")
    _, clean = render(client, services, pid, {**base, "audio": {"denoise": "strong"}}, name="clean")
    # Ground-truth timings of the clean fixture (the noisy copy has the same timeline).
    segs = fixture_segments(fixture_dir, "market-mocha-interview.mp4")
    gaps = [(a["end"] + 0.25, b["start"] - 0.25) for a, b in zip(segs, segs[1:]) if b["start"] - a["end"] >= 1.0 and b["start"] < 30]
    assert len(gaps) >= 2
    noise_drop = [band_db(plain, a, b - a, "anull") - band_db(clean, a, b - a, "anull") for a, b in gaps]
    assert min(noise_drop) > 6, noise_drop
    speech = [(s["start"] + 0.2, s["end"] - 0.2) for s in segs[:3]]
    speech_drop = [band_db(plain, a, b - a, SPEECH_BAND) - band_db(clean, a, b - a, SPEECH_BAND) for a, b in speech]
    assert max(speech_drop) < 3, speech_drop


def test_music_ducks_under_speech(client, services, fixture_dir):
    pid, video, (music,) = setup_interview(client, services, fixture_dir, [fixture_dir / "music-bed.wav"])
    assert music["kind"] == "audio"
    base = {"clips": [{"asset_id": video["id"], "start": 0, "end": 30}], "normalize_audio": False}
    _, ducked = render(client, services, pid, {**base, "audio": {"music_asset_id": music["id"], "music_volume_db": -12, "duck": True}}, name="duck")
    _, flat = render(client, services, pid, {**base, "audio": {"music_asset_id": music["id"], "music_volume_db": -12, "duck": False}}, name="flat")
    talk, quiet = speech_windows(services, video["id"]), pause_windows(services, video["id"])
    assert talk and quiet

    def depth(path):
        speech_level = max(band_db(path, a, b - a, MUSIC_BAND) for a, b in talk)
        pause_level = min(band_db(path, a, b - a, MUSIC_BAND) for a, b in quiet)
        return pause_level - speech_level

    assert depth(ducked) > 6, depth(ducked)       # music dips while someone talks
    assert abs(depth(flat)) < 2, depth(flat)      # without ducking the bed is steady
    assert band_db(flat, 5, 10, MUSIC_BAND) > -45  # the music is really in the mix


def test_music_must_be_project_audio(client, services, fixture_dir):
    pid, video, _ = setup_interview(client, services, fixture_dir)
    r = client.post(f"/api/projects/{pid}/sequences", json={"name": "Bad", "timeline": {
        "clips": [{"asset_id": video["id"], "start": 0, "end": 5}], "audio": {"music_asset_id": "ast_0000000000000000"}}})
    assert r.status_code == 422 and "music" in r.json()["problems"][0]


def test_focus_and_title_change_the_frame(client, services, fixture_dir, tmp_path):
    pid, video, _ = setup_interview(client, services, fixture_dir)

    def frame(path, name):
        out = tmp_path / name
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "1", "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
                        "-pix_fmt", "gray", str(out)], check=True)
        return out.read_bytes()

    clip = lambda fx: [{"asset_id": video["id"], "start": 2, "end": 4, "focus_x": fx}]
    _, left = render(client, services, pid, {"aspect": "9:16", "clips": clip(0.0)}, name="left")
    _, right = render(client, services, pid, {"aspect": "9:16", "clips": clip(1.0)}, name="right")
    _, titled = render(client, services, pid, {"aspect": "9:16", "clips": clip(1.0), "title": "Consistency wins"}, name="titled")
    fl, fr, ft = frame(left, "l.gray"), frame(right, "r.gray"), frame(titled, "t.gray")
    assert len(fl) == 360 * 640
    diff = lambda a, b, rows: sum(abs(x - y) for x, y in zip(a[: 360 * rows], b[: 360 * rows])) / (360 * rows)
    assert diff(fl, fr, 640) > 10            # different crop window
    assert diff(fr, ft, 160) > 5             # title box drawn in the top quarter
    assert diff(fr[360 * 400:], ft[360 * 400:], 200) < 2  # rest of the frame unchanged


def test_processed_source_audio_reimport(client, services, fixture_dir, tmp_path):
    pid, video, _ = setup_interview(client, services, fixture_dir)
    wav = client.get(f"/api/projects/{pid}/assets/{video['id']}/audio.wav")
    assert wav.status_code == 200 and wav.content[:4] == b"RIFF"
    exported = tmp_path / "exported.wav"
    exported.write_bytes(wav.content)
    # Simulate an external tool: +3 dB, a 5.5 kHz marker tone, and 250 ms of added latency at the start.
    processed = tmp_path / "interview-processed.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(exported), "-f", "lavfi", "-i", "sine=frequency=5500:sample_rate=48000",
                    "-filter_complex", "[0:a]adelay=250|250,volume=3dB[v];[1:a]volume=-6dB,aformat=channel_layouts=stereo[m];"
                                       "[v][m]amix=inputs=2:duration=first:normalize=0[a]",
                    "-map", "[a]", "-c:a", "pcm_s16le", str(processed)], check=True)
    proc_asset = upload(client, pid, processed, chunk=8 * 1024 * 1024)
    wait_jobs(services)
    timeline = {"clips": [{"asset_id": video["id"], "start": 5, "end": 15}], "normalize_audio": False}
    _, original = render(client, services, pid, timeline, name="orig")

    attach = client.post(f"/api/projects/{pid}/assets/{video['id']}/processed-audio", json={"audio_asset_id": proc_asset["id"]})
    assert attach.status_code == 200, attach.text
    assert attach.json()["offset"] == pytest.approx(0.25, abs=0.03)
    r, swapped = render(client, services, pid, timeline, name="swapped")
    assert r["info"]["processed_audio_sources"] == [video["id"]]
    assert band_db(swapped, 1, 8, MUSIC_BAND) > band_db(original, 1, 8, MUSIC_BAND) + 20  # processed track is used
    offset, corr = estimate_offset(original, swapped)
    assert abs(offset) <= 0.02 and corr > 0.8                                              # and it is in sync

    client.delete(f"/api/projects/{pid}/assets/{video['id']}/processed-audio")
    _, back = render(client, services, pid, timeline, name="back")
    assert band_db(back, 1, 8, MUSIC_BAND) < band_db(swapped, 1, 8, MUSIC_BAND) - 20


def test_unrelated_audio_is_rejected(client, services, fixture_dir):
    pid, video, (music,) = setup_interview(client, services, fixture_dir, [fixture_dir / "music-bed.wav"])
    r = client.post(f"/api/projects/{pid}/assets/{video['id']}/processed-audio", json={"audio_asset_id": music["id"]})
    assert r.status_code == 400 and "does not match" in r.json()["detail"]


def test_render_audio_reimport_keeps_video(client, services, fixture_dir, tmp_path):
    pid, video, _ = setup_interview(client, services, fixture_dir)
    parent, parent_mp4 = render(client, services, pid, {"clips": [{"asset_id": video["id"], "start": 0, "end": 12}]},
                                quality="final", wav=True)
    exported = tmp_path / "final.wav"
    exported.write_bytes(client.get(f"/api/projects/{pid}/renders/{parent['id']}/wav").content)
    processed = tmp_path / "final-processed.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(exported), "-f", "lavfi", "-i", "sine=frequency=5500:sample_rate=48000",
                    "-filter_complex", "[1:a]volume=-6dB,aformat=channel_layouts=stereo[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]",
                    "-map", "[a]", "-c:a", "pcm_s16le", str(processed)], check=True)
    proc_asset = upload(client, pid, processed, chunk=8 * 1024 * 1024)
    wait_jobs(services)
    r = client.post(f"/api/projects/{pid}/renders/{parent['id']}/reimport", json={"audio_asset_id": proc_asset["id"]})
    assert r.status_code == 201, r.text
    wait_jobs(services)
    child = next(x for x in client.get(f"/api/projects/{pid}/renders").json() if x["id"] == r.json()["id"])
    assert child["status"] == "succeeded" and child["origin"] == "reimport" and child["parent_render_id"] == parent["id"]
    child_mp4 = services.renders_dir(pid) / child["output_name"]

    def video_packets(path):
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                              "stream=nb_read_packets,codec_name,width,height", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, check=True).stdout.strip()
        return out

    assert video_packets(child_mp4) == video_packets(parent_mp4)  # video stream copied, not re-encoded
    assert band_db(child_mp4, 1, 8, MUSIC_BAND) > band_db(parent_mp4, 1, 8, MUSIC_BAND) + 20
    assert client.get(f"/api/projects/{pid}/renders/{child['id']}/srt").status_code == 200
