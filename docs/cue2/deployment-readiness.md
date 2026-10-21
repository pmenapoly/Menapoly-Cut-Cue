# Deployment readiness checklist

Tick each box before the step that depends on it. ✅ = verified today (2026-10-14) by me; ☐ = yours to do or confirm. Secret *values* never appear in this document or in any tool output; only whether each one is set.

## 1. Accounts and secrets

| Item | For | Status today |
|---|---|---|
| Relay accounts, secrets and sign-in | Relay | tracked in the private MenapolyRelay repository |
| `CF_ACCESS_SERVICE_TOKENS` (a Worker secret, *not* a GitHub one) plus an Access service token | Cut Cue → portal connector | ☐ not created |
| `ANTHROPIC_API_KEY` in Cut Cue `.env` | Live Claude | ☐ not on your Mac yet |
| SMTP account (app password) → `CUE_SMTP_*`, `CUE_EMAIL_FROM`, `CUE_EMAIL_TO` | Email notifications | ☐ |
| `CUTCUE_PASSWORD`, `CUTCUE_SECRET_KEY` | If Cut Cue is reachable from other devices | ☐ |
| HTTPS tunnel + `CUTCUE_PUBLIC_URL` | Client review links from outside your Wi-Fi | ☐ |
| SMS provider, registered number, consent records | Sending texts | ☐ **intentionally not started** |

## 2. Security verification

- Relay: tracked in the private MenapolyRelay repository.
- Cue pilot: `docs/cloud/pilot/security-gate.md`.

## 3. Data backup

- ☐ **Cut Cue on the Mac:** `make backup` (database + media, checksummed). Settings → Back up now covers the database only.
- ✅ Restoring a Cut Cue backup into a fresh app gives identical projects and byte-identical renders (`test_backup.py`; harness step 16).

## 4. Deployment steps (each one needs your approval)

1. **Relay:** its security fix and deployment are tracked in the private MenapolyRelay repository.
2. **Connector (optional):**
   - PR `feature/cue-connector` → `main`, then merge;
   - create the Access service token and add a Service Auth policy;
   - `wrangler secret put CF_ACCESS_SERVICE_TOKENS`;
   - invite the connector email as Editor.
3. **Cut Cue on the Mac:**
   - `make backup` (if you have existing data);
   - `git checkout menapoly-cue-2.0 && make setup && make start`;
   - open `/setup/`.

## 5. Smoke tests

- **Relay:** tracked in the private MenapolyRelay repository.
- **Cut Cue:**
  - `/connections/` shows FFmpeg and Speech-to-text as Ready;
  - create a project, upload a recording, "Make a tight rough cut", Preview, Approve, Export → YouTube, play the MP4;
  - create a review link, open it on your phone, Request changes, and see the bell (and your email);
  - Delivery → Publish to client portal (if connected), then approve; the version appears in Relay.
- **Mac harness:** `make validate MEDIA=… LONG=… PHONE=1` (`mac-validation-checklist.md`).

## 6. Rollback

- **Relay:** tracked in the private MenapolyRelay repository.
- **Cut Cue:**
  - stop the app;
  - `git checkout <previous commit>`;
  - `make restore BACKUP=backups/<name>` (the current data is moved aside, not deleted).

## 7. Still unverified (as of this report)

| Capability | Why | How to verify |
|---|---|---|
| Real Cloudflare Access login, service tokens, `common_name` mapping | No Access application exists yet | after Relay's security work |
| Connector against live Relay | Relay branches not deployed | Delivery → Publish after step 3 |
| Intel Mac performance, real Whisper, Chrome H.264 playback, live Claude | Not run on your hardware | Mac harness |
| Real SMTP provider delivery | Tested only against a local SMTP server | Settings → Send a test email |
| Phone review link on a real phone | Simulated with a mobile user agent only | Harness step 15 (`PHONE=1`) |
| SMS | Sending deliberately not built | After provider + compliance + approval |
