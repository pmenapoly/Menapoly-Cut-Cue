"""Connection-status page and first-run setup: honest statuses from real checks, live portal probe, no secrets."""
from relay_fake import FakeRelay

from cutcue.relay import RelayConfig, RelayConnector


def test_statuses_and_first_run(client, services):
    r = client.get("/api/cue/connections").json()
    items = {i["key"]: i for i in r["items"]}
    assert items["ffmpeg"]["status"] == "ready" and items["ffmpeg"]["required"]
    assert items["claude"]["status"] == "not_configured" and "ANTHROPIC_API_KEY" in items["claude"]["fix"]
    assert items["text_out"]["status"] == "awaiting_authorization"  # SMS sending stays off on purpose
    assert items["relay"]["status"] == "not_configured" and items["email"]["status"] == "not_configured"
    assert r["ready_for_projects"] is True and r["has_projects"] is False and r["setup"] == {}
    # Exposed without a password is flagged as a blocking problem.
    services.settings.host = "0.0.0.0"
    r = client.get("/api/cue/connections").json()
    assert "password" in r["blocking"] and r["ready_for_projects"] is False
    services.settings.host = "127.0.0.1"
    # First-run state is stored.
    assert client.post("/api/cue/setup", json={"completed": True, "ignored": 1}).json()["completed"] is True
    assert client.get("/api/cue/connections").json()["setup"]["completed"] is True


def test_portal_probe_ready_vs_awaiting(client, services):
    cue = client.app.state.cue
    cfg = RelayConfig(url="https://relay.example", workspace_id="ws-1", client_id="client-id", client_secret="secret")
    distinctive = RelayConfig(url="https://relay.example", workspace_id="ws-1", client_id="client-id",
                              client_secret="S3CR3T-VALUE-xyz")
    fake = FakeRelay()
    cue.relay = RelayConnector(services, cfg, transport=fake.transport())
    assert {i["key"]: i for i in client.get("/api/cue/connections").json()["items"]}["relay"]["status"] == "awaiting_authorization"
    assert client.post("/api/cue/connections/relay/test").json()["ok"] is True
    relay = {i["key"]: i for i in client.get("/api/cue/connections").json()["items"]}["relay"]
    assert relay["status"] == "ready"
    # Connector not yet invited to the workspace → awaiting authorization, with the reason.
    cue.relay = RelayConnector(services, cfg, transport=FakeRelay(member="someone@else.test").transport())
    probe = client.post("/api/cue/connections/relay/test").json()
    assert probe["ok"] is False and probe["awaiting"] is True
    relay = {i["key"]: i for i in client.get("/api/cue/connections").json()["items"]}["relay"]
    assert relay["status"] == "awaiting_authorization" and "not a member" in relay["detail"]
    cue.relay = RelayConnector(services, distinctive, transport=fake.transport())
    assert "S3CR3T-VALUE-xyz" not in client.get("/api/cue/connections").text
