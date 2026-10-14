# Deployment readiness checklist

Tick each box before the step that depends on it. ✅ = verified today (2026-10-14) by me; ☐ = yours to do or confirm. Secret *values* never appear in this document or in any tool output; only whether each one is set.

## 1. Accounts and secrets

| Item | For | Status today |
|---|---|---|
| Cloudflare account with Workers, D1, R2 | Relay | ✅ API token + account ID are set as GitHub secrets |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (GitHub repo secrets) | Relay deploys | ✅ set |
| Cloudflare Zero Trust (Access) application for the production hostname | Relay sign-in | ☐ not confirmed |
| `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN` (GitHub repo secrets) | Relay sign-in | ☐ **missing**; the patched workflow won't deploy without them |
| `CF_ACCESS_AUD_PREVIEW` | Optional Access-protected preview | ☐ missing |
| `CF_ACCESS_SERVICE_TOKENS` (a Worker secret, *not* a GitHub one) plus an Access service token | Cut Cue → portal connector | ☐ not created |
| `ANTHROPIC_API_KEY` in Cut Cue `.env` | Live Claude | ☐ not on your Mac yet |
| SMTP account (app password) → `CUE_SMTP_*`, `CUE_EMAIL_FROM`, `CUE_EMAIL_TO` | Email notifications | ☐ |
| `CUTCUE_PASSWORD`, `CUTCUE_SECRET_KEY` | If Cut Cue is reachable from other devices | ☐ |
| HTTPS tunnel + `CUTCUE_PUBLIC_URL` | Client review links from outside your Wi-Fi | ☐ |
| SMS provider, registered number, consent records | Sending texts | ☐ **intentionally not started** |

## 2. Security verification

- ✅ The vulnerability was reproduced in tests. The fix makes all 10 auth tests pass, and 4 of them fail on the old code.
- ✅ GitHub CI (lint, typecheck, unit tests, build, Wrangler dry run with the production `wrangler.jsonc`) passed on:
  - `security/access-identity-headers`;
  - `hotfix/access-identity-minimal` (based on `main`);
  - `feature/cue-connector`.
- ✅ The production configuration declares `CUE_AUTH_MODE=cloudflare-access`; the dry run shows the binding.
- ✅ No CI deployment of the production Worker has ever succeeded.
- ☐ Check the Cloudflare dashboard for any manually deployed `menapoly-cue-production` / `menapoly-cue-preview` Worker.
- ☐ Run the safe probe (`security-launch.md` §1) against any live URL, including the ChatGPT Sites preview.
- ☐ **Containment now:** disable the "Deploy Menapoly Cue to Cloudflare" workflow until you merge the fix.
- ☐ Access policy: only your team's and your clients' emails.

## 3. Data backup

- ☐ **Relay:** if production D1 exists, export it first: `npx wrangler d1 export menapoly-cue-production --remote --output backup-$(date +%F).sql`. R2 objects are not changed by this fix.
- ☐ **Cut Cue on the Mac:** `make backup` (database + media, checksummed). Settings → Back up now covers the database only.
- ✅ Restoring a Cut Cue backup into a fresh app gives identical projects and byte-identical renders (`test_backup.py`; harness step 16).

## 4. Deployment steps (each one needs your approval)

1. **Relay hotfix:**
   - add the Access secrets;
   - re-enable the deploy workflow;
   - PR `hotfix/access-identity-minimal` → `main`;
   - **merge**, which auto-deploys.
2. **Relay full branch:** PR `security/access-identity-headers` → `main` (adds the test suite and the same auth code), then merge.
3. **Connector (optional):**
   - PR `feature/cue-connector` → `main`, then merge;
   - create the Access service token and add a Service Auth policy;
   - `wrangler secret put CF_ACCESS_SERVICE_TOKENS`;
   - invite the connector email as Editor.
4. **Cut Cue on the Mac:**
   - `make backup` (if you have existing data);
   - `git checkout menapoly-cue-2.0 && make setup && make start`;
   - open `/setup/`.

## 5. Smoke tests

- **Relay:** `security-launch.md` §7. The key checks: health, owner sign-in, an anonymous probe gets the login page or 401, and a client with a forged owner header gets 403.
- **Cut Cue:**
  - `/connections/` shows FFmpeg and Speech-to-text as Ready;
  - create a project, upload a recording, "Make a tight rough cut", Preview, Approve, Export → YouTube, play the MP4;
  - create a review link, open it on your phone, Request changes, and see the bell (and your email);
  - Delivery → Publish to client portal (if connected), then approve; the version appears in Relay.
- **Mac harness:** `make validate MEDIA=… LONG=… PHONE=1` (`mac-validation-checklist.md`).

## 6. Rollback

- **Relay:** revert the merge commit on `main` (auto-deploys), or use Cloudflare → Deployments → Rollback. There is no schema change in the fix. Rolling back re-opens the vulnerability, so pair it with containment.
- **Cut Cue:**
  - stop the app;
  - `git checkout <previous commit>`;
  - `make restore BACKUP=backups/<name>` (the current data is moved aside, not deleted).

## 7. Still unverified (as of this report)

| Capability | Why | How to verify |
|---|---|---|
| Whether anything is live on Cloudflare or ChatGPT Sites | No dashboard access, no URL | Dashboard + the safe probe |
| Real Cloudflare Access login, service tokens, `common_name` mapping | No Access application exists yet | §5 Relay smoke tests |
| Connector against live Relay | Relay branches not deployed | Delivery → Publish after step 3 |
| Intel Mac performance, real Whisper, Chrome H.264 playback, live Claude | Not run on your hardware | Mac harness |
| Real SMTP provider delivery | Tested only against a local SMTP server | Settings → Send a test email |
| Phone review link on a real phone | Simulated with a mobile user agent only | Harness step 15 (`PHONE=1`) |
| SMS | Sending deliberately not built | After provider + compliance + approval |
