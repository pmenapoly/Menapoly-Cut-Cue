"""Relay connector: approval gate, idempotency, retries, failures, and consistent identities.

Most tests use FakeRelay (tests/relay_fake.py) for failure injection. test_real_relay_* run against the real
MenapolyRelay app when CUE_RELAY_TEST_URL points at a running Relay dev server (see docs/cue2/relay-connector.md).
"""
import hashlib
import os

import httpx
import pytest
from conftest import upload, wait_jobs
from relay_fake import FakeRelay

from cutcue.relay import RelayConfig, RelayConnector, RelayError

TOKEN = RelayConfig(url="https://relay.example", workspace_id="ws-1", client_id="client-id", client_secret="secret")


def rendered_project(client, services, fixture_dir, name="Portal Test", seconds=6.0):
    pid = client.post("/api/cue/projects", json={"name": name, "client": "Acme"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    wait_jobs(services)
    seq = client.post(f"/api/projects/{pid}/sequences", json={"name": "Main", "timeline": {
        "clips": [{"asset_id": video["id"], "start": 0, "end": seconds}]}}).json()
    render = client.post(f"/api/projects/{pid}/renders", json={"version_id": seq["current_version_id"]}).json()
    wait_jobs(services)
    return pid, video, seq, render["id"]


def connect(client, fake: FakeRelay, config: RelayConfig = TOKEN) -> RelayConnector:
    cue = client.app.state.cue
    cue.relay = RelayConnector(cue.s, config, transport=fake.transport())
    return cue.relay


def approve(client, aid):
    r = client.post(f"/api/cue/actions/{aid}/approve")
    assert r.status_code == 200, r.text
    return r.json()


def test_config_rules():
    assert TOKEN.configured and TOKEN.auth_mode == "access-service-token"
    assert not RelayConfig(url="http://relay.example", workspace_id="w", client_id="a", client_secret="b").configured
    assert RelayConfig(url="http://127.0.0.1:8790", workspace_id="w", dev_identity="x@y").configured
    remote_dev = RelayConfig(url="https://relay.example", workspace_id="w", dev_identity="x@y")
    assert not remote_dev.configured and "localhost" in remote_dev.problem()
    assert "CUE_RELAY_URL" in RelayConfig().problem()


def test_publish_requires_approval_and_is_idempotent(client, services, fixture_dir):
    pid, _, _, rid = rendered_project(client, services, fixture_dir)
    fake = FakeRelay()
    connect(client, fake)
    # Proposing does nothing remotely.
    act = client.post("/api/cue/actions", json={"kind": "publish_to_relay", "project_id": pid, "args": {"render_id": rid}}).json()
    assert act["status"] == "proposed" and act["risk"] == "external_delivery" and fake.calls == []
    done = approve(client, act["id"])
    assert done["status"] == "executed", done
    assert len(fake.projects) == 1 and len(fake.versions) == 1
    remote = next(iter(fake.projects.values()))
    assert f"cue-project:{pid}" in remote["description"] and remote["name"] == "Portal Test"
    version = fake.versions[0]
    local = services.render_file(pid, rid, "mp4")
    assert version["sha256"] == hashlib.sha256(local.read_bytes()).hexdigest()  # exact bytes, streamed from the render
    assert version["file_name"].startswith(f"cutcue-{rid}-")
    pub = client.get("/api/cue/relay", params={"project_id": pid}).json()
    assert pub["publications"][0]["status"] == "published" and pub["link"]["remote_project_id"] == remote["id"]
    assert any(n["kind"] == "relay_published" for n in client.get("/api/cue/notifications").json()["items"])
    # Can't propose the same render again; a direct second publish is a no-op.
    again = client.post("/api/cue/actions", json={"kind": "publish_to_relay", "project_id": pid, "args": {"render_id": rid}})
    assert again.status_code == 400 and "already published" in again.json()["detail"]
    assert client.app.state.cue.relay.publish(pid, rid)["already_published"] is True
    assert len(fake.versions) == 1 and len(fake.projects) == 1


def test_lost_response_after_commit_reconciles_instead_of_duplicating(client, services, fixture_dir):
    pid, _, _, rid = rendered_project(client, services, fixture_dir)
    fake = FakeRelay()
    fake.fail_after_patch_commit = 1
    relay = connect(client, fake)
    act = client.post("/api/cue/actions", json={"kind": "publish_to_relay", "project_id": pid}).json()
    failed = approve(client, act["id"])
    assert failed["status"] == "failed" and "Network problem" in failed["error"]
    assert len(fake.versions) == 1  # it actually got through
    assert client.get("/api/cue/relay", params={"project_id": pid}).json()["publications"][0]["status"] == "failed"
    # Retrying (a new approval) finds the version by its deterministic name: no second upload, no second project.
    retry = client.post("/api/cue/actions", json={"kind": "publish_to_relay", "project_id": pid}).json()
    ok = approve(client, retry["id"])
    assert ok["status"] == "executed" and "already there" in ok["result"]["note"]
    assert len(fake.versions) == 1 and len(fake.projects) == 1
    assert relay.publications(pid)[0]["attempts"] == 2


def test_flaky_part_is_resent_and_new_renders_reuse_the_project(client, services, fixture_dir):
    pid, video, seq, rid = rendered_project(client, services, fixture_dir, seconds=8.0)
    fake = FakeRelay()
    fake.fail_part_once = {1}
    relay = connect(client, fake)
    relay.publish(pid, rid)
    assert len(fake.versions) == 1
    # A second, different render of the same project: same remote project, new version.
    client.post(f"/api/projects/{pid}/sequences/{seq['id']}/versions", json={"timeline": {
        "clips": [{"asset_id": video["id"], "start": 1, "end": 5}]}})
    vid = client.get(f"/api/projects/{pid}/sequences").json()[0]["current_version_id"]
    rid2 = client.post(f"/api/projects/{pid}/renders", json={"version_id": vid}).json()["id"]
    wait_jobs(services)
    relay.publish(pid, rid2)
    assert len(fake.projects) == 1 and len(fake.versions) == 2
    assert [v["number"] for v in fake.versions] == [1, 2]


def test_failures_are_safe_and_explained(client, services, fixture_dir):
    pid, _, _, rid = rendered_project(client, services, fixture_dir)
    # Not configured: proposing is refused with what to set.
    client.app.state.cue.relay = RelayConnector(services, RelayConfig())
    r = client.post("/api/cue/actions", json={"kind": "publish_to_relay", "project_id": pid})
    assert r.status_code == 400 and "CUE_RELAY_URL" in r.json()["detail"]
    # Connector not a member of the workspace.
    fake = FakeRelay(member="someone-else@menapoly.test")
    relay = connect(client, fake)
    with pytest.raises(RelayError, match="not a member"):
        relay.publish(pid, rid)
    # Access redirect (service token not accepted).
    fake = FakeRelay()
    fake.status_override = 302
    relay = connect(client, fake)
    with pytest.raises(RelayError, match="redirected to sign-in"):
        relay.publish(pid, rid)
    # A linked remote project that disappeared is reported, not silently recreated.
    fake = FakeRelay()
    relay = connect(client, fake)
    relay.publish(pid, rid)
    fake.projects.clear()
    fake.versions.clear()
    services.db.execute("UPDATE relay_publications SET status = 'failed'")
    with pytest.raises(RelayError, match="no longer exists"):
        relay.publish(pid, rid)
    assert fake.projects == {}
    # Concurrent attempt: a fresh "uploading" claim blocks a second publisher.
    services.db.execute("UPDATE relay_publications SET status = 'uploading', updated_at = strftime('%s','now')")
    with pytest.raises(RelayError, match="already being published"):
        relay.publish(pid, rid)


def test_identities_are_consistent_across_surfaces(client, services, fixture_dir):
    """One project/asset/render identity across Projects, Cut Cue, v1, Library, reviews and delivery."""
    pid, video, seq, rid = rendered_project(client, services, fixture_dir)
    card = client.get(f"/api/cue/projects/{pid}").json()
    assert card["project"]["id"] == pid == client.get(f"/api/projects/{pid}").json()["id"] == client.get(f"/api/v1/projects/{pid}").json()["id"]
    assert [a["id"] for a in card["assets"]] == [a["id"] for a in client.get(f"/api/projects/{pid}/assets").json()] \
        == [a["id"] for a in client.get(f"/api/v1/projects/{pid}/assets").json()]
    lib = client.get("/api/cue/library", params={"kind": "media"}).json()["media"]
    assert any(m["id"] == video["id"] and m["project_id"] == pid for m in lib)
    assert card["renders"][0]["id"] == rid == client.get(f"/api/v1/projects/{pid}/renders").json()[0]["id"]
    link = client.post(f"/api/cue/projects/{pid}/review-links", json={"render_id": rid}).json()
    assert link["render_id"] == rid
    # Another project's render can't be shared or published through this project.
    other, *_ = rendered_project(client, services, fixture_dir, name="Other")
    assert client.post(f"/api/cue/projects/{other}/review-links", json={"render_id": rid}).status_code == 404
    fake = FakeRelay()
    connect(client, fake)
    assert client.post("/api/cue/actions", json={"kind": "publish_to_relay", "project_id": other, "args": {"render_id": rid}}).status_code == 404
    act = client.post("/api/cue/actions", json={"kind": "publish_to_relay", "project_id": pid, "args": {"render_id": rid}}).json()
    approve(client, act["id"])
    pub = client.get("/api/cue/relay", params={"project_id": pid}).json()["publications"][0]
    assert pub["render_id"] == rid and pub["project_id"] == pid


# --- against the real MenapolyRelay app (optional) ----------------------------------------------------------
REAL = os.environ.get("CUE_RELAY_TEST_URL")


@pytest.mark.skipif(not REAL, reason="set CUE_RELAY_TEST_URL to a running Relay dev server (chatgpt-sites mode)")
def test_real_relay_publish_twice_one_version(client, services, fixture_dir):
    owner, bot = "owner@menapoly.test", "cutcue-connector@menapoly.test"
    http = httpx.Client(base_url=REAL, timeout=60)
    who = lambda email: {"oai-authenticated-user-email": email}  # noqa: E731
    bundle = http.get("/api/os", headers=who(owner)).json()
    ws = next((w for w in bundle["workspaces"] if w["name"] == "Cut Cue connector test"), None)
    if ws is None:
        r = http.post("/api/os", headers=who(owner), json={"action": "create_workspace", "name": "Cut Cue connector test"})
        assert r.status_code == 200, r.text
        ws_id = r.json()["workspaceId"]
        r = http.post("/api/os", headers=who(owner), json={"action": "invite_member", "workspaceId": ws_id, "email": bot, "role": "editor"})
        assert r.status_code == 200, r.text
    else:
        ws_id = ws["id"]
    pid, _, _, rid = rendered_project(client, services, fixture_dir, name="Real Relay check")
    cue = client.app.state.cue
    cue.relay = RelayConnector(services, RelayConfig(url=REAL, workspace_id=ws_id, dev_identity=bot))
    act = client.post("/api/cue/actions", json={"kind": "publish_to_relay", "project_id": pid, "args": {"render_id": rid}}).json()
    done = approve(client, act["id"])
    assert done["status"] == "executed", done
    pub = cue.relay.publications(pid)[0]
    # Simulate "lost response": mark failed and publish again: must reconcile, not duplicate.
    services.db.execute("UPDATE relay_publications SET status = 'failed' WHERE id = ?", [pub["id"]])
    again = cue.relay.publish(pid, rid)
    assert again["reconciled"] is True and again["remote_version_id"] == pub["remote_version_id"]
    remote = http.get("/api/os", headers=who(owner), params={"workspace_id": ws_id}).json()
    mine = [p for p in remote["projects"] if f"cue-project:{pid}" in (p.get("description") or "")]
    assert len(mine) == 1
    versions = [v for v in remote["versions"] if v["project_id"] == mine[0]["id"]]
    assert len(versions) == 1 and versions[0]["file_name"] == pub["file_name"]
    assert versions[0]["size"] == services.render_file(pid, rid, "mp4").stat().st_size
    # Relay notified its approvers and shows the version as in review.
    assert versions[0]["status"] == "in_review"
