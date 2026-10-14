"""In-app + email notifications: project status, review requests, completed renders, failures.
Email is delivered over real SMTP to a tiny local SMTP server (no third-party service)."""
import socketserver
import threading
import time

import pytest
from conftest import upload, wait_jobs

from cutcue.mailer import EmailConfig, EmailNotifier


class SMTPSink(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, fail_first: int = 0):
        self.messages: list[dict] = []
        self.fail_first = fail_first
        super().__init__(("127.0.0.1", 0), SMTPHandler)


class SMTPHandler(socketserver.StreamRequestHandler):
    def send(self, line: str) -> None:
        self.wfile.write((line + "\r\n").encode())

    def handle(self) -> None:
        server: SMTPSink = self.server  # type: ignore[assignment]
        if server.fail_first > 0:
            server.fail_first -= 1
            self.send("421 Service not available, try later")
            return
        self.send("220 sink ESMTP")
        msg = {"from": None, "to": [], "data": ""}
        while line := self.rfile.readline():
            cmd = line.decode().rstrip("\r\n")
            upper = cmd.upper()
            if upper.startswith(("EHLO", "HELO")):
                self.send("250 sink")
            elif upper.startswith("MAIL FROM"):
                msg["from"] = cmd.split(":", 1)[1].strip()
                self.send("250 OK")
            elif upper.startswith("RCPT TO"):
                msg["to"].append(cmd.split(":", 1)[1].strip())
                self.send("250 OK")
            elif upper == "DATA":
                self.send("354 End data with <CR><LF>.<CR><LF>")
                body = []
                while (data := self.rfile.readline().decode()) not in (".\r\n", ""):
                    body.append(data)
                msg["data"] = "".join(body)
                server.messages.append(dict(msg))
                self.send("250 OK queued")
            elif upper == "QUIT":
                self.send("221 Bye")
                return
            else:
                self.send("250 OK")


@pytest.fixture()
def sink():
    server = SMTPSink()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server
    server.shutdown()


def mailer_for(client, port: int, kinds: str | None = None) -> EmailNotifier:
    cue = client.app.state.cue
    cfg = EmailConfig(host="127.0.0.1", port=port, security="none", sender="cue@menapoly.test", to="owner@menapoly.test",
                      kinds=kinds or "render_done,job_failed,review_changes_requested,review_requested,stage_changed")
    cue.mailer = EmailNotifier(cue.db, cfg, public_url="http://my-mac.local:8000", start=False)
    return cue.mailer


def test_in_app_and_email_for_render_review_request_stage_and_failure(client, services, fixture_dir, sink):
    mailer = mailer_for(client, sink.server_address[1])
    pid = client.post("/api/cue/projects", json={"name": "Mail Test"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    wait_jobs(services)
    # Review request: an AI/tool proposal asks the owner to review.
    prop = client.post(f"/api/projects/{pid}/auto-edit", json={"asset_id": video["id"]}).json()
    client.post(f"/api/projects/{pid}/proposals/{prop['id']}/approve")
    wait_jobs(services)
    # Project status change.
    client.patch(f"/api/cue/projects/{pid}", json={"stage": "approved"})
    client.patch(f"/api/cue/projects/{pid}", json={"stage": "approved"})  # no change → no second notification
    kinds = [n["kind"] for n in client.get("/api/cue/notifications?limit=100").json()["items"]]
    for k in ("review_requested", "render_done", "stage_changed", "media_ready"):
        assert k in kinds, (k, kinds)
    assert kinds.count("stage_changed") == 2  # draft→editing (auto) and editing→approved; not the repeat
    sent = mailer.process_due()
    subjects = sorted(m["data"].split("Subject: ", 1)[1].split("\n", 1)[0].strip() for m in sink.messages)
    assert sent == len(sink.messages) >= 4
    assert any("Cue proposed an edit" in s for s in subjects) and any("Preview is ready" in s for s in subjects)
    assert not any("Media is ready" in s for s in subjects)  # media_ready is in-app only (not in kinds)
    body = next(m["data"] for m in sink.messages if "Preview is ready" in m["data"])
    assert "http://my-mac.local:8000/projects/?id=" in body and sink.messages[0]["to"] == ["<owner@menapoly.test>"]
    # Each notification is emailed exactly once, even if processed again.
    assert mailer.process_due() == 0
    # Failure notification.
    job = services.list_jobs(pid)[0]
    services.db.execute("UPDATE jobs SET status='failed', error='Invalid data found when processing input' WHERE id = ?", [job["id"]])
    client.app.state.cue._on_job(services.db.one("SELECT * FROM jobs WHERE id = ?", [job["id"]]))
    mailer.process_due()
    failed = [m for m in sink.messages if "failed" in m["data"]]
    assert failed and "damaged" in failed[-1]["data"]
    status = client.get("/api/cue/email").json()
    assert status["configured"] and status["counts"]["sent"] == len(sink.messages) and "password" not in str(status).lower()


def test_email_retries_with_backoff_and_reports_failure(client, services, sink):
    sink.fail_first = 1
    mailer = mailer_for(client, sink.server_address[1])
    client.app.state.cue.notify("render_done", "Final export is ready", body="P", source_key="t:1")
    assert mailer.process_due() == 0
    row = services.db.one("SELECT * FROM email_outbox")
    assert row["status"] == "retrying" and row["attempts"] == 1 and "421" in row["error"]
    assert mailer.process_due() == 0  # not due yet (backoff)
    services.db.execute("UPDATE email_outbox SET next_attempt_at = 0")
    assert mailer.process_due() == 1 and services.db.one("SELECT status FROM email_outbox")["status"] == "sent"
    # A dead server ends as "failed" after 5 attempts, with the error kept.
    dead = EmailNotifier(services.db, EmailConfig(host="127.0.0.1", port=1, security="none", sender="a@b", to="c@d",
                                                  kinds="render_done"), start=False)
    client.app.state.cue.mailer = dead
    client.app.state.cue.notify("render_done", "Another", source_key="t:2")
    for _ in range(5):
        services.db.execute("UPDATE email_outbox SET next_attempt_at = 0 WHERE status = 'retrying' OR status = 'queued'")
        dead.process_due()
    row = services.db.one("SELECT * FROM email_outbox WHERE subject LIKE '%Another%'")
    assert row["status"] == "failed" and row["attempts"] == 5


def test_email_off_by_default_and_test_endpoint(client, services, sink):
    assert client.get("/api/cue/email").json()["configured"] is False
    assert client.post("/api/cue/email/test").status_code == 400
    client.app.state.cue.notify("render_done", "Not emailed", source_key="t:3")
    assert services.db.one("SELECT COUNT(*) AS n FROM email_outbox")["n"] == 0
    mailer_for(client, sink.server_address[1])
    r = client.post("/api/cue/email/test").json()
    assert r["status"] == "sent" and "test email" in sink.messages[-1]["data"]


def test_background_sender_delivers_without_manual_processing(client, services, sink):
    cue = client.app.state.cue
    cfg = EmailConfig(host="127.0.0.1", port=sink.server_address[1], security="none", sender="cue@x.test", to="o@x.test",
                      kinds="render_done")
    cue.mailer = EmailNotifier(cue.db, cfg)  # starts the sender thread
    try:
        cue.notify("render_done", "Background delivery", source_key="t:bg")
        deadline = time.time() + 10
        while time.time() < deadline and not sink.messages:
            time.sleep(0.1)
        assert sink.messages and "Background delivery" in sink.messages[0]["data"]
    finally:
        cue.mailer.stop()
