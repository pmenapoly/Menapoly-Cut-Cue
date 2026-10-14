"""Launch readiness: the whole client workflow as one chain, on real renders, with email delivered over SMTP
and a verified backup at the end. If any link breaks, this test names the step."""
import json
import subprocess
import threading

from conftest import upload, wait_jobs
from test_notifications import SMTPSink, mailer_for

from cutcue.backup import create_backup, verify_backup


def test_end_to_end_client_workflow(client, services, settings, fixture_dir, tmp_path):
    sink = SMTPSink()
    threading.Thread(target=sink.serve_forever, daemon=True).start()
    try:
        mailer = mailer_for(client, sink.server_address[1],
                            kinds="render_done,review_requested,review_changes_requested,review_approved,stage_changed")

        # 1. Create the project (with client) and upload media + brief.
        p = client.post("/api/cue/projects", json={"name": "Launch Check", "client": "Acme Coffee"}).json()
        pid = p["id"]
        video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
        brief = upload(client, pid, fixture_dir / "market-mocha-brief.txt")
        wait_jobs(services)
        assert brief["status"] == "ready", "step 1: brief"
        assert client.get(f"/api/cue/projects/{pid}").json()["project"]["status"]["key"] == "ready", "step 1: media ready"

        # 2. Edit: Ask Cue proposes; owner approves; Cut Cue proposal approved; preview renders.
        act = client.post("/api/cue/ask", json={"message": "Make a rough cut of Launch Check"}).json()["actions"][0]
        done = client.post(f"/api/cue/actions/{act['id']}/approve").json()
        assert done["status"] == "executed", f"step 2: {done}"
        client.post(f"/api/projects/{pid}/proposals/{done['result']['proposal_id']}/approve")
        wait_jobs(services)
        preview = client.get(f"/api/v1/projects/{pid}/renders").json()[0]
        assert preview["status"] == "succeeded", "step 2: preview render"

        # 3. Review link → client requests changes → owner revises in Pro (new version) → re-render → client approves.
        link = client.post(f"/api/cue/projects/{pid}/review-links", json={"render_id": preview["id"]}).json()
        t = link["token"]
        assert client.post(f"/api/public/review/{t}/events", json={"kind": "changes_requested", "author": "Dana",
                                                                   "body": "Shorter please", "at_seconds": 3}).status_code == 201
        seq = client.get(f"/api/projects/{pid}/sequences").json()[0]
        shorter = {**seq["timeline"], "clips": seq["timeline"]["clips"][:-1] or seq["timeline"]["clips"]}
        client.post(f"/api/projects/{pid}/sequences/{seq['id']}/versions", json={"timeline": shorter, "label": "Client notes"})
        v2 = client.get(f"/api/projects/{pid}/sequences").json()[0]["current_version_id"]
        r2 = client.post(f"/api/projects/{pid}/renders", json={"version_id": v2}).json()
        wait_jobs(services)
        link2 = client.post(f"/api/cue/projects/{pid}/review-links", json={"render_id": r2["id"], "label": "Revision 1"}).json()
        assert client.post(f"/api/public/review/{link2['token']}/events", json={"kind": "approved", "author": "Dana"}).status_code == 201
        assert client.get(f"/api/cue/projects/{pid}").json()["project"]["stage"] == "approved", "step 3: approval"

        # 4. Final exports (YouTube + Reels presets) of the approved version; verify with ffprobe.
        outs = [client.post(f"/api/projects/{pid}/renders", json={"version_id": v2, "preset": p}).json() for p in ("youtube", "reels")]
        wait_jobs(services)
        for o in outs:
            row = next(r for r in client.get(f"/api/projects/{pid}/renders").json() if r["id"] == o["id"])
            assert row["status"] == "succeeded", f"step 4: {o['preset']}"
            path = services.render_file(pid, o["id"], "mp4")
            info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)],
                                             capture_output=True, text=True, check=True).stdout)
            codecs = {s["codec_type"]: s["codec_name"] for s in info["streams"]}
            assert codecs == {"video": "h264", "audio": "aac"}, f"step 4: codecs {codecs}"
            v = next(s for s in info["streams"] if s["codec_type"] == "video")
            assert (v["width"], v["height"]) == ((1920, 1080) if o["preset"] == "youtube" else (1080, 1920)), "step 4: size"
        client.patch(f"/api/cue/projects/{pid}", json={"stage": "delivered"})

        # 5. Notifications in-app and by email.
        kinds = {n["kind"] for n in client.get("/api/cue/notifications?limit=100").json()["items"]}
        assert {"render_done", "review_requested", "review_changes_requested", "review_approved", "stage_changed"} <= kinds, kinds
        mailer.process_due()
        subjects = " | ".join(m["data"] for m in sink.messages)
        for expected in ("Cue proposed an edit", "requested changes", "approved the edit", "is ready", "is now delivered"):
            assert expected in subjects, f"step 5: email '{expected}' missing"

        # 6. Backup of everything, verified.
        dest = create_backup(settings.data_dir, tmp_path / "backups")
        check = verify_backup(dest)
        assert check["ok"] and check["counts"]["renders"] >= 4 and check["counts"]["review_links"] == 2, f"step 6: {check}"

        # 7. Connection status reflects reality and never contains secret values.
        services.settings.anthropic_api_key = "sk-ant-SECRET-VALUE"
        client.app.state.cue.mailer.config.password = "smtp-SECRET-VALUE"
        raw = client.get("/api/cue/connections").text
        conn = {i["key"]: i for i in json.loads(raw)["items"]}
        assert conn["email"]["status"] == "ready" and conn["ffmpeg"]["status"] == "ready" and conn["claude"]["status"] == "ready"
        assert "SECRET-VALUE" not in raw
    finally:
        sink.shutdown()
