"""Cue Text intake: approved senders with consent, de-duplication, STOP/START/HELP, intents that only propose
actions, drafts that are never sent, and Twilio-format webhook signature checks (computed locally; this is
not a test against a live provider)."""
from fastapi.testclient import TestClient

from cutcue.text import normalize_phone, parse_twilio, twilio_signature, verify_twilio

OWNER = "+15551230001"


def sim(client, body, sender=OWNER, mid=None, media=None):
    r = client.post("/api/cue/text/simulate", json={"from_number": sender, "body": body, "message_id": mid, "media": media or []})
    assert r.status_code == 201, r.text
    return r.json()


def test_phone_normalization():
    assert normalize_phone("(555) 123-4567") == "+15551234567"
    assert normalize_phone("+44 20 7946 0958") == "+442079460958"
    for bad in ("", "123", "+0123456"):
        try:
            normalize_phone(bad)
            raise AssertionError(bad)
        except ValueError:
            pass


def test_intake_pipeline(client, services):
    status = client.get("/api/cue/text").json()
    assert status["sending_enabled"] is False and status["inbound_ready"] is False

    # Unknown sender: stored, nothing done, owner told once per day.
    r = sim(client, "new project Hacked")
    assert r["status"] == "rejected_unknown_sender" and not r["action_id"]
    sim(client, "hello again")
    assert [n["kind"] for n in client.get("/api/cue/notifications").json()["items"]].count("text_unknown") == 1

    # Consent is required to approve a sender.
    assert client.post("/api/cue/text/senders", json={"phone": OWNER, "name": "Me"}).status_code == 400
    s = client.post("/api/cue/text/senders", json={"phone": "555-123-0001", "name": "Me", "consent": True,
                                                   "consent_note": "Owner's own phone"}).json()
    assert s["phone"] == OWNER and s["consent_at"]

    # New project -> proposed action only, with a drafted (unsent) reply.
    r = sim(client, "New project: Coffee Launch", mid="SM1")
    assert r["status"] == "action_proposed" and r["action_id"]
    action = client.get("/api/cue/actions", params={"status": "proposed"}).json()[0]
    assert action["created_by"] == "cue_text" and action["args"]["name"] == "Coffee Launch"
    assert not any(p["name"] == "Coffee Launch" for p in client.get("/api/cue/projects").json())
    msgs = client.get("/api/cue/text").json()["messages"]
    draft = next(m for m in msgs if m["direction"] == "out")
    assert draft["status"] == "draft_not_sent" and draft["to_number"] == OWNER

    # Provider retries the same webhook: processed once.
    dup = sim(client, "New project: Coffee Launch", mid="SM1")
    assert dup["duplicate"] is True
    assert len(client.get("/api/cue/actions", params={"status": "proposed"}).json()) == 1

    # Approve -> project exists. Changes by text -> revision proposal on the named project.
    client.post(f"/api/cue/actions/{action['id']}/approve")
    r = sim(client, "changes: Coffee Launch needs a shorter intro")
    assert r["status"] == "action_proposed" and r["project_id"]
    rev = next(a for a in client.get("/api/cue/actions", params={"status": "proposed"}).json() if a["id"] == r["action_id"])
    assert rev["kind"] == "request_revision" and "shorter intro" in rev["args"]["notes"]

    # Status request drafts a real status line (the revision above is waiting for approval).
    r = sim(client, "status Coffee Launch")
    assert r["status"] == "status_request"
    assert "Coffee Launch: Waiting for your review." in client.get("/api/cue/text").json()["messages"][0]["body"]

    # Media is recorded, not downloaded (provider credentials required).
    r = sim(client, "", media=[{"url": "https://api.twilio.com/x/Media/ME1", "content_type": "image/jpeg"}])
    assert r["status"] == "media_received" and len(r["media"]) == 1

    # HELP drafts help; STOP opts out and later texts are ignored; START opts back in.
    assert sim(client, "HELP")["status"] == "help"
    assert sim(client, "Stop")["status"] == "opt_out"
    assert sim(client, "new project After Stop")["status"] == "ignored_opted_out"
    assert sim(client, "START")["status"] == "opt_in"
    assert sim(client, "just a note")["status"] == "note"

    # Nothing outbound was ever marked sent.
    assert {m["status"] for m in client.get("/api/cue/text").json()["messages"] if m["direction"] == "out"} == {"draft_not_sent"}


def test_failed_processing_is_recorded_and_retryable(client, services, monkeypatch):
    client.post("/api/cue/text/senders", json={"phone": OWNER, "name": "Me", "consent": True})
    text = client.app.state.text
    original = text._intent
    monkeypatch.setattr(text, "_intent", lambda *a: (_ for _ in ()).throw(RuntimeError("db hiccup")))
    r = sim(client, "new project Retry Me")
    assert r["status"] == "error" and "db hiccup" in r["detail"]
    monkeypatch.setattr(text, "_intent", original)
    again = client.post(f"/api/cue/text/messages/{r['id']}/retry").json()
    assert again["status"] == "action_proposed"
    assert client.post(f"/api/cue/text/messages/{r['id']}/retry").status_code == 400


def test_twilio_signature_scheme():
    # Signature over URL + sorted key/value pairs (HMAC-SHA1, base64). Values computed locally.
    params = {"To": "+15550000000", "From": OWNER, "Body": "hi", "MessageSid": "SM123"}
    sig = twilio_signature("secret", "https://cue.example/api/public/text/twilio", params)
    assert verify_twilio("secret", "https://cue.example/api/public/text/twilio", params, sig)
    assert not verify_twilio("other", "https://cue.example/api/public/text/twilio", params, sig)
    assert not verify_twilio("secret", "https://cue.example/api/public/text/twilio", {**params, "Body": "hi!"}, sig)
    assert not verify_twilio("secret", "https://cue.example/api/public/text/twilio", params, "")
    parsed = parse_twilio({**params, "NumMedia": "2", "MediaUrl0": "u0", "MediaContentType0": "image/png",
                           "MediaUrl1": "u1", "MediaContentType1": "video/mp4"})
    assert parsed["provider_id"] == "SM123" and [m["url"] for m in parsed["media"]] == ["u0", "u1"]


def test_webhook_requires_configuration_and_valid_signature(tmp_path, fixture_dir):
    from cutcue.config import Settings
    from cutcue.main import create_app
    from cutcue.services import Services

    off = Settings(data_dir=tmp_path / "a", transcriber="fixture")
    with TestClient(create_app(off, Services(off))) as c:
        assert c.post("/api/public/text/twilio", data={"Body": "x"}).status_code == 503

    url = "https://cue.example/api/public/text/twilio"
    on = Settings(data_dir=tmp_path / "b", transcriber="fixture", password="pw", secret_key="k", text_provider="twilio",
                  text_number="+15550000000", text_auth_token="tok", text_webhook_url=url)
    svc = Services(on)
    with TestClient(create_app(on, svc)) as c:
        form = {"MessageSid": "SM9", "From": OWNER, "To": "+15550000000", "Body": "hello", "NumMedia": "0"}
        assert c.post("/api/public/text/twilio", data=form, headers={"X-Twilio-Signature": "bad"}).status_code == 403
        assert svc.db.one("SELECT COUNT(*) AS n FROM text_messages")["n"] == 0  # forged requests store nothing
        good = twilio_signature("tok", url, form)
        r = c.post("/api/public/text/twilio", data=form, headers={"X-Twilio-Signature": good})
        assert r.status_code == 200 and "<Response></Response>" in r.text  # acknowledges, never replies
        row = svc.db.one("SELECT * FROM text_messages")
        assert row["provider"] == "twilio" and row["provider_id"] == "SM9" and row["status"] == "rejected_unknown_sender"
        c.post("/api/public/text/twilio", data=form, headers={"X-Twilio-Signature": good})
        assert svc.db.one("SELECT COUNT(*) AS n FROM text_messages")["n"] == 1  # retry de-duplicated
