# Menapoly Cue private pilot: final approval checklist

Pilot: `https://cue.menapoly-digital.com`, for you only (Cloudflare Access), with your Intel Mac doing the work.
Status on 2026-10-19: **everything prepared and tested locally; nothing purchased, merged, created or deployed.**

How to approve: reply with the item codes, e.g. *"I approve S1, PAID-1 (Workers Paid), PROD-1 … PROD-4"*. Each
item is independent. Paid services and production changes are approved separately. Nothing below happens without
your explicit approval of that line.

Who runs what: this cloud sandbox can't reach Cloudflare (its network policy blocks it) and holds none of your
credentials, so Cloudflare steps run **on your Mac** with the prepared scripts. Each script prints its commands first
and asks for a typed confirmation before changing anything.

---

## Part 1: Security gate (production change to the Relay repository, free). Must be done first.

| ✔ | Code | Change | How (exact) | Undo |
|---|---|---|---|---|
| ☐ | **S1** | Disable Relay's two deploy workflows: "Deploy Menapoly Cue to Cloudflare" and "Deploy Preview (menapoly-cue-preview)". No code changes; CI checks stay on. | GitHub → MenapolyRelay → Actions → each workflow → **⋯ → Disable workflow** ([details](security-gate.md#1-prepared-disable-the-unsafe-relay-deployment-workflows)) | **⋯ → Enable workflow** |

**Gate resolved when:** `preflight.py` shows both workflows as `disabled_manually`. The deploy script refuses to
run until then.

Not part of the pilot (separate decision, later):

- ☐ **R1**: merge `hotfix/access-identity-minimal` into Relay `main` and deploy Relay. Prerequisites: Relay's own
  Access app and the GitHub secrets `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN`, then re-enable its main deploy
  workflow. Verified safe to deploy ([§3](security-gate.md#3-can-the-relay-hotfix-be-deployed-without-exposing-the-application)),
  but not needed for the pilot.

---

## Part 2: Your checks (read-only, no approval needed, ~10 min)

| ✔ | Code | Check | Expected |
|---|---|---|---|
| ☐ | **C1** | Cloudflare → Websites: `menapoly-digital.com` is **Active** in the account you'll use | Active (not "Pending") |
| ☐ | **C2** | DNS → Records: no record named `cue` | none |
| ☐ | **C3** | Create the read-only API token ([permissions](deployment-plan.md#step-0-confirm-domain-ownership-and-dns-access-you-read-only-5-minutes)) and run `preflight.py --stage before-provision` | zone OK, `cue` free; Access and resources "NOT YET"; the only PROBLEM lines are the Relay workflows until S1 |

If C1 fails, the pilot hostname can't be used yet (domain not on Cloudflare or in another account). Tell me and I'll
adjust the plan.

---

## Part 3: Paid services (separate approval)

| ✔ | Code | Service | Exact charge | Notes |
|---|---|---|---|---|
| ☐ | **PAID-1** | **Workers Paid plan** (recommended) | **$5.00 per month** per account, plus tax; includes 10M requests and 30M CPU-ms | Covers the Worker, D1 and Queues for the pilot at $0 extra. Alternative: stay on Workers Free ($0); works within its 10 ms CPU per request limit, which hasn't been measured on Cloudflare ([options](charges.md#option-do-you-need-workers-paid-for-the-pilot)). |
| ☐ | **PAID-2** | **R2 usage billing** (enabling R2 requires a payment method on the account) | **$0.00 up to 10 GB stored**; then **$0.015 per GB-month** (50 GB = $0.60/mo; 100 GB = $1.35/mo). No egress fees. | Grows only with footage you keep. |
| ☐ | **PAID-3** | Billing notification at $10 | free | recommended safeguard |

**Expected pilot bill:** **$5.00–$5.60 per month** with Workers Paid and ≤ 50 GB of footage (or $0.00–$0.60 on
Free). Everything else (Access for up to 50 users, D1, Queues, DNS, certificate, downloads) is $0.
[Full breakdown](charges.md).

---

## Part 4: Production changes for the pilot (separate approval; requires S1)

| ✔ | Code | Change | Exact command / place | Undo |
|---|---|---|---|---|
| ☐ | **PROD-1** | Cloudflare Access: Zero Trust team (Free), service token `menapoly-mac`, app **"Menapoly Cue – Mac worker"** (`/v1/worker`, Service Auth only), app **"Menapoly Cue"** (whole host, Allow → your email only, 24 h sessions). No Bypass anywhere. | Zero Trust dashboard ([step 1](deployment-plan.md#step-1-cloudflare-access-dashboard-free-checklist-prod-1)) | delete the apps/token |
| ☐ | **PROD-2** | Create pilot resources: D1 `menapoly-cue-cloud` (+ schema), private R2 bucket `menapoly-cue-media` (r2.dev off, CORS only for the pilot origin, unfinished uploads aborted after 2 days), queues `menapoly-cue-events`, `…-dlq`; R2 API token limited to that bucket | `cloud/control-plane/pilot/provision.sh resources --execute` (asks: *I approve creating the pilot resources*), then the 3 manual lines it prints ([step 2](deployment-plan.md#step-2-resources-checklist-prod-2)) | `wrangler d1 delete`, `wrangler r2 bucket delete`, `wrangler queues delete` |
| ☐ | **PROD-3** | **Deploy** Worker `menapoly-cue-cloud` to `cue.menapoly-digital.com` (creates the DNS record + certificate). First version already has the Access settings. Then the automatic after-deploy probe. | `cloud/control-plane/pilot/provision.sh deploy --execute` (asks: *I approve deploying the Menapoly Cue pilot*) ([step 3](deployment-plan.md#step-3-deploy-checklist-prod-3-only-after-s1-prod-1-and-prod-2)) | `npx wrangler delete menapoly-cue-cloud`, or Access policy → Block ([rollback](../rollback.md)) |
| ☐ | **PROD-4** | Register and install the Intel Mac worker (worker token in the app; `.env`; launchd login service) | `make agent-check && make agent-install` ([guide](mac-worker.md)) | `scripts/install_agent_launchd.sh --remove`; remove the worker in the app |
| ☐ | **PROD-5** | Run the first-project acceptance test with a real video (creates one project and stores the video and its export in R2) | `scripts/pilot_acceptance.py --url https://cue.menapoly-digital.com --video … --phone` ([test](acceptance-test.md)) | delete the project's files (not built yet: delete via the R2 dashboard) |
| ☐ | **PROD-6** | Install the app on your Android phone | [android.md](android.md) | uninstall |

**Pilot accepted** when PROD-5 reports steps 1–10 VERIFIED and step 11 confirmed on your phone.

---

## Part 5: Stays off (not requested, not approved)

| Thing | How it's kept off |
|---|---|
| Client review links / any public access | `PUBLIC_REVIEW=disabled` (the Worker refuses to create links and refuses old ones); no Access Bypass; preflight flags any public policy; config test fails if changed |
| Cloud rendering / paid processing | `CLOUD_RENDERING=disabled`; cloud jobs can't be created; config test fails if changed |
| SMS (Cue Text) | no provider connected; nothing sends |
| Relay connector | `relay.py` stays unconfigured; pilot and Relay share no Worker, database or bucket |
| `*.workers.dev` and preview URLs | `workers_dev: false`, `preview_urls: false`; config test fails if changed |
| Relay hotfix merge/deploy | R1, separate |

---

## Evidence (all local; nothing here used your Cloudflare account)

- Relay hotfix: typecheck, lint, build test, 10/10 identity tests, Wrangler dry-run, re-run 2026-10-19.
- Pilot control plane: 9 unit tests (Access JWT, streaming SHA-256, config guard), Wrangler dry-run with the
  custom-domain route, cloud end-to-end tests including "client links off by default", and the acceptance script
  passing end to end on the local stack (`test_pilot_acceptance.py`).
- Unverified until the real run: domain/DNS (C1–C3), Access on your account, R2 CORS and download headers, the Mac's
  real speed, the Android install.
