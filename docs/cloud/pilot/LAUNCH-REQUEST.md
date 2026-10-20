# Menapoly Cue private pilot: launch request (GH-A path, Workers Free)

Target: `https://cue.menapoly-digital.com`, for you only, behind Cloudflare Access. The Mac worker can be added later
([browser-first.md §6](browser-first.md#6-adding-mac-rendering-after-the-browser-pilot-is-running)).
Prepared 2026-10-20. **Nothing has been deployed, created, purchased or changed** in GitHub settings, Cloudflare or DNS.

## What was verified before writing this

| Item | Finding | Status |
|---|---|---|
| Browser tests | 30/30 passed: 10 flows × Android Chrome 375 px, Android Chrome 430 px, desktop Chrome 1440 px (automated, local stack) | ✅ |
| Backend + cloud end-to-end | 121 passed, 1 skipped; control plane 9/9; pilot workflow and preflight tests 16/16 | ✅ |
| Repository visibility | **Public** (`pmenapoly/Menapoly-Cut-Cue`). Environments with required reviewers and branch rules are therefore available on GitHub Free. No secret values or personal email are committed. | ✅ (see note 1) |
| Manual-only workflow | `pilot.yml` has `workflow_dispatch` only (no push, pull-request or schedule triggers); actionlint clean; actions pinned to commit SHAs | ✅ |
| Branch restriction | Checked three times: gate job (`refs/heads/menapoly-cue-2.0`), again inside the protected job, and the environment's branch rule (GH-2) | ✅ |
| Approval gate | Protected job uses environment `menapoly-cue-pilot`; all Cloudflare credentials live only there. **New:** both jobs refuse to run if the repository is ever made private, because GitHub then silently ignores environment approvals | ✅ fixed |
| Typed phrase | Required per action (check / provision / deploy / rollback) | ✅ |
| Access checks (fail closed) | Preflight requires both Access apps, no Bypass, no Everyone, no IP rules, Service Auth only on `/v1/worker`, AUD and team domain equal to the secrets; after deploy, 6 unauthenticated probes must be redirected to sign-in or refused, otherwise the Worker is deleted automatically | ✅ |
| **Bug: deploy could never succeed** | The preflight compared the D1 id with the committed `wrangler.jsonc`, which deliberately has none. Every deploy would have failed, and the after-deploy step would have removed the Worker. It now compares the `D1_DATABASE_ID` secret. Regression test added. | ✅ fixed |
| **Bug: Workers Free queues** | Wrangler's default queue retention (4 days) is above the Free limit (24 h), so creating the queues could fail on Workers Free. Provisioning now asks for 24 h. | ✅ fixed |
| First check before Access | It would have shown a PROBLEM for the not-yet-created Access team. It now shows NOT YET. Later stages still fail closed on anything NOT YET | ✅ fixed |
| Re-running provision | A provision run that stopped half-way couldn't be retried (existing resources were reported as problems). They're now reported as reused | ✅ fixed |
| Rollback | `rollback` deletes the Worker. D1 and R2 data are kept. Cloudflare's docs don't say whether the `cue` DNS record is deleted with the Worker. If it's left, it points at a Worker that no longer exists, so nothing is served; delete it in DNS → Records | ⚠ manual check after a rollback |
| Workers Free fit | Static assets, D1, cron (1 trigger), Queues (10,000 operations/day, since Feb 2026), Workers Logs: all on Free. Unmeasured: the **10 ms CPU limit per request** | ⚠ watch for error 1102 |

Note 1: because the repository is public, anyone can read the code and these docs (not your data, credentials or
videos). Only you can run its workflows. Keeping it public is what makes the free approval gate possible. If you make it
private later, the workflow refuses to run.

---

## 1. Read-only checks you can run now (no approval needed, nothing changes)

| Code | Check | Where | Expected |
|---|---|---|---|
| **C1** | `menapoly-digital.com` is Active | Cloudflare → Account home → Domains | **Active** |
| **C2** | No DNS record named `cue` | the domain → DNS → Records → search `cue` | none |
| **C4** | Workers plan | Workers & Pages → Plans | **Free** (leave it) |
| **C5** | Is a payment method already on file? Is R2 already enabled? | Manage Account → Billing; sidebar → R2 | just note what you see |
| **C6** | Relay deploy workflows still disabled | github.com/pmenapoly/menapolyrelay → Actions | both show *Disabled* |
| **C7** | GitHub Actions spending limit | github.com → your avatar → Settings → Billing and licensing | $0 limit / no payment method needed (public repos use standard runners for free) |

## 2. GitHub changes that need your approval (free)

| Code | Change |
|---|---|
| **GH-A** | Add `.github/workflows/pilot.yml` to the default branch `ccr-f6eeb6a3-yozzh0` (web editor). The default branch itself is **not** changed |
| **GH-2** | Create environment `menapoly-cue-pilot`: required reviewer = you, *Prevent self-review* off, deployment branch = `menapoly-cue-2.0` only; secrets go here only (never repository secrets) |
| **GH-3** | Branch rule on `menapoly-cue-2.0`: block deletion and force pushes (recommended) |
| **GH-4** | Fine-grained token `RELAY_ACTIONS_TOKEN`: MenapolyRelay only, Actions read-only, 90 days → environment secret |

## 3. Cloudflare and DNS changes that need your approval

| Code | Change | Charges? |
|---|---|---|
| **C3-P** | Create a Cloudflare API token for the workflow (permissions in [phone-only.md §4 B4](phone-only.md#step-b-cloudflare-account-checks-c1c3-read-only)); then run **check** (read-only) | no |
| **PROD-1** | Zero Trust team (Free plan, ≤ 50 users), service token `menapoly-mac`, two Access apps (people: your email only; worker path: Service Auth only) | no (see §4) |
| **PROD-2** | Run **provision**: D1 `menapoly-cue-cloud`, private R2 bucket `menapoly-cue-media` (no public URL, CORS for the pilot only), two queues (24 h retention); then an R2 API token for that one bucket | needs R2 enabled (§4) |
| **PROD-3** | Run **deploy**: Worker `menapoly-cue-cloud`, creates the **`cue.menapoly-digital.com` DNS record** and certificate; automatic probe and auto-removal | no |

## 4. Anything that could create charges

| Code | What | When money could move | Recommendation |
|---|---|---|---|
| **PAID-2** | **Enable R2.** Cloudflare requires a payment method to turn R2 on, even for the free allowance | only above 10 GB stored ($0.015/GB-month), 1M writes or 10M reads per month | approve; R2 is required to store videos |
| **PAID-0** | Zero Trust Free *may* ask for a payment method at sign-up (Cloudflare's docs don't say either way) | only if you ever go above 50 users | approve only if asked |
| **PAID-3** | Billing notification (free) | — | recommended |
| PAID-1 | Workers Paid ($5/month) | **not requested**. Only if Workers Free hits its CPU limit (error 1102) | stay on Free |
| — | GitHub | never on this path: public repository, no paid features | — |

**Expected monthly cost: $0.00** while footage stays under 10 GB (50 GB ≈ $0.60).

---

## Your next safe action: C1 and C2 in Chrome on your iMac (about 3 minutes, read-only)

1. Open **Chrome** and go to **dash.cloudflare.com**. Sign in with the Cloudflare account you use for
   `menapoly-digital.com`.
2. If several accounts are listed, click the one that holds `menapoly-digital.com`.
3. On the account home page, find **Domains** (it may be labelled *Websites*). Look at `menapoly-digital.com`:
   - **Active** (green) → C1 passed.
   - *Pending*, *Moved* or not listed → stop, tell me what you see, and change nothing.
4. Click **menapoly-digital.com**. In the left sidebar click **DNS → Records**.
5. Type `cue` in the search box above the record list.
   - **No results** → C2 passed.
   - A record appears → stop and tell me its *Type* and *Content*. Don't edit or delete it.
6. Optional, C4: back at the account home, left sidebar **Compute (Workers) → Workers & Pages**, then **Plans**
   (or *Overview → plan*). Note whether it says **Free**. Don't click Upgrade.
7. Optional, C5: top right, the person icon → **Billing**. Note whether a payment method is listed. Don't add one yet.
8. Close the tab. Nothing was changed.

Send me the results (for example "C1 Active, C2 no record, C4 Free, C5 no card"). I'll then give the click-by-click
for the approved steps, in this order: **GH-A → GH-2/3/4 → C3-P check → PROD-1 → PAID-2 + PROD-2 → PROD-3**.

---

## The approval request

Reply with this text (edit anything you don't want to approve):

> I approve launching the Menapoly Cue private pilot at cue.menapoly-digital.com on Workers Free:
> **GH-A** (add only `.github/workflows/pilot.yml` to the default branch; the default branch stays as it is),
> **GH-2**, **GH-3**, **GH-4**, **C3-P**, **PROD-1**, **PAID-2** (enable R2 with a payment method; free up to 10 GB),
> **PAID-3**, **PROD-2** (provision run), and **PROD-3** (deploy run, which creates the `cue` DNS record).
> **PAID-0** only if Cloudflare asks for a card for Zero Trust Free.
> Not approved: Workers Paid, the Mac worker (PROD-4), client review links, SMS, cloud rendering, re-enabling any Relay
> workflow, changing the default branch.

Each run still pauses for your **Approve** in GitHub and your typed phrase. You can stop at any step; `rollback`
removes the Worker.
