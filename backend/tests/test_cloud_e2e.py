"""End-to-end tests of the hybrid architecture, all local: the real control-plane Worker (wrangler dev / workerd,
local D1 + Queues + cron), moto S3 standing in for private R2, and the real Mac agent running the real Cut Cue
pipeline (FFmpeg, fixture transcriber) on a real H.264/AAC file. Nothing reaches Cloudflare."""
from __future__ import annotations

import hashlib
import json
import subprocess
import time
from pathlib import Path

import httpx
import pytest

import cloud_stack as cs

pytestmark = pytest.mark.skipif(cs.available() is not None, reason=cs.available() or "")


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    work = tmp_path_factory.mktemp("cloud")
    moto = cs.Moto(work)
    cp = cs.ControlPlane(work, moto.url, PUBLIC_REVIEW="enabled")  # review-link tests need it; the pilot keeps it off
    try:
        yield cp
    finally:
        cp.stop()
        moto.stop()


@pytest.fixture()
def clean_queue(stack):
    """Jobs are a global queue; leave nothing queued for the next test's agent."""
    yield
    stack.sql("UPDATE jobs SET status = 'cancelled' WHERE status IN ('queued','leased','running','awaiting_authorization')")


def new_project(cp, name="Test project", user=None):
    r = cp.api("POST", "/v1/projects", json={"name": name}, user=user)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def register_worker(cp, name="Studio Mac"):
    r = cp.api("POST", "/v1/workers", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def wait_for(fn, timeout=30, what="condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.5)
    raise AssertionError(f"timed out waiting for {what}")


def make_agent(cp, token, settings, tmp_path):
    from cutcue.agent import Agent, AgentConfig
    from cutcue.services import Services

    cfg = AgentConfig(url=cp.url, token=token, data_dir=tmp_path / "agent", poll_seconds=0.5,
                      min_free_mem_gb=0.1, min_free_disk_gb=0.1)
    return Agent(cfg, services=Services(settings))


# --- authentication & permissions ---------------------------------------------------------------------------
def test_production_mode_has_no_unauthenticated_fallback(tmp_path):
    """Production settings with the dev identity present but no Access config: every private route is refused."""
    cp = cs.ControlPlane(tmp_path, None, ENVIRONMENT="production")
    try:
        assert cp.api("GET", "/v1/health").json()["ok"] is True
        for method, path in [("GET", "/v1/projects"), ("GET", "/v1/me"), ("POST", "/v1/projects"), ("GET", "/v1/costs"),
                             ("GET", "/v1/notifications"), ("POST", "/v1/workers"), ("GET", "/v1/audit")]:
            r = cp.api(method, path, json={"name": "x"}, user="owner@example.test",
                       headers={"cf-access-authenticated-user-email": "owner@example.test"})
            assert r.status_code == 503, (path, r.status_code, r.text)
        assert cp.api("POST", "/v1/worker/lease").status_code == 401
        assert cp.worker("POST", "/v1/worker/lease", "cqw_wkr_0000000000000000.notarealsecretnotarealsecret").status_code == 401
        assert cp.api("GET", "/v1/public/review/rv_" + "x" * 43).status_code == 403  # client links off by default
    finally:
        cp.stop()


def test_production_mode_with_access_rejects_bad_tokens(tmp_path):
    cp = cs.ControlPlane(tmp_path, None, ENVIRONMENT="production", CF_ACCESS_AUD="aud-test",
                         CF_ACCESS_TEAM_DOMAIN="example.cloudflareaccess.com")
    try:
        assert cp.api("GET", "/v1/projects").status_code == 401
        assert cp.api("GET", "/v1/projects", headers={"cf-access-jwt-assertion": "garbage"}).status_code == 401
        assert cp.api("GET", "/v1/projects", user="owner@example.test").status_code == 401
    finally:
        cp.stop()


def test_client_review_links_are_off_by_default(tmp_path):
    """wrangler.jsonc ships PUBLIC_REVIEW=disabled: no link can be created and no token is even looked up."""
    cp = cs.ControlPlane(tmp_path, None)
    try:
        assert cp.api("GET", "/v1/status").json()["public_review"] == "disabled"
        pid = new_project(cp, "No public access")
        r = cp.api("POST", f"/v1/projects/{pid}/review-links", json={"asset_id": "ast_0000000000000000"})
        assert r.status_code == 409 and "turned off" in r.json()["error"]
        token = "rv_" + "A" * 43
        assert cp.api("GET", f"/v1/public/review/{token}").status_code == 403
        assert cp.api("POST", f"/v1/public/review/{token}/events", json={"kind": "approved", "author": "x"}).status_code == 403
    finally:
        cp.stop()


def test_roles_and_permission_failures(stack):
    assert stack.api("GET", "/v1/me").json() == {"email": "owner@example.test", "role": "owner", "environment": "development"}
    editor = "editor@example.test"
    assert stack.api("GET", "/v1/me", user=editor).json()["role"] == "editor"
    assert stack.api("GET", "/v1/projects", user="stranger@example.test").status_code == 403
    pid = new_project(stack, user=editor)
    assert stack.api("PUT", f"/v1/projects/{pid}/budget", json={"budget_usd": 50}, user=editor).status_code == 403
    assert stack.api("POST", "/v1/workers", json={"name": "x"}, user=editor).status_code == 403
    assert stack.api("GET", "/v1/workers", user=editor).status_code == 403
    assert stack.api("GET", "/v1/audit", user=editor).status_code == 403
    assert stack.api("PUT", f"/v1/projects/{pid}/budget", json={"budget_usd": 50}).status_code == 200
    # cross-site state change refused
    r = stack.api("POST", "/v1/projects", json={"name": "csrf"}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    # responses carry security headers and are never cached
    r = stack.api("GET", "/v1/projects")
    assert r.headers["cache-control"] == "no-store" and r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"


def test_worker_credentials(stack):
    w = register_worker(stack, "Revoked Mac")
    assert w["token"].startswith(f"cqw_{w['id']}.")
    assert stack.worker("POST", "/v1/worker/heartbeat", w["token"]).status_code == 200
    wrong = w["token"][:-4] + ("AAAA" if not w["token"].endswith("AAAA") else "BBBB")
    assert stack.worker("POST", "/v1/worker/heartbeat", wrong).status_code == 401
    # a person can't use worker routes and a worker can't use person routes
    assert stack.api("POST", "/v1/worker/lease").status_code == 401
    assert stack.api("DELETE", f"/v1/workers/{w['id']}").status_code == 200
    assert stack.worker("POST", "/v1/worker/heartbeat", w["token"]).status_code == 401
    # the secret is stored hashed, never in clear
    stored = stack.sql("SELECT secret_hash FROM workers WHERE id = ?", (w["id"],))[0][0]
    assert w["token"].split(".", 1)[1] not in stored and len(stored) == 64


# --- uploads ------------------------------------------------------------------------------------------------
def test_upload_validation(stack):
    pid = new_project(stack, "Validation")
    sha = "0" * 64

    def create(**kw):
        body = {"filename": "a.mp4", "content_type": "video/mp4", "size": 1000, "sha256": sha, **kw}
        return stack.api("POST", f"/v1/projects/{pid}/uploads", json=body)

    assert create(content_type="application/x-msdownload", filename="a.exe").status_code == 415
    assert create(content_type="text/html", filename="a.html").status_code == 415
    assert create(filename="a.mov").status_code == 415           # extension doesn't match the type
    assert create(size=21 * 1024**3).status_code == 413          # over the 20 GB video limit
    assert create(content_type="image/png", filename="a.png", size=201 * 1024**2).status_code == 413
    assert create(size=0).status_code == 400
    assert create(sha256="nothex").status_code == 400
    assert create(part_size=1024).status_code == 400
    big = stack.http.post(f"/v1/projects/{pid}/uploads", content=b'{"x":"' + b"a" * 300_000 + b'"}',
                          headers={"content-type": "application/json"})
    assert big.status_code == 413
    assert stack.http.post(f"/v1/projects/{pid}/uploads", content=b"filename=a.mp4",
                           headers={"content-type": "application/x-www-form-urlencoded"}).status_code == 415
    assert create(filename="../../etc/passwd.mp4").status_code == 201  # accepted, but the name is sanitised
    key = stack.sql("SELECT object_key FROM upload_sessions ORDER BY created_at DESC LIMIT 1")[0][0]
    assert ".." not in key and key.startswith(f"projects/{pid}/sources/")


def test_resumable_upload_after_interruption(stack):
    pid = new_project(stack, "Resume")
    data = bytes(range(256)) * (13 * 4096)  # ~13 MiB -> 3 parts of 5 MiB
    session = cs.upload_file(stack, pid, data=data, name="phone-video.mp4", stop_after_parts=1)
    # The phone lost signal after part 1. Later it asks what arrived and continues.
    status = stack.api("GET", f"/v1/uploads/{session['id']}").json()
    assert status["parts_done"] == [1] and status["status"] == "open"
    early = stack.api("POST", f"/v1/uploads/{session['id']}/complete")
    assert early.status_code == 409 and early.json()["missing_parts"] == [2, 3]
    # a part of the wrong size is caught at completion
    bad = bytearray(data)
    cs.put_parts(stack, session, bytes(bad[:session["part_size"] + 10]), [2])
    cs.put_parts(stack, session, data, [3])
    r = stack.api("POST", f"/v1/uploads/{session['id']}/complete")
    assert r.status_code == 409, r.text
    cs.put_parts(stack, session, data, [2])  # re-send the bad part correctly
    r = stack.api("POST", f"/v1/uploads/{session['id']}/complete")
    assert r.status_code == 200, r.text
    again = stack.api("POST", f"/v1/uploads/{session['id']}/complete")
    assert again.json()["already"] is True
    url = stack.api("GET", f"/v1/assets/{session['asset_id']}/url?download=1").json()["url"]
    got = httpx.get(url, trust_env=False).content
    assert hashlib.sha256(got).hexdigest() == hashlib.sha256(data).hexdigest()
    # someone else's upload session is off limits for editors
    assert stack.api("GET", f"/v1/uploads/{session['id']}", user="editor@example.test").status_code == 403


def test_expired_upload_is_aborted_by_recovery(stack):
    pid = new_project(stack, "Abandoned upload")
    session = cs.upload_file(stack, pid, data=b"x" * (6 * cs.MiB), name="left.mp4", stop_after_parts=1)
    stack.sql("UPDATE upload_sessions SET expires_at = 0 WHERE id = ?", (session["id"],))
    assert stack.api("POST", f"/v1/uploads/{session['id']}/parts", json={"parts": [2]}).status_code == 409
    stack.scheduled()
    assert stack.sql("SELECT status FROM upload_sessions WHERE id = ?", (session["id"],))[0][0] == "expired"
    assert stack.sql("SELECT status FROM assets WHERE id = ?", (session["asset_id"],))[0][0] == "failed"


# --- jobs, leases, recovery ---------------------------------------------------------------------------------
def _queued_job(stack, pid, asset_id, key=None):
    headers = {"idempotency-key": key} if key else {}
    r = stack.api("POST", f"/v1/projects/{pid}/jobs", json={"type": "transcribe", "asset_id": asset_id}, headers=headers)
    assert r.status_code in (200, 201), r.text
    return r


def test_idempotent_job_creation_and_cloud_off(stack, clean_queue):
    pid = new_project(stack, "Idempotency")
    up = cs.upload_file(stack, pid, data=b"y" * 1000, name="a.mp4")
    first = _queued_job(stack, pid, up["asset_id"], key="create-job-0001")
    second = _queued_job(stack, pid, up["asset_id"], key="create-job-0001")
    assert first.json()["id"] == second.json()["id"] and second.headers.get("idempotent-replay") == "true"
    assert stack.sql("SELECT COUNT(*) FROM jobs WHERE project_id = ?", (pid,))[0][0] == 1
    r = stack.api("POST", f"/v1/projects/{pid}/jobs", json={"type": "transcribe", "asset_id": up["asset_id"], "target": "cloud"})
    assert r.status_code == 409 and "turned off" in r.json()["error"]
    r = stack.api("POST", f"/v1/jobs/{first.json()['id']}/authorize", json={"max_usd": 5, "confirm": "I authorize this paid cloud job"})
    assert r.status_code == 409
    # inputs must belong to the project and be finished uploads
    other = new_project(stack, "Other")
    assert stack.api("POST", f"/v1/projects/{other}/jobs", json={"type": "transcribe", "asset_id": up["asset_id"]}).status_code == 400


def test_lease_expiry_requeue_dead_letter_and_stale_tokens(stack, clean_queue):
    pid = new_project(stack, "Lease expiry")
    up = cs.upload_file(stack, pid, data=b"z" * 2000, name="b.mp4")
    job_id = _queued_job(stack, pid, up["asset_id"]).json()["id"]
    w1, w2 = register_worker(stack, "Mac A"), register_worker(stack, "Mac B")
    tokens = []
    for attempt in (1, 2, 3):
        r = stack.worker("POST", "/v1/worker/lease", w1["token"])
        assert r.status_code == 200, r.text
        lease = r.json()
        assert lease["job"]["id"] == job_id and lease["job"]["attempt"] == attempt
        assert [i["id"] for i in lease["inputs"]] == [up["asset_id"]] and lease["inputs"][0]["url"].startswith("http")
        # nobody else can take it while the lease holds, and another worker can't act on it
        assert stack.worker("POST", "/v1/worker/lease", w2["token"]).status_code == 204
        r = stack.worker("POST", f"/v1/worker/jobs/{job_id}/progress", w2["token"], {"stage": "x"}, lease=lease["lease_token"])
        assert r.status_code == 409
        tokens.append(lease["lease_token"])
        # the Mac goes silent: the lease runs out and scheduled recovery requeues (or dead-letters) it
        stack.sql("UPDATE jobs SET lease_expires_at = 1 WHERE id = ?", (job_id,))
        stack.scheduled()
        status = stack.api("GET", f"/v1/jobs/{job_id}").json()["status"]
        assert status == ("dead" if attempt == 3 else "queued"), (attempt, status)
    r = stack.worker("POST", f"/v1/worker/jobs/{job_id}/progress", w1["token"], {"stage": "late"}, lease=tokens[0])
    assert r.status_code == 409 and r.json()["lease_lost"] is True
    assert stack.worker("POST", "/v1/worker/lease", w1["token"]).status_code == 204
    events = [e["kind"] for e in stack.api("GET", f"/v1/jobs/{job_id}").json()["events"]]
    assert events.count("lease_expired") == 2 and events[-1] == "dead"
    note = wait_for(lambda: [n for n in stack.api("GET", "/v1/notifications").json()["items"]
                             if n["source_key"] == f"job:{job_id}:dead"], what="dead-letter notification")
    assert note[0]["kind"] == "job_failed"
    # the owner can retry a dead job; it goes back to the queue with fresh attempts
    assert stack.api("POST", f"/v1/jobs/{job_id}/retry").status_code == 200
    assert stack.sql("SELECT status, attempts FROM jobs WHERE id = ?", (job_id,))[0] == ("queued", 0)


def test_offline_worker_and_revocation_requeue(stack, clean_queue):
    pid = new_project(stack, "Offline")
    up = cs.upload_file(stack, pid, data=b"w" * 3000, name="c.mp4")
    stack.sql("UPDATE workers SET last_seen_at = 0")
    job_id = _queued_job(stack, pid, up["asset_id"]).json()["id"]
    job = stack.api("GET", f"/v1/jobs/{job_id}").json()
    assert job["status"] == "queued" and job["worker_online"] is False and job["progress"] is None
    assert stack.api("GET", "/v1/status").json()["workers_online"] == 0
    w = register_worker(stack, "Sleepy Mac")
    stack.worker("POST", "/v1/worker/heartbeat", w["token"], {"version": "t", "capabilities": ["ffmpeg"]})
    assert stack.api("GET", f"/v1/jobs/{job_id}").json()["worker_online"] is True
    lease = stack.worker("POST", "/v1/worker/lease", w["token"]).json()
    assert lease["job"]["id"] == job_id
    assert stack.api("DELETE", f"/v1/workers/{w['id']}").status_code == 200
    assert stack.sql("SELECT status, lease_worker_id FROM jobs WHERE id = ?", (job_id,))[0] == ("queued", None)


def test_agent_releases_lease_left_by_a_crash(stack, clean_queue, settings, tmp_path):
    pid = new_project(stack, "Crash")
    up = cs.upload_file(stack, pid, data=b"v" * 3000, name="d.mp4")
    job_id = _queued_job(stack, pid, up["asset_id"]).json()["id"]
    w = register_worker(stack, "Crashing Mac")
    lease = stack.worker("POST", "/v1/worker/lease", w["token"]).json()
    state = tmp_path / "agent" / "agent_state.json"
    state.parent.mkdir(parents=True)
    state.write_text(json.dumps({"current": {"job_id": job_id, "lease_token": lease["lease_token"]}}))
    agent = make_agent(stack, w["token"], settings, tmp_path)  # "restarted" agent
    agent.recover()
    assert stack.sql("SELECT status, attempts FROM jobs WHERE id = ?", (job_id,))[0] == ("queued", 0)
    assert json.loads(state.read_text())["current"] is None


def test_bad_media_fails_honestly(stack, clean_queue, settings, tmp_path):
    """Bytes that aren't really video: the Mac verifies, FFmpeg refuses, and the job fails with the real reason."""
    pid = new_project(stack, "Not a video")
    up = cs.upload_file(stack, pid, data=b"this is not a video" * 100, name="fake.mp4")
    job_id = _queued_job(stack, pid, up["asset_id"]).json()["id"]
    w = register_worker(stack, "Checker Mac")
    agent = make_agent(stack, w["token"], settings, tmp_path)
    assert agent.run_once() is True
    job = stack.api("GET", f"/v1/jobs/{job_id}").json()
    assert job["status"] == "failed" and job["error"] and job["result"] is None
    # tampered storage: checksum mismatch is caught before processing
    up2 = cs.upload_file(stack, pid, data=b"a" * 5000, name="tampered.mp4")
    stack.sql("UPDATE assets SET sha256 = ? WHERE id = ?", ("f" * 64, up2["asset_id"]))
    job2 = _queued_job(stack, pid, up2["asset_id"]).json()["id"]
    assert agent.run_once() is True
    job = stack.api("GET", f"/v1/jobs/{job2}").json()
    assert job["status"] == "failed" and "checksum" in job["error"]


def _probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def test_full_remote_workflow_with_mac_agent(stack, clean_queue, settings, fixture_dir, tmp_path):
    """Phone-style flow against the cloud API; the real Mac agent does the work on a real H.264/AAC file."""
    video = fixture_dir / "market-mocha-interview.mp4"
    streams = {s["codec_type"]: s["codec_name"] for s in _probe(video)["streams"]}
    assert streams == {"video": "h264", "audio": "aac"}
    pid = new_project(stack, "Market Mocha (remote)")
    up = cs.upload_file(stack, pid, video)
    w = register_worker(stack, "Intel Mac mini")
    agent = make_agent(stack, w["token"], settings, tmp_path)
    agent.heartbeat()

    # 1. transcribe
    tjob = _queued_job(stack, pid, up["asset_id"], key="tx-0000001").json()["id"]
    assert agent.run_once() is True
    job = stack.api("GET", f"/v1/jobs/{tjob}").json()
    assert job["status"] == "succeeded", job
    assert job["result"]["segments"] > 0 and job["result"]["engine"] == "fixture"
    kinds = [e["kind"] for e in job["events"]]
    assert kinds[:2] == ["created", "leased"] and kinds[-1] == "succeeded" and "stage" in kinds
    transcript_asset = job["result"]["outputs"][0]
    url = stack.api("GET", f"/v1/assets/{transcript_asset}/url").json()["url"]
    segments = httpx.get(url, trust_env=False).json()["segments"]
    assert segments and all(s["end"] > s["start"] for s in segments)

    # 2. auto-edit -> a proposed version that must be approved before rendering
    ajob = stack.api("POST", f"/v1/projects/{pid}/jobs", json={"type": "auto_edit", "asset_id": up["asset_id"]}).json()["id"]
    assert agent.run_once() is True
    project = stack.api("GET", f"/v1/projects/{pid}").json()
    assert next(j for j in project["jobs"] if j["id"] == ajob)["status"] == "succeeded"
    version = project["versions"][0]
    assert version["status"] == "proposed" and version["source_job_id"] == ajob
    detail = stack.api("GET", f"/v1/versions/{version['id']}").json()
    assert detail["timeline"]["clips"] and all(c["asset_id"] == up["asset_id"] for c in detail["timeline"]["clips"])
    r = stack.api("POST", f"/v1/projects/{pid}/jobs", json={"type": "render", "version_id": version["id"], "preset": "youtube"})
    assert r.status_code == 409  # not approved yet
    assert stack.api("POST", f"/v1/versions/{version['id']}/decision", json={"decision": "approved"}).status_code == 200
    assert stack.api("POST", f"/v1/versions/{version['id']}/decision", json={"decision": "rejected"}).status_code == 409

    # 3. render on the Mac, uploaded straight to storage
    rjob = stack.api("POST", f"/v1/projects/{pid}/jobs", json={"type": "render", "version_id": version["id"], "preset": "youtube"}).json()["id"]
    assert agent.run_once() is True
    job = stack.api("GET", f"/v1/jobs/{rjob}").json()
    assert job["status"] == "succeeded", job
    progress = [e for e in job["events"] if e["kind"] == "stage"]
    assert progress, "the agent reported real stages"
    project = stack.api("GET", f"/v1/projects/{pid}").json()
    outputs = [a for a in project["assets"] if a["kind"] == "output" and a["source_job_id"] == rjob]
    mp4 = next(a for a in outputs if a["content_type"] == "video/mp4")
    assert mp4["status"] == "ready" and mp4["verified_at"]
    dl = stack.api("GET", f"/v1/assets/{mp4['id']}/url?download=1").json()
    res = httpx.get(dl["url"], trust_env=False)
    assert res.status_code == 200
    # The download name is a signed response-content-disposition parameter (honoured by R2; moto ignores it).
    assert "response-content-disposition=attachment" in httpx.URL(dl["url"]).query.decode()
    out = tmp_path / "final.mp4"
    out.write_bytes(res.content)
    assert hashlib.sha256(res.content).hexdigest() == mp4["sha256"]
    info = _probe(out)
    codecs = {s["codec_type"]: s["codec_name"] for s in info["streams"]}
    assert codecs == {"video": "h264", "audio": "aac"}
    assert abs(float(info["format"]["duration"]) - job["result"]["duration"]) < 0.5

    # 4. client review link: short-lived, scoped to one video, revocable
    r = stack.api("POST", f"/v1/projects/{pid}/review-links", json={"asset_id": mp4["id"], "hours": 2, "allow_download": True})
    assert r.status_code == 201
    link = r.json()
    token = link["token"]
    assert link["expires_at"] - time.time() < 2 * 3600 + 5
    assert token not in json.dumps(stack.api("GET", f"/v1/projects/{pid}").json())  # only the hash is stored
    review = stack.api("GET", f"/v1/public/review/{token}").json()
    assert review["project_name"] == "Market Mocha (remote)" and review["download_url"]
    assert httpx.get(review["video_url"], trust_env=False).status_code == 200
    assert "assets" not in review and "jobs" not in review  # nothing else from the project leaks
    r = stack.api("POST", f"/v1/public/review/{token}/events", json={"kind": "changes_requested", "author": "Dana", "body": "Trim the intro"})
    assert r.status_code == 201
    r = stack.api("POST", f"/v1/public/review/{token}/events", json={"kind": "approved", "author": "Dana"})
    assert r.status_code == 201
    feedback = stack.api("GET", f"/v1/projects/{pid}").json()["feedback"]
    assert {f["kind"] for f in feedback} == {"changes_requested", "approved"}
    titles = wait_for(lambda: [n["title"] for n in stack.api("GET", "/v1/notifications").json()["items"]
                               if n["project_id"] == pid and n["kind"] == "review_approved"], what="review notification")
    assert titles == ["Dana approved Market Mocha (remote)"]
    kinds = {n["kind"] for n in stack.api("GET", "/v1/notifications").json()["items"] if n["project_id"] == pid}
    assert {"upload_complete", "job_done", "review_changes_requested", "review_approved"} <= kinds
    stack.sql("UPDATE review_links SET expires_at = 1 WHERE id = ?", (link["id"],))
    assert stack.api("GET", f"/v1/public/review/{token}").status_code == 410
    r2 = stack.api("POST", f"/v1/projects/{pid}/review-links", json={"asset_id": mp4["id"]}).json()
    assert stack.api("DELETE", f"/v1/review-links/{r2['id']}").status_code == 200
    assert stack.api("GET", f"/v1/public/review/{r2['token']}").status_code == 410
    assert stack.api("GET", "/v1/public/review/rv_" + "A" * 43).status_code == 404

    # 5. costs are real: the Mac pipeline made no paid calls, so nothing is invented
    costs = stack.api("GET", "/v1/costs").json()
    assert costs["cloud_rendering"] == "disabled" and costs["by_kind"] == []
    assert costs["storage_gb"] > 0

    # 6. audit trail exists and is append-only
    actions = {row["action"] for row in stack.api("GET", "/v1/audit").json()}
    assert {"project.create", "upload.complete", "job.create", "version.approved", "job.complete",
            "review_link.create", "review_link.revoke", "asset.download"} <= actions
    with pytest.raises(Exception, match="append-only"):
        stack.sql("UPDATE audit_log SET actor = 'someone-else'")
    with pytest.raises(Exception, match="append-only"):
        stack.sql("DELETE FROM audit_log")


def test_ask_cue_proposes_and_only_approval_runs(stack, clean_queue):
    def ask(text, project_id=None, user=None):
        r = stack.api("POST", "/v1/ask", json={"message": text, **({"project_id": project_id} if project_id else {})}, user=user)
        assert r.status_code == 200, r.text
        return r.json()

    before = stack.sql("SELECT COUNT(*) FROM projects")[0][0]
    out = ask("New project Spring Promo for Acme")
    assert out["mode"] == "built-in" and out["action"]["kind"] == "create_project" and out["action"]["status"] == "pending"
    assert stack.sql("SELECT COUNT(*) FROM projects")[0][0] == before  # proposing changed nothing
    act = out["action"]["id"]
    assert stack.api("POST", f"/v1/actions/{act}/approve", user="editor@example.test").status_code == 403
    r = stack.api("POST", f"/v1/actions/{act}/approve")
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    pid = r.json()["result"]["id"]
    assert stack.api("GET", f"/v1/projects/{pid}").json()["project"]["name"] == "Spring Promo for Acme"
    assert stack.api("POST", f"/v1/actions/{act}/approve").status_code == 409  # a second tap can't run it twice
    assert stack.sql("SELECT COUNT(*) FROM projects")[0][0] == before + 1

    # Jobs need real footage; Ask Cue says so instead of guessing.
    assert "no finished video" in ask("Suggest an edit for Spring Promo for Acme")["reply"]
    up = cs.upload_file(stack, pid, data=b"q" * 2000, name="clip.mp4")
    out = ask("suggest an edit", project_id=pid)
    assert out["action"]["kind"] == "create_job" and "approval before anything is exported" in out["reply"]
    jobs_before = stack.sql("SELECT COUNT(*) FROM jobs WHERE project_id = ?", (pid,))[0][0]
    rej = stack.api("POST", f"/v1/actions/{out['action']['id']}/reject")
    assert rej.json()["status"] == "rejected"
    assert stack.sql("SELECT COUNT(*) FROM jobs WHERE project_id = ?", (pid,))[0][0] == jobs_before
    out = ask("Transcribe Spring Promo for Acme")
    stack.api("POST", f"/v1/actions/{out['action']['id']}/approve")
    job = stack.sql("SELECT type, status FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", (pid,))[0]
    assert job == ("transcribe", "queued")
    assert "has no approved edit" in ask("Export Spring Promo for Acme for TikTok")["reply"]

    # Status answers come from real data.
    att = ask("What needs my attention?")
    assert any("Transcript in Spring Promo for Acme" in i["label"] for i in att["items"])
    assert ask("Is my Mac online?")["reply"].startswith(("Yes", "No"))
    assert ask("blah")["items"]  # help suggestions

    # Archive via Ask stops queued work and hides the project.
    out = ask("archive project Spring Promo for Acme")
    assert stack.api("POST", f"/v1/actions/{out['action']['id']}/approve").json()["status"] == "approved"
    assert pid not in [p["id"] for p in stack.api("GET", "/v1/projects").json()]
    assert stack.sql("SELECT status FROM jobs WHERE project_id = ? AND type = 'transcribe'", (pid,))[0][0] == "cancelled"
    actions = {row["action"] for row in stack.api("GET", "/v1/audit").json()}
    assert {"ask.propose", "ask.approve", "ask.reject", "project.archive"} <= actions


def test_worker_going_offline_shows_at_once(stack):
    stack.sql("UPDATE workers SET last_seen_at = 0")
    w = register_worker(stack, "Leaving Mac")
    stack.worker("POST", "/v1/worker/heartbeat", w["token"], {"version": "t"})
    assert stack.api("GET", "/v1/status").json()["workers_online"] == 1
    r = stack.worker("POST", "/v1/worker/heartbeat", w["token"], {"version": "t", "going_offline": True})
    assert r.json()["offline"] is True
    assert stack.api("GET", "/v1/status").json()["workers_online"] == 0
