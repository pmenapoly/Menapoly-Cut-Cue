# Accounts and secrets

Names only. **No values are stored in the repository**; never paste them into chats, issues or commits.

## Accounts

| Account | Purpose | Status |
|---|---|---|
| Cloudflare (existing account used by MenapolyRelay) | Workers, D1, R2, Queues, Access | Exists. GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set for Relay. |
| Workers Paid plan | Queues + cron | **Not confirmed**; needs your purchase approval |
| Cloudflare Zero Trust (Free) | Access login for you and editors | Team domain exists only if Relay's Access was set up. Relay's `CF_ACCESS_*` secrets are still missing. |
| A hostname (e.g. `cue.<your-domain>`) on Cloudflare | App URL behind Access | Your choice |

## Cloudflare resources to create (by you, after approval)

| Resource | Name in config | Notes |
|---|---|---|
| D1 database | `menapoly-cue-cloud` | put its `database_id` into `wrangler.jsonc` |
| R2 bucket | `menapoly-cue-media` | private; **don't** enable public access or r2.dev; add the CORS rule from setup.md |
| R2 API token | — | Object Read & Write, **this bucket only** |
| Queue + DLQ | `menapoly-cue-events`, `menapoly-cue-events-dlq` | |
| Access application | the app hostname | policy: allow your email(s) |
| Access app for `/v1/worker` | Service Auth policy with the service token `menapoly-mac` | the Mac's way in; no Bypass anywhere in the pilot |
| Access bypass paths | none in the pilot | only if client review links are turned on later: `/review.html`, `/review.js`, `/styles.css`, `/icon.svg`, `/v1/public/*` |

## Worker secrets (`wrangler secret put NAME`)

| Name | What |
|---|---|
| `CF_ACCESS_AUD` | Access application audience tag |
| `CF_ACCESS_TEAM_DOMAIN` | e.g. `yourteam.cloudflareaccess.com` |
| `OWNER_EMAILS` | your email (comma-separated list) |
| `EDITOR_EMAILS` | optional |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the R2 API token's S3 credentials |
| `EMAIL_FROM`, `EMAIL_TO` | optional, with a `send_email` binding named `EMAIL` |

Never set `DEV_OWNER_EMAIL` in production. It is ignored there anyway: the dev identity needs `ENVIRONMENT=development`
**and** a localhost URL.

## On the Mac (`.env`, chmod 600)

`CUE_CLOUD_URL`, `CUE_WORKER_TOKEN` (shown once on Settings → Mac workers), `CUE_ACCESS_CLIENT_ID` /
`CUE_ACCESS_CLIENT_SECRET` (the Access service token; required in the pilot). The token is never printed by the agent; revoke it from Settings if the Mac is lost.

## Not needed

No SMS provider (Cue Text stays disabled; no messages are sent). No paid AI key for the cloud path. No router changes.
