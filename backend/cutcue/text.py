"""Cue Text: SMS/MMS intake for Menapoly Cue.

What is real here:
- Inbound pipeline: webhook signature check, de-duplication on the provider message ID, approved-sender
  matching with recorded consent, STOP/START/HELP handling, natural-language intent parsing, approval-gated
  actions, owner notifications and a complete audit history (``text_messages``).
- Twilio-format webhook verification (HMAC-SHA1 over URL + sorted form fields, per Twilio's published scheme).
  It is unit-tested with signatures computed locally; it has NOT been tested against a live Twilio account.
- A clearly labelled simulator so the owner can try intake without any provider.

What is deliberately NOT here:
- Sending. No message is ever sent. Replies are stored as drafts with status ``draft_not_sent``. A real sender
  needs provider credentials, a registered number, consent records and the owner's approval; until then the
  ``send_text`` action fails with a clear message.
- Downloading MMS media from the provider (needs provider credentials). Media URLs are recorded and the owner
  is offered a secure upload link instead.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
from dataclasses import dataclass

from .cue import Cue
from .db import dumps, loads, new_id, now
from .services import BadRequest, NotFound, check_id

STOP_WORDS = {"stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout"}
START_WORDS = {"start", "unstop", "yes"}
HELP_WORDS = {"help", "info"}
MAX_BODY = 1600
MAX_MEDIA = 10


@dataclass
class TextConfig:
    provider: str = ""          # "" (off) or "twilio"
    number: str = ""            # the dedicated Cue number, E.164
    auth_token: str = ""        # provider webhook signing secret
    webhook_url: str = ""       # exact public URL the provider posts to (used in the signature)

    @property
    def inbound_ready(self) -> bool:
        return bool(self.provider and self.auth_token and self.webhook_url and self.number)


def normalize_phone(raw: str) -> str:
    raw = (raw or "").strip()
    digits = re.sub(r"[^\d]", "", raw)
    if raw.startswith("+"):
        phone = "+" + digits
    elif len(digits) == 10:  # assume North American number without country code
        phone = "+1" + digits
    elif len(digits) == 11 and digits.startswith("1"):
        phone = "+" + digits
    else:
        phone = "+" + digits
    if not re.fullmatch(r"\+[1-9]\d{6,14}", phone):
        raise BadRequest("Enter a full phone number, e.g. +1 555 123 4567")
    return phone


def twilio_signature(auth_token: str, url: str, params: dict[str, str | list[str]]) -> str:
    data = url
    for key in sorted(params):
        values = params[key] if isinstance(params[key], list) else [params[key]]
        for value in values:
            data += key + str(value)
    digest = hmac.new(auth_token.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def verify_twilio(auth_token: str, url: str, params: dict, signature: str) -> bool:
    if not (auth_token and url and signature):
        return False
    return hmac.compare_digest(twilio_signature(auth_token, url, params), signature)


def parse_twilio(params: dict) -> dict:
    count = min(int(params.get("NumMedia") or 0), MAX_MEDIA)
    media = [{"url": params.get(f"MediaUrl{i}", ""), "content_type": params.get(f"MediaContentType{i}", "")}
             for i in range(count)]
    return {"provider_id": params.get("MessageSid") or params.get("SmsSid") or "", "from": params.get("From", ""),
            "to": params.get("To", ""), "body": params.get("Body", ""), "media": media}


class CueText:
    def __init__(self, cue: Cue, config: TextConfig):
        self.cue = cue
        self.db = cue.db
        self.config = config

    # --- status ------------------------------------------------------------------------------------
    def status(self) -> dict:
        c = self.config
        return {"provider": c.provider or None, "number": c.number or None, "inbound_ready": c.inbound_ready,
                "sending_enabled": False,
                "sending_note": "Sending is not implemented yet. Replies are saved as drafts and nothing is texted to anyone.",
                "approved_senders": self.db.one("SELECT COUNT(*) AS n FROM text_senders WHERE consent_at IS NOT NULL "
                                                "AND opted_out_at IS NULL")["n"]}

    # --- approved senders -----------------------------------------------------------------------------
    def senders(self) -> list[dict]:
        return self.db.all("SELECT * FROM text_senders ORDER BY name COLLATE NOCASE")

    def add_sender(self, phone: str, name: str, consent: bool, consent_note: str = "") -> dict:
        phone = normalize_phone(phone)
        name = (name or "").strip()[:80]
        if not name:
            raise BadRequest("Add a name for this number")
        if not consent:
            raise BadRequest("Confirm this person agreed to text with Menapoly Cue before adding them")
        existing = self.db.one("SELECT * FROM text_senders WHERE phone = ?", [phone])
        values = {"name": name, "consent_at": now(), "consent_note": (consent_note or "")[:300]}
        if existing:
            self.db.update("text_senders", "id", existing["id"], values)
            return self.db.one("SELECT * FROM text_senders WHERE id = ?", [existing["id"]])
        row = {"id": new_id("snd"), "phone": phone, "created_at": now(), **values}
        self.db.insert("text_senders", row)
        return row

    def remove_sender(self, sender_id: str) -> None:
        self.db.execute("DELETE FROM text_senders WHERE id = ?", [check_id(sender_id, "snd")])

    # --- history --------------------------------------------------------------------------------------
    def messages(self, limit: int = 100) -> list[dict]:
        rows = self.db.all("""SELECT m.*, s.name AS sender_name, p.name AS project_name FROM text_messages m
                              LEFT JOIN text_senders s ON s.id = m.sender_id LEFT JOIN projects p ON p.id = m.project_id
                              ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?""", [min(max(limit, 1), 500)])
        for r in rows:
            r["media"] = loads(r.pop("media_json"), [])
        return rows

    def _draft_reply(self, inbound: dict, body: str) -> None:
        """Record what Cue *would* reply. Never sent (see module docstring)."""
        self.db.insert("text_messages", {
            "id": new_id("txt"), "direction": "out", "provider": inbound["provider"], "provider_id": None,
            "from_number": self.config.number or "(no Cue number)", "to_number": inbound["from_number"], "body": body[:MAX_BODY],
            "media_json": "[]", "status": "draft_not_sent", "detail": "Sending is not set up; nothing was sent.",
            "sender_id": inbound.get("sender_id"), "project_id": inbound.get("project_id"), "created_at": now()})

    # --- inbound pipeline -----------------------------------------------------------------------------
    def receive(self, provider: str, provider_id: str, from_number: str, to_number: str, body: str,
                media: list[dict] | None = None) -> dict:
        """Store and process one inbound message exactly once. Returns the stored record."""
        provider_id = (provider_id or "").strip()[:64]
        if not provider_id:
            raise BadRequest("Missing provider message ID")
        existing = self.db.one("SELECT * FROM text_messages WHERE provider = ? AND provider_id = ?", [provider, provider_id])
        if existing:
            existing["duplicate"] = True
            existing["media"] = loads(existing.pop("media_json"), [])
            return existing
        try:
            sender_phone = normalize_phone(from_number)
        except BadRequest:
            sender_phone = (from_number or "unknown")[:32]
        media = [{"url": str(m.get("url", ""))[:500], "content_type": str(m.get("content_type", ""))[:80]}
                 for m in (media or [])[:MAX_MEDIA]]
        row = {"id": new_id("txt"), "direction": "in", "provider": provider, "provider_id": provider_id,
               "from_number": sender_phone, "to_number": (to_number or "")[:32], "body": (body or "")[:MAX_BODY],
               "media_json": dumps(media), "status": "received", "created_at": now()}
        try:
            self.db.insert("text_messages", row)
        except Exception:  # lost a race with a retry of the same webhook: treat as duplicate
            existing = self.db.one("SELECT * FROM text_messages WHERE provider = ? AND provider_id = ?", [provider, provider_id])
            if existing:
                existing["duplicate"] = True
                existing["media"] = loads(existing.pop("media_json"), [])
                return existing
            raise
        self.process(row["id"])
        out = self.db.one("SELECT * FROM text_messages WHERE id = ?", [row["id"]])
        out["media"] = loads(out.pop("media_json"), [])
        out["duplicate"] = False
        return out

    def reprocess(self, message_id: str) -> dict:
        row = self.db.one("SELECT * FROM text_messages WHERE id = ? AND direction = 'in'", [check_id(message_id, "txt")])
        if not row:
            raise NotFound("Message not found")
        if row["status"] != "error":
            raise BadRequest("Only messages that failed to process can be retried")
        self.process(row["id"])
        return self.db.one("SELECT * FROM text_messages WHERE id = ?", [row["id"]])

    def _set(self, message_id: str, status: str, detail: str, **extra) -> None:
        self.db.update("text_messages", "id", message_id, {"status": status, "detail": detail[:500], **extra})

    def process(self, message_id: str) -> None:
        msg = self.db.one("SELECT * FROM text_messages WHERE id = ?", [message_id])
        try:
            self._process(msg)
        except Exception as exc:  # recorded for retry; never silently dropped
            self._set(message_id, "error", f"Couldn't process this message: {exc}")

    def _process(self, msg: dict) -> None:
        sender = self.db.one("SELECT * FROM text_senders WHERE phone = ?", [msg["from_number"]])
        word = re.sub(r"[^a-z]", "", msg["body"].strip().lower())
        if word in STOP_WORDS:
            if sender:
                self.db.update("text_senders", "id", sender["id"], {"opted_out_at": now()})
            self._set(msg["id"], "opt_out", "Number opted out. Cue will not text it again unless they text START.",
                      sender_id=sender["id"] if sender else None)
            return
        if word in START_WORDS and sender and sender["opted_out_at"]:
            self.db.update("text_senders", "id", sender["id"], {"opted_out_at": None})
            self._set(msg["id"], "opt_in", "Number opted back in.", sender_id=sender["id"])
            return
        if not sender or not sender["consent_at"]:
            self._set(msg["id"], "rejected_unknown_sender", "Number is not on the approved list. Nothing was done.")
            day = int(now() // 86400)
            self.cue.notify("text_unknown", "A number that isn't approved texted Cue", body=f"{msg['from_number']}: {msg['body'][:120]}",
                            href="/inbox/?tab=messages", source_key=f"text_unknown:{msg['from_number']}:{day}")
            return
        if sender["opted_out_at"]:
            self._set(msg["id"], "ignored_opted_out", "This number opted out; message stored only.", sender_id=sender["id"])
            return
        inbound = {**msg, "sender_id": sender["id"]}
        if word in HELP_WORDS:
            self._set(msg["id"], "help", "Help requested.", sender_id=sender["id"])
            self._draft_reply(inbound, "Menapoly Cue: text “new project NAME”, “status”, or “changes: what to change”. "
                                       "Send photos or short videos to add them. Reply STOP to opt out.")
            return
        self._intent(inbound, sender)

    def _project_for(self, text: str) -> dict | None:
        lower = text.lower()
        cards = self.cue.project_cards()
        named = [p for p in cards if p["name"].lower() in lower]
        return max(named, key=lambda p: len(p["name"])) if named else None

    def _intent(self, msg: dict, sender: dict) -> None:
        body = msg["body"].strip()
        lower = body.lower()
        media = loads(msg["media_json"], [])
        project = self._project_for(body)
        common = {"sender_id": sender["id"]}
        create = re.match(r"^(?:new|create|start)\s+(?:a\s+)?project\s*[:\-]?\s*(.{2,80})$", body, re.I | re.S)
        if create:
            action = self.cue.propose_action("create_project", {"name": create.group(1).strip()}, created_by="cue_text",
                                             reason=f"Texted by {sender['name']}")
            self._set(msg["id"], "action_proposed", "Waiting for your approval in Inbox.", action_id=action["id"], **common)
            self._notify(msg, sender, f"{sender['name']} asked for a new project", action["summary"])
            self._draft_reply(msg, "Got it. Your project request is waiting for approval.")
            return
        changes = re.match(r"^(?:changes?|revise|revision|fix)\s*[:\-]\s*(.+)$", body, re.I | re.S)
        if changes:
            target = project or (self.cue.project_cards() or [None])[0]
            if not target:
                self._set(msg["id"], "needs_project", "No project to apply changes to.", **common)
                self._notify(msg, sender, f"{sender['name']} sent changes but no project matched", body[:120])
                return
            notes = f"- {sender['name']} (by text): {changes.group(1).strip()}"
            action = self.cue.propose_action("request_revision", {"notes": notes}, project_id=target["id"], created_by="cue_text",
                                             reason=f"Texted by {sender['name']}")
            self._set(msg["id"], "action_proposed", "Revision waiting for your approval.", action_id=action["id"],
                      project_id=target["id"], **common)
            self._notify(msg, sender, f"{sender['name']} requested changes on {target['name']}", changes.group(1)[:160], target["id"])
            self._draft_reply(msg | {"project_id": target["id"]}, "Thanks. Your changes are queued for the editor.")
            return
        if re.match(r"^(?:status|update|where are we|how'?s it going)\b", lower):
            target = project or (self.cue.project_cards() or [None])[0]
            text = (f"{target['name']}: {target['status']['label']}." if target else "No projects yet.")
            self._set(msg["id"], "status_request", "Status reply drafted.", project_id=target["id"] if target else None, **common)
            self._draft_reply(msg, f"Menapoly Cue: {text}")
            return
        if media:
            target = project
            detail = (f"{len(media)} attachment(s) recorded. Downloading them needs the SMS provider to be connected; "
                      "use an upload link meanwhile.")
            self._set(msg["id"], "media_received", detail, project_id=target["id"] if target else None, **common)
            self._notify(msg, sender, f"{sender['name']} texted {len(media)} photo/video file(s)", detail, target["id"] if target else None)
            return
        self._set(msg["id"], "note", "Saved as a note for you.", project_id=project["id"] if project else None, **common)
        self._notify(msg, sender, f"Text from {sender['name']}", body[:160], project["id"] if project else None)

    def _notify(self, msg: dict, sender: dict, title: str, body: str, project_id: str | None = None) -> None:
        self.cue.notify("text_in", title, body=body, project_id=project_id, href="/inbox/?tab=messages",
                        source_key=f"text:{msg['id']}")
