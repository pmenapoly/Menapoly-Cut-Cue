# Setup

## 1. Try it locally (no Cloudflare account touched)

```sh
make setup            # once: Python venv + frontend
make cloud-setup      # once: Wrangler/TypeScript for cloud/control-plane
make cloud-check      # typecheck + unit tests + Wrangler dry-run build (deploys nothing)
make cloud-dev        # local control plane on http://localhost:8787 with a local S3 stand-in
```

`make cloud-dev` writes `data/cloud-dev.json` (mode 600) with a freshly registered local worker token and the matching
agent environment. In a second terminal run the agent against it:

```sh
cd backend
env $(python3 -c 'import json;print(" ".join(f"{k}={v}" for k,v in json.load(open("../data/cloud-dev.json"))["agent_env"].items()))') \
  .venv/bin/python -m cutcue.agent
```

Open http://localhost:8787 (local development mode signs you in as `owner@example.test`). On a phone on the same Wi-Fi
the dev identity is refused by design; that's what the deployed version with Access is for.

Tests: `make test` (includes `tests/test_cloud_e2e.py`), `make cloud-ui-test` (phone-size browser tests).

## 2. Mac worker (after a deployment exists)

1. Cloud app → Settings → Mac workers → **Create worker token**. Copy it once.
2. In the repo's `.env` on the Mac: `CUE_CLOUD_URL=https://cue.<your-domain>` and `CUE_WORKER_TOKEN=…`;
   `chmod 600 .env`.
3. `make agent-check`. It should print `OK: connected … as a registered worker`.
4. `make agent-install` installs `~/Library/LaunchAgents/com.menapoly.cue.agent.plist` (starts at login, restarts if it
   crashes, low CPU/IO priority). Logs: `~/Library/Logs/MenapolyCue/agent.log`.
   Remove with `scripts/install_agent_launchd.sh --remove`.
5. Keep the Mac awake while jobs run (System Settings → Energy → prevent sleep when the display is off, or run
   `caffeinate -s` while working). If it sleeps, the lease expires and the job waits for it to come back.

Whisper, model size, CPU threads and video encoder come from the normal `CUTCUE_*` settings
(`h264_videotoolbox` is used automatically for final renders when available; CPU `libx264` otherwise).

## 3. Deploy the control plane (needs your explicit approval; not done)

Each command below creates or changes something in your Cloudflare account. Run them only after you approve.

```sh
cd cloud/control-plane
npx wrangler login
npx wrangler d1 create menapoly-cue-cloud            # put the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create menapoly-cue-media
npx wrangler queues create menapoly-cue-events
npx wrangler queues create menapoly-cue-events-dlq
npx wrangler r2 bucket cors set menapoly-cue-media --file r2-cors.json   # see below
npx wrangler d1 migrations apply DB --remote
for s in CF_ACCESS_AUD CF_ACCESS_TEAM_DOMAIN OWNER_EMAILS S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  npx wrangler secret put $s; done
```

`r2-cors.json` (replace the origin):

```json
{ "rules": [ { "allowed": { "origins": ["https://cue.<your-domain>"], "methods": ["GET", "PUT", "HEAD"],
  "headers": ["content-type"] }, "maxAgeSeconds": 3600 } ] }
```

Then in Zero Trust → Access → Applications: add a self-hosted app for `cue.<your-domain>` allowing your email, plus a
**Bypass** policy (or separate app) for `/review.html`, `/review.js`, `/styles.css`, `/icon.svg`, `/v1/public/*` and
`/v1/worker/*`. Those routes do their own token checks.

Add a custom domain route for `cue.<your-domain>` to the Worker (it has `workers_dev: false`, so there's no public
`*.workers.dev` URL), then deploy: `npx wrangler deploy`. Verify:

- `curl https://cue.<your-domain>/v1/projects` without a session → Access login page (never JSON data).
- `curl https://cue.<your-domain>/v1/health` → `{"ok":true,…,"environment":"production"}`.
- Sign in on the phone, then *Add to Home Screen*.
- `make agent-check` on the Mac, then one real job from the phone. After that run
  `make validate MEDIA=…`; step 20 checks the live connection.
