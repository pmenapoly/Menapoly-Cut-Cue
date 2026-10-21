# Deployment instructions (nothing below has been done; each step needs your go-ahead)

## Branches

| Repository | Branch | Contents | Merge target | Effect of merging |
|---|---|---|---|---|
| `pmenapoly/MenapolyRelay` | `feature/cue-connector` | Connector support (service-token identity; `add_project` returns `projectId`) | `main`, after Relay's own security work | Relay's deploy workflows are disabled |
| `pmenapoly/Menapoly-Cut-Cue` | `menapoly-cue-2.0` | Cue 2.0 app, connector, email, backups | your choice (runs locally) | No deploy; you run it on your Mac |

## A. Relay security work

Relay's own security fixes and their rollout are tracked in the private MenapolyRelay repository, not in this public one.

## B. Relay connector (optional; needed to publish from Cut Cue)

1. Merge `feature/cue-connector` after Relay's security work is deployed, through a PR (approval needed).
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
