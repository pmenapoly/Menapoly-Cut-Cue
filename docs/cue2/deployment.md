# Deployment instructions (nothing below has been done; each step needs your go-ahead)

> **Updated 2026-10-14:** start with `security-launch.md` (production status, containment, emergency patch) and
> `deployment-readiness.md` (checklist). The fastest safe fix for production is branch `hotfix/access-identity-minimal`
> (based on `main`, CI green).

## Branches

| Repository | Branch | Contents | Merge target | Effect of merging |
|---|---|---|---|---|
| `pmenapoly/MenapolyRelay` | `security/access-identity-headers` | Auth fix for forged identity headers; tests | `main` | **Auto-deploys to Cloudflare production** (GitHub Actions) |
| `pmenapoly/MenapolyRelay` | `feature/cue-connector` | Service-token identity; `add_project` returns `projectId` (built on the fix) | `main`, after the fix | Same auto-deploy |
| `pmenapoly/Menapoly-Cut-Cue` | `menapoly-cue-2.0` | Cue 2.0 app, connector, email, backups | your choice (runs locally) | No deploy; you run it on your Mac |

## A. Relay security fix (do this first; it closes a privilege escalation)

1. **Check the repository secrets.**
   - In GitHub → MenapolyRelay → Settings → Secrets → Actions, confirm `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` exist.
   - The workflow now **stops** if the two Access secrets are missing. That is intended.
2. **Check Cloudflare Access.** The Access application must cover the Worker hostname, with policies only for your team and client emails.
3. **Decide the ChatGPT Sites preview.** After this fix, a build deployed to ChatGPT Sites shows "access required" instead of trusting headers.
   - **Keep it working:** it needs a separate build without `CUE_AUTH_MODE` (ask me and I'll prepare one).
   - **Retire it:** nothing to do.
4. **Review.** Open a PR from `security/access-identity-headers` to `main`. CI runs lint, typecheck, tests and build.
5. **Merge (approval needed).** The workflow deploys and applies migrations. There are no schema changes in this fix.
6. **Verify in production** (5 minutes):
   - `GET https://<host>/api/health` → 200.
   - Sign in as a **client** account. In the browser dev tools, repeat an `/api/os` request with the extra header `oai-authenticated-user-email: <owner email>`. Your role must stay **client**: invite and brand actions return 403.
   - `curl https://<host>/api/os -H 'oai-authenticated-user-email: <owner email>'` without Access returns the Access login page or 401. It must never return workspace data.
7. **Roll back if needed:** revert the merge commit on `main` (it auto-deploys). The fix has no data migration to undo.

## B. Relay connector (optional; needed to publish from Cut Cue)

1. Merge `feature/cue-connector` after A, through a PR (approval needed).
2. **In Cloudflare Zero Trust:**
   - create a service token, `cutcue-connector`;
   - add a **Service Auth** policy that allows this token to the Access application.
3. **Map the token:** `npx wrangler secret put CF_ACCESS_SERVICE_TOKENS`, with the value `<Client ID>=cutcue-connector@<your domain>`.
4. **In Relay:** as owner, invite `cutcue-connector@<your domain>` to the client workspace as **Editor**. Note the workspace ID.
5. **In Cut Cue's `.env`:** set `CUE_RELAY_URL`, `CUE_RELAY_WORKSPACE_ID`, `CUE_RELAY_ACCESS_CLIENT_ID` and `CUE_RELAY_ACCESS_CLIENT_SECRET`, then restart.
6. **Check the connection:** Settings → Client portal shows "Connected". Then publish one render from a test project, approve it, and check the version in Relay.

## C. Cut Cue / Menapoly Cue 2.0 on your Mac (local; no deployment)

1. **Back up first.** If you have existing data: `cp -a data data.bak-$(date +%F)`.
2. **Install:** `git checkout menapoly-cue-2.0 && make setup && make start`. Migrations 5 and 6 apply automatically on first start.
3. **Email (optional):** set `CUE_SMTP_HOST`, `CUE_SMTP_PORT`, `CUE_SMTP_USER`, `CUE_SMTP_PASSWORD`, `CUE_SMTP_SECURITY` (`starttls`, `ssl` or `none`), `CUE_EMAIL_FROM` and `CUE_EMAIL_TO`. Then Settings → Send a test email.
   - Use an app password, not your main password (Gmail and iCloud both offer them).
4. **Run the checklist** in `mac-validation-checklist.md`.
5. **Back up regularly:** `make backup` (full), or Settings → Back up now (database only).
6. **Sharing outside your Wi-Fi:** set `CUTCUE_PASSWORD`, use an HTTPS tunnel, and set `CUTCUE_PUBLIC_URL` (see `setup.md`).

## D. SMS (Cue Text): stays receive-only

Sending stays disabled in code. Enabling it later requires all of the following, and then a new, reviewed sender implementation:

- a provider account and a dedicated number;
- A2P 10DLC or toll-free verification;
- documented opt-in consent;
- your approval.
