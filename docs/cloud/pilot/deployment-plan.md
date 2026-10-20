# Private pilot deployment plan: cue.menapoly-digital.com

Prepared, not executed. Every step that changes your Cloudflare account maps to a line in
[APPROVAL-CHECKLIST.md](APPROVAL-CHECKLIST.md). Commands run on your Mac from the repository root.

## What the pilot is

- One hostname, `cue.menapoly-digital.com`, served by the Worker `menapoly-cue-cloud` (app + `/v1` API).
- Cloudflare Access in front of the **whole** host: you sign in with your email; the Mac uses a service token on
  `/v1/worker/*`. **No public paths:** client review links are off (`PUBLIC_REVIEW=disabled`, no Bypass policies),
  SMS stays off, cloud processing stays off (`CLOUD_RENDERING=disabled`).
- No `*.workers.dev` URL, no preview URLs (`workers_dev: false`, `preview_urls: false`).
- Media in a private R2 bucket (no r2.dev URL, no public domain). Browser and Mac move bytes with 10–15-minute
  signed URLs; the bucket's CORS rule allows only `https://cue.menapoly-digital.com`.

## Step 0: confirm domain ownership and DNS access (you; read-only; ~5 minutes)

This sandbox can't look up DNS or reach Cloudflare's API, so this check is yours.

1. Cloudflare dashboard → **Websites**: `menapoly-digital.com` is listed as **Active** in the account you'll deploy
   from. If it shows *Pending nameserver update*, or isn't there, the pilot can't use this hostname yet. Point the
   domain's nameservers (at your registrar) to the two Cloudflare nameservers shown.
2. **DNS → Records**: there is **no** existing record named `cue`. The Worker creates it on deploy, and an existing
   record would conflict.
3. Create a **read-only** API token for the preflight (My Profile → API Tokens → Create Custom Token):
   Zone · Zone · Read; Zone · DNS · Read; Account · Access: Apps and Policies · Read;
   Account · Access: Organizations, Identity Providers, and Groups · Read. Restrict it to this account and zone.
   This token can't change anything.
4. Sign in Wrangler once: `cd cloud/control-plane && npx wrangler login` (browser), then `npx wrangler whoami` shows
   the account.
5. Run the preflight:

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=…                     # 32 hex characters (not secret)
   read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # paste the read-only token; hidden, not in shell history
   backend/.venv/bin/python cloud/control-plane/pilot/preflight.py --stage before-provision
   ```

   Expected now: zone active and in this account, no `cue` record, Relay workflows OK (S1 done 2026-10-20), Access
   and resources "NOT YET".

## Step 1: Cloudflare Access (dashboard; free; checklist PROD-1)

Zero Trust → Settings → choose a team name (this is `CF_ACCESS_TEAM_DOMAIN`, e.g. `menapoly.cloudflareaccess.com`;
the Free plan covers up to 50 users). Login method: **One-time PIN** (email code) is enough; add Google later if you like.

1. **Service token** (Access → Service Auth → Create): name `menapoly-mac`, duration 1 year. Copy the Client ID and
   Client Secret straight into the Mac's `.env` (`CUE_ACCESS_CLIENT_ID`, `CUE_ACCESS_CLIENT_SECRET`). They're shown once.
2. **App "Menapoly Cue – Mac worker"**: Applications → Add → Self-hosted → domain `cue.menapoly-digital.com`,
   path `v1/worker`. Policy: action **Service Auth**, include **Service Token = menapoly-mac**. Nothing else.
3. **App "Menapoly Cue"**: Self-hosted → domain `cue.menapoly-digital.com` (no path). Session duration **24 hours**.
   Policy: action **Allow**, include **Emails = your address**. No Bypass, no "Everyone".
   Copy this app's **Application Audience (AUD) Tag** (it becomes the `CF_ACCESS_AUD` secret).
4. Access apps can be created before the hostname exists. Creating them first means the first request to the new
   hostname already meets Access.

## Step 2: resources (checklist PROD-2)

```sh
cloud/control-plane/pilot/provision.sh resources            # shows the commands
cloud/control-plane/pilot/provision.sh resources --execute  # runs them after a typed confirmation
```

It creates the D1 database `menapoly-cue-cloud` and the R2 bucket `menapoly-cue-media`. It turns the r2.dev public
URL off, sets the CORS rule from `pilot/r2-cors.json`, and adds a lifecycle rule that aborts unfinished multipart
uploads after 2 days. It also creates the queues `menapoly-cue-events` and `menapoly-cue-events-dlq`. Then:

- Paste the printed `database_id` into `cloud/control-plane/wrangler.jsonc` → `d1_databases[0]`.
- `cd cloud/control-plane && npx wrangler d1 migrations apply DB --remote` (creates the empty tables; prints them).
- R2 → **Manage API tokens** → Create: permission **Object Read & Write**, **apply to bucket `menapoly-cue-media`
  only**, no expiry or 1 year. Keep the Access Key ID and Secret for the deploy prompt. The endpoint is
  `https://<account-id>.r2.cloudflarestorage.com` (`S3_ENDPOINT`).
- Re-run the preflight with `--stage before-deploy`: everything must be OK, with no PROBLEM lines.

Location: leave the default (Cloudflare places D1 and R2 near where they're created). Data stays in your account.

## Step 3: deploy (checklist PROD-3; only after S1, PROD-1 and PROD-2)

```sh
cloud/control-plane/pilot/provision.sh deploy --execute
```

In order:

1. The preflight runs. Any PROBLEM, such as an active Relay deploy workflow, a missing Access app or a public policy,
   stops it.
2. Typecheck and unit tests run (they include the config guard).
3. It asks for the six secrets, input hidden, and writes them to a temporary file with mode 600.
4. `wrangler deploy --secrets-file` publishes the first version **with** its Access settings, and Cloudflare creates the
   `cue` DNS record and certificate for the custom domain.
5. The temporary file is deleted.
6. The after-deploy preflight requests `/`, `/v1/health`, `/v1/projects`, `/v1/worker/lease`, `/review.html` and a
   review-token URL without signing in. Each must be redirected to Access or refused. If any answers, the script tells
   you to follow [rollback](../rollback.md) immediately.

Expected right after: opening `https://cue.menapoly-digital.com` on any device shows the Cloudflare Access login.
After entering your email and the emailed code you see the empty Projects page with **Mac offline** (until step 4).

## Step 4: the Mac worker ([mac-worker.md](mac-worker.md))

In the app: Settings → Mac workers → **Create worker token**. Then set up the Mac, and `make agent-check` must say OK.

## Step 5: phone ([android.md](android.md)) and acceptance ([acceptance-test.md](acceptance-test.md))

## Rolling back

See [../rollback.md](../rollback.md). The fastest stop is Zero Trust → the "Menapoly Cue" app → set the policy to
**Block**, or `npx wrangler delete menapoly-cue-cloud`, which removes the Worker and its route. D1 and R2 keep their
data until you delete them.
