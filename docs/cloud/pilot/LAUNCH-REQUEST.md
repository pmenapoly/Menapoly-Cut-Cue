# Menapoly Cue private pilot: launch request (workers.dev + Access, Workers Free)

**Address:** `https://menapoly-cue-cloud.<your-workers-subdomain>.workers.dev`, for you only, behind Cloudflare Access.
**No DNS or nameserver change:** `menapoly-digital.com`, the Canva website and Zoho email are not touched. The reasons
and sources are in [domain-options.md](domain-options.md).

Status 2026-10-20: **nothing deployed, created, purchased or changed** in GitHub settings, Cloudflare, Canva or DNS.

## Open items from the read-only readiness check

| # | Item | Status |
|---|---|---|
| 1 | Public repository contains Relay's security write-up | **FAIL**: fix with **SCRUB-1** (one commit) before GH-A |
| 2 | Approval gate can't be bypassed | manual check after GH-2: no repository secrets; "Allow administrators to bypass" off |
| 3 | Access covers the app and API | code verified; media uses 10–15-minute signed links (by design) |
| 4 | Fits Workers Free | yes on volume; 10 ms CPU per request unmeasured (fallback: $5 Workers Paid) |
| 5 | Deploy and rollback fail safe | tested; logs of this public repository are public (no secret values printed) |
| 6 | Relay deploy workflows disabled | **PASS** |

---

## 1. Read-only checks you can run now

| Code | Check | Where |
|---|---|---|
| **R-1** | Is any Relay app live? (ChatGPT → Sites: a published Relay/Menapoly site? Cloudflare → Workers & Pages: Workers named `menapoly-cue` / `menapoly-cue-preview`?) | ChatGPT, Cloudflare |
| **R-2** | Does the account already have a **workers.dev subdomain**? | Cloudflare → Workers & Pages → right side "Account details" → *Subdomain* |
| **R-3** | Workers plan says **Free** | Workers & Pages → Plans |
| **R-4** | Relay deploy workflows still *Disabled* | github.com/pmenapoly/menapolyrelay → Actions |

## 2. GitHub changes (approval needed, free)

| Code | Change |
|---|---|
| **SCRUB-1** | One commit to `menapoly-cue-2.0` removing Relay's security details from the public docs (no history rewrite) |
| **GH-A** | Add `.github/workflows/pilot.yml` to the default branch `ccr-f6eeb6a3-yozzh0` (the default branch itself stays) |
| **GH-2** | Environment `menapoly-cue-pilot`: you as required reviewer, *Prevent self-review* off, *Allow administrators to bypass* **off**, branch `menapoly-cue-2.0` only; secrets only here |
| **GH-3** | Branch rule on `menapoly-cue-2.0`: block deletion and force pushes |
| **GH-4** | Fine-grained token `RELAY_ACTIONS_TOKEN` (MenapolyRelay, Actions read-only, 90 days) |

## 3. Cloudflare changes (approval needed). No DNS changes at all

| Code | Change | Charges? |
|---|---|---|
| **CF-SUB** | Choose the account's workers.dev subdomain (skip if R-2 shows one). It becomes part of the address | no |
| **C3-P** | API token for the workflow: *Account* → Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Queues Edit, Account Settings Read, Access: Apps and Policies Read, Access: Organizations, Identity Providers, and Groups Read. **No Zone permissions.** Then run **check** (read-only) | no |
| **PROD-1** | Zero Trust (Free): team name, service token `menapoly-mac`, two **self-hosted** Access apps on the workers.dev hostname: "Menapoly Cue" (whole hostname, Allow → your email) and "Menapoly Cue – Mac worker" (path `v1/worker`, Service Auth only) | no (see PAID-0) |
| **PROD-2** | Run **provision**: D1, private R2 bucket (CORS for the workers.dev address only), two queues (24 h); then an R2 API token for that bucket | needs PAID-2 |
| **PROD-3** | Run **deploy**: Worker on its workers.dev address; automatic probe; removed automatically if anything answers without sign-in | no |

## 4. Anything that could create charges

| Code | What | When money could move |
|---|---|---|
| **PAID-2** | Enable R2 (Cloudflare requires a payment method) | only above 10 GB stored ($0.015/GB-month) or the free operation allowance |
| **PAID-0** | Zero Trust Free *may* ask for a payment method | only above 50 users |
| PAID-1 | Workers Paid $5/month | **not requested** (only if error 1102 appears) |
| — | Canva, Zoho, DNS, GitHub | nothing on this path |

**Expected monthly cost: $0.00** (under 10 GB of stored video).

---

## The approval request (after SCRUB-1 is done and R-1 is clear)

> I approve launching the Menapoly Cue private pilot on its workers.dev address behind Cloudflare Access, on Workers
> Free, with no DNS or nameserver changes: **GH-A**, **GH-2**, **GH-3**, **GH-4**, **CF-SUB**, **C3-P**, **PROD-1**,
> **PAID-2** (enable R2; free up to 10 GB), **PROD-2**, **PROD-3**. **PAID-0** only if Cloudflare asks for a card for Zero
> Trust Free. Not approved: Workers Paid, nameserver or DNS changes, the Mac worker, client review links, SMS, cloud
> rendering, re-enabling any Relay workflow, changing the default branch.

Every workflow run still needs your typed phrase and your **Approve** click. `rollback` deletes the Worker at any time.
