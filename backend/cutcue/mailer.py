"""Email notifications over SMTP (standard library only).

- Off unless CUE_SMTP_HOST, CUE_EMAIL_FROM and CUE_EMAIL_TO are set.
- One outbox row per notification (UNIQUE notification_id), so a notification can never be emailed twice.
- A background thread sends queued mail; failures retry with backoff (1, 5, 15, 60 min) and stop after 5 attempts,
  leaving status "failed" with the error visible in Settings.
- The SMTP password is never logged or returned by the API.
"""
from __future__ import annotations

import logging
import smtplib
import ssl
import threading
from dataclasses import dataclass
from email.message import EmailMessage

from .db import Database, new_id, now

log = logging.getLogger("cutcue.email")
BACKOFF = [60, 300, 900, 3600]
MAX_ATTEMPTS = 5


@dataclass
class EmailConfig:
    host: str = ""
    port: int = 587
    user: str = ""
    password: str = ""
    security: str = "starttls"
    sender: str = ""
    to: str = ""
    kinds: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.host and self.sender and self.to)

    def wants(self, kind: str) -> bool:
        return kind in {k.strip() for k in self.kinds.split(",") if k.strip()}


class EmailNotifier:
    def __init__(self, db: Database, config: EmailConfig, public_url: str = "", start: bool = True):
        self.db = db
        self.config = config
        self.public_url = public_url
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        if start and config.configured:
            self._thread = threading.Thread(target=self._loop, name="email-sender", daemon=True)
            self._thread.start()

    def status(self) -> dict:
        c = self.config
        counts = {r["status"]: r["n"] for r in self.db.all("SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status")}
        recent = self.db.all("""SELECT id, to_addr, subject, status, attempts, error, created_at, sent_at FROM email_outbox
                                ORDER BY created_at DESC LIMIT 10""")
        return {"configured": c.configured, "to": c.to or None, "from": c.sender or None, "host": c.host or None,
                "kinds": [k for k in c.kinds.split(",") if k], "counts": counts, "recent": recent}

    def enqueue(self, notification: dict) -> bool:
        """Queue one email for a notification. Returns True if queued (False if off, filtered, or already queued)."""
        c = self.config
        if not c.configured or not c.wants(notification["kind"]):
            return False
        link = f"\n\nOpen: {self.public_url}{notification['href']}" if self.public_url and notification.get("href") else ""
        body = (f"{notification['title']}\n\n{notification.get('body') or ''}{link}\n\n"
                "— Menapoly Cue (sent from your own computer). Change which emails you get in Settings.")
        cur = self.db.execute("""INSERT OR IGNORE INTO email_outbox (id, notification_id, to_addr, subject, body, status, created_at,
                                 next_attempt_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)""",
                              [new_id("eml"), notification["id"], c.to, f"Menapoly Cue: {notification['title']}"[:200], body,
                               now(), now()])
        if cur.rowcount:
            self._wake.set()
        return bool(cur.rowcount)

    def send_test(self) -> dict:
        if not self.config.configured:
            raise ValueError("Email isn't set up. Add CUE_SMTP_HOST, CUE_EMAIL_FROM and CUE_EMAIL_TO to .env.")
        row = {"id": new_id("eml"), "notification_id": None, "to_addr": self.config.to, "subject": "Menapoly Cue: test email",
               "body": "This is a test email from Menapoly Cue. Notifications will arrive like this.",
               "status": "queued", "created_at": now(), "next_attempt_at": now()}
        self.db.insert("email_outbox", row)
        self.process_due()
        return self.db.one("SELECT id, status, error, attempts, sent_at FROM email_outbox WHERE id = ?", [row["id"]])

    def process_due(self) -> int:
        """Send everything that is due. Returns the number sent."""
        sent = 0
        for row in self.db.all("""SELECT * FROM email_outbox WHERE status IN ('queued','retrying') AND next_attempt_at <= ?
                                  ORDER BY created_at LIMIT 20""", [now()]):
            claimed = self.db.execute("UPDATE email_outbox SET status = 'sending' WHERE id = ? AND status IN ('queued','retrying')",
                                      [row["id"]])
            if claimed.rowcount != 1:
                continue
            try:
                self._send(row["to_addr"], row["subject"], row["body"])
                self.db.update("email_outbox", "id", row["id"], {"status": "sent", "sent_at": now(), "attempts": row["attempts"] + 1,
                                                                 "error": None})
                sent += 1
            except Exception as exc:  # noqa: BLE001 - any SMTP/network failure is recorded and retried
                attempts = row["attempts"] + 1
                final = attempts >= MAX_ATTEMPTS
                self.db.update("email_outbox", "id", row["id"], {
                    "status": "failed" if final else "retrying", "attempts": attempts, "error": f"{type(exc).__name__}: {exc}"[:500],
                    "next_attempt_at": now() + BACKOFF[min(attempts - 1, len(BACKOFF) - 1)]})
                log.warning("email %s attempt %s failed: %s", row["id"], attempts, type(exc).__name__)
        return sent

    def _send(self, to: str, subject: str, body: str) -> None:
        c = self.config
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = c.sender, to, subject
        msg.set_content(body)
        context = ssl.create_default_context()
        if c.security == "ssl":
            server = smtplib.SMTP_SSL(c.host, c.port, timeout=20, context=context)
        else:
            server = smtplib.SMTP(c.host, c.port, timeout=20)
        with server:
            server.ehlo()
            if c.security == "starttls":
                server.starttls(context=context)
                server.ehlo()
            if c.user:
                server.login(c.user, c.password)
            server.send_message(msg)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.process_due()
            except Exception:  # noqa: BLE001
                log.exception("email loop")
            self._wake.wait(30)
            self._wake.clear()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
