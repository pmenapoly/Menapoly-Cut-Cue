"""Connection status: what is configured, ready, unavailable or awaiting authorization.

Every status comes from a real check (binary on PATH, model in cache, config present, optional live probe).
Secret values are never returned: only whether they are present.
"""
from __future__ import annotations

import time
from pathlib import Path

from . import media
from .db import dumps, loads, now

READY, NOT_CONFIGURED, UNAVAILABLE, AWAITING, DISABLED = "ready", "not_configured", "unavailable", "awaiting_authorization", "disabled"
LABEL = {READY: "Ready", NOT_CONFIGURED: "Not set up", UNAVAILABLE: "Unavailable", AWAITING: "Awaiting authorization",
         DISABLED: "Turned off"}
SETUP_KEY = "first_run_setup"


def _item(key: str, name: str, status: str, detail: str, *, required: bool = False, fix: str = "", group: str = "Core",
          can_test: bool = False) -> dict:
    return {"key": key, "name": name, "status": status, "status_label": LABEL[status], "detail": detail, "fix": fix,
            "required": required, "group": group, "can_test": can_test}


def whisper_model_cached(model: str) -> bool:
    cache = Path.home() / ".cache" / "huggingface" / "hub"
    return cache.is_dir() and any(cache.glob(f"models--Systran--faster-whisper-{model}*"))


def connections(settings, cue, ask, text) -> list[dict]:
    s = settings
    out = []
    ff = media.tool_available("ffmpeg") and media.tool_available("ffprobe")
    out.append(_item("ffmpeg", "FFmpeg (rendering)", READY if ff else UNAVAILABLE,
                     "Installed and found on this computer." if ff else "FFmpeg or ffprobe is not installed.",
                     required=True, fix="" if ff else "brew install ffmpeg, then restart Menapoly Cue."))
    if s.transcriber == "faster-whisper":
        cached = whisper_model_cached(s.whisper_model)
        out.append(_item("transcription", "Speech-to-text (faster-whisper)", READY if cached else NOT_CONFIGURED,
                         f"Model '{s.whisper_model}' is downloaded." if cached else
                         f"Model '{s.whisper_model}' is not downloaded yet; the first transcription will download it (needs internet).",
                         required=True, fix="" if cached else "make whisper-model"))
    else:
        out.append(_item("transcription", "Speech-to-text", READY if s.transcriber == "fixture" else DISABLED,
                         f"Using the '{s.transcriber}' transcriber (test/development setting, not real speech recognition).",
                         required=True, fix="Set CUTCUE_TRANSCRIBER=faster-whisper in .env for real recordings."))
    claude = bool(s.anthropic_api_key)
    out.append(_item("claude", "Claude (AI editing and Ask Cue)", READY if claude else NOT_CONFIGURED,
                     f"API key present; model {s.claude_model}. Budget ${s.project_budget_usd:.2f} per project."
                     if claude else "No API key: Cue uses the simple built-in planner.",
                     fix="" if claude else "Add ANTHROPIC_API_KEY to .env and restart.", group="AI"))
    exposed = s.host not in ("127.0.0.1", "localhost", "::1") or bool(s.public_url)
    if s.password:
        out.append(_item("password", "Owner password", READY, "Sign-in is required for everything except client links.", group="Security"))
    else:
        out.append(_item("password", "Owner password", UNAVAILABLE if exposed else NOT_CONFIGURED,
                         "This computer is reachable from other devices without a password!" if exposed
                         else "Off. Fine while only this Mac can open the app.",
                         required=exposed, fix="Set CUTCUE_PASSWORD and CUTCUE_SECRET_KEY in .env.", group="Security"))
    out.append(_item("sharing", "Client links reach outside this Mac",
                     READY if s.public_url else NOT_CONFIGURED,
                     f"Review/upload links use {s.public_url}." if s.public_url else
                     "Links use this browser's address; clients on other networks can't open them.",
                     fix="" if s.public_url else "Set up a tunnel and CUTCUE_PUBLIC_URL (docs/cue2/setup.md).", group="Sharing"))
    em = cue.mailer.config if cue.mailer else None
    if em and em.configured:
        last = cue.db.one("SELECT status, error FROM email_outbox ORDER BY created_at DESC LIMIT 1")
        status = UNAVAILABLE if last and last["status"] == "failed" else READY
        out.append(_item("email", "Email notifications", status,
                         f"Sending to {em.to} via {em.host}." + (f" Last email failed: {last['error']}" if status == UNAVAILABLE else ""),
                         group="Notifications", can_test=True))
    else:
        out.append(_item("email", "Email notifications", NOT_CONFIGURED, "In-app notifications only.",
                         fix="Add CUE_SMTP_HOST, CUE_EMAIL_FROM, CUE_EMAIL_TO (and login) to .env.", group="Notifications"))
    rc = cue.relay.config if cue.relay else None
    if rc and rc.configured:
        probe = loads((cue.db.one("SELECT value_json FROM app_kv WHERE key = 'relay_probe'") or {}).get("value_json"), None)
        if probe and probe.get("ok"):
            status, detail = READY, f"Connected to {rc.url} ({rc.auth_mode}); checked {int((now() - probe['at']) // 60)} min ago."
        elif probe:
            status = AWAITING if probe.get("awaiting") else UNAVAILABLE
            detail = probe.get("error", "Last check failed.")
        else:
            status, detail = AWAITING, f"Configured for {rc.url}; press Test to check the connection."
        out.append(_item("relay", "Client portal (Menapoly Cue on Cloudflare)", status, detail, group="Delivery", can_test=True,
                         fix="" if status == READY else "Deploy the Relay security fix + connector, create the Access service "
                                                         "token and invite the connector account (docs/cue2/deployment.md)."))
    else:
        out.append(_item("relay", "Client portal (Menapoly Cue on Cloudflare)", NOT_CONFIGURED,
                         (rc.problem() if rc else None) or "Not connected.", group="Delivery",
                         fix="Needs the Relay branches deployed first (your approval), then CUE_RELAY_* in .env."))
    t = text.status()
    out.append(_item("text_in", "Cue Text: receiving texts", READY if t["inbound_ready"] else NOT_CONFIGURED,
                     f"Receiving at {t['number']}." if t["inbound_ready"] else "No SMS provider connected. The Settings simulator works.",
                     fix="" if t["inbound_ready"] else "Provider number + webhook secret (docs/cue2/cue-text.md).", group="Messaging"))
    out.append(_item("text_out", "Cue Text: sending texts", AWAITING,
                     "Disabled on purpose until a provider, number registration (A2P 10DLC / toll-free) and consent records "
                     "are in place and you approve.", group="Messaging"))
    out.append(_item("cloud", "Cloud processing", READY if s.cloud_configured else DISABLED,
                     "Configured; still opt-in per project." if s.cloud_configured else "Off. Everything runs on this computer.",
                     group="Processing"))
    root = s.data_dir.parent / "backups"
    backups = sorted(root.glob("cutcue-backup-*")) if root.is_dir() else []
    if backups:
        age_days = (time.time() - backups[-1].stat().st_mtime) / 86400
        out.append(_item("backups", "Backups", READY if age_days < 7 else NOT_CONFIGURED,
                         f"Last backup {backups[-1].name} ({age_days:.0f} days ago).",
                         fix="" if age_days < 7 else "Back up now (Settings) or make backup.", group="Data"))
    else:
        out.append(_item("backups", "Backups", NOT_CONFIGURED, "No backup yet. Make one before real client work.",
                         fix="Settings → Back up now, or make backup for media too.", group="Data"))
    return out


def probe_relay(cue) -> dict:
    """Live check: can the connector read its workspace? Stores the result (no secrets)."""
    import httpx

    from .relay import RelayError
    result: dict = {"at": now()}
    try:
        with cue.relay._client() as http:
            cue.relay._bundle(http)
        result["ok"] = True
    except RelayError as exc:
        result.update(ok=False, error=str(exc), awaiting="not a member" in str(exc) or "redirected" in str(exc) or "401" in str(exc))
    except httpx.HTTPError as exc:
        result.update(ok=False, error=f"Can't reach the client portal: {type(exc).__name__}")
    cue.db.execute("""INSERT INTO app_kv (key, value_json, updated_at) VALUES ('relay_probe', ?, ?)
                      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at""",
                   [dumps(result), now()])
    return result


def setup_state(cue) -> dict:
    row = cue.db.one("SELECT value_json FROM app_kv WHERE key = ?", [SETUP_KEY])
    return loads(row["value_json"], {}) if row else {}


def set_setup_state(cue, **values) -> dict:
    state = {**setup_state(cue), **values}
    cue.db.execute("""INSERT INTO app_kv (key, value_json, updated_at) VALUES (?, ?, ?)
                      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at""",
                   [SETUP_KEY, dumps(state), now()])
    return state
