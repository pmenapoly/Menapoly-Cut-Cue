# Finishing and testing the pilot from an Android phone (no Mac, no desktop)

Prepared 2026-10-20 on `menapoly-cue-2.0`. **Nothing here has been bought, created or deployed.** Every Cloudflare or
GitHub change below is a numbered approval in [APPROVAL-CHECKLIST.md](APPROVAL-CHECKLIST.md) (Part 6, phone-only path).
The Relay security gate stays in force: both Relay deploy workflows are disabled and nothing here re-enables them.

## 1. What works from the phone alone, and what needs a worker

"Worker" means the Intel Mac running `python -m cutcue.agent`, or the Mac-free alternative in §3 if you approve it.

| Feature | Without a worker | Tested (Chrome Android, 375 and 430 px) |
|---|---|---|
| Install as an app (manifest, icons incl. maskable, service worker, offline launch screen) | ✅ works | ✅ |
| Cloudflare Access sign-in; anyone not on your list is refused | ✅ works | ✅ local stand-in for Access; **live Access unverified until deploy** |
| Session expiry: banner, uploads pause, "Sign in again" returns to the same screen and resumes only missing parts | ✅ works | ✅ (Access redirect simulated) |
| Offline banner and recovery | ✅ works | ✅ |
| Create, open and archive projects; draft names survive a reload | ✅ works | ✅ |
| Original-quality upload to private storage; retry on dropped connection; resume after the app is closed | ✅ works | ✅ |
| Preview and download your **original uploads** | ✅ works | ✅ (download bytes checked; in-browser H.264 playback **unverified**: the test browser has no H.264; Chrome on Android does) |
| Ask Cue: what needs attention, Mac status, list projects, propose create/transcribe/suggest edit/export/archive; only your approval acts | ✅ works (built-in planner; Claude not connected) | ✅ |
| Request a transcript, a suggested edit or an export | ⏸ **queues and waits** ("Waiting for your Mac") | ✅ honest waiting state, no fake progress |
| Transcription (Whisper) | ❌ needs a worker | ✅ with the real agent (fixture transcriber) |
| Suggested edit (podcast auto-editor) and its review | ❌ needs a worker | ✅ with the real agent |
| Export / render (FFmpeg: YouTube, Podcast, Reels, TikTok, LinkedIn, Preview) | ❌ needs a worker | ✅ with the real agent, real H.264/AAC output, checksum verified |
| Play and download **exports** | needs exports to exist, so a worker | ✅ |
| Inbox (uploads, finished and failed jobs) | ✅ works (fills up as work happens) | ✅ |
| Settings: account, sign out, install help, costs, Mac workers, pilot safety switches | ✅ works | ✅ |
| Client review links, SMS, paid cloud rendering | 🚫 off for this pilot (enforced in code and config) | ✅ verified off |
| Live Claude for Ask Cue | 🚫 not connected (no API key; would be a paid service) | — |

**In short:** sign-in, projects, uploads, Ask Cue, approvals, status, inbox, settings and downloads of your own
files all work from the phone with no Mac. Anything that **reads or changes the video itself** (Whisper,
the auto-editor, FFmpeg rendering) runs on a worker, because those programs can't run inside a Cloudflare Worker or a
phone browser.

## 2. Why video processing needs a worker

- **FFmpeg rendering** decodes and re-encodes video. It's a native program that needs a real CPU, minutes of run time
  and gigabytes of disk. Cloudflare Workers allow milliseconds to seconds of CPU per request and have no FFmpeg and no
  disk.
- **Whisper transcription** loads a ~150 MB to 1.5 GB speech model and runs for roughly the length of the audio on
  a CPU.
- **The suggested edit** needs the transcript and silence detection (FFmpeg) first.

The worker only connects out. It downloads just the job's inputs through 10-minute links, checks their checksums,
does the work, and uploads the results through 15-minute links.

## 3. Proposal: a Mac-free worker on GitHub Actions (not enabled)

The same agent can run inside a **GitHub-hosted runner** (an Ubuntu VM that exists only for one run). The new
`--drain-minutes` mode, tested, works through the queue and then exits.

**How it would work**
- A second manual workflow, "Process queued videos", on the same protected `menapoly-cue-pilot` environment. You
  start it from the phone after queuing work. It installs FFmpeg and faster-whisper, runs
  `python -m cutcue.agent --drain-minutes 300`, and the VM is destroyed afterwards.
- A scheduled version, e.g. every 2 hours, is possible later, but runs only if you approve that too.

**Cost (GitHub list prices, mid-2026):**
- Private repositories on GitHub Free include **2,000 Linux minutes per month at no charge**. After that it's
  **$0.006 per minute** (2-core Linux), *only if* you raise the Actions spending limit above $0. With the default $0
  limit, runs just stop when the minutes run out.
- Per video, roughly 3–5 minutes of setup plus about 1–3 minutes of processing per minute of footage on a 2-core
  runner. **This is an estimate, not measured**: the first approved run would measure it. So a 10-minute interview
  is very roughly 15–35 runner minutes, and the free allowance would cover about 60–130 such videos a month.
- No Cloudflare cost beyond the pilot's own.

**Security implications**
- Your footage is processed on a GitHub/Microsoft-hosted VM in GitHub's cloud, not on hardware you own. The VM is
  single-use and wiped after the run. Nothing is uploaded as a build artifact, and logs show stages, not content.
- It needs two more environment secrets: a worker token (created in the app) and the Access service token. Both are
  usable only on `menapoly-cue-2.0` after your approval, and the worker token can be revoked in the app at any time.
- Anyone who can push to `menapoly-cue-2.0` could change what the runner does. Today that's only you; protect the
  branch (§4, GH-3).

**Alternative considered:** Cloudflare Containers, which run FFmpeg next to the Worker. It's billed per vCPU and
memory second on top of Workers Paid, and it needs a container image and a more complex setup. **Not recommended**
for the pilot.

**Approval needed:** CR-1 (add and allow the "Process queued videos" workflow). It isn't in the repository; I'll add
it only after you approve.

## 4. Phone-only deployment path (no Mac, no CLI)

Everything below is done in **Chrome on your Android phone** at github.com and dash.cloudflare.com. For GitHub
settings pages, tick Chrome's **⋮ → Desktop site** if a setting is hidden on the mobile layout.

The deploy itself runs in GitHub Actions through `.github/workflows/pilot.yml`:
- **Manual only.** No push, pull request or schedule trigger.
- **Locked to `menapoly-cue-2.0`.** Enforced twice in the workflow, and again by the environment's branch rule.
- **Typed phrase required** for each action.
- **Waits for your approval** in the protected `menapoly-cue-pilot` environment, the only place the credentials live.
- **Fails closed.** A read-only preflight stops the run unless:
  - Relay's deploy workflows are disabled;
  - the zone is active in your account;
  - both Access apps exist, with no Bypass, Everyone or IP-range rules;
  - the Access audience and team domain match the secrets.
- **Probes after deploying.** Every unauthenticated request must be redirected to Access or refused; otherwise the
  Worker is deleted automatically.

### Step A: GitHub (approvals GH-1 to GH-3)

1. **GH-1, default branch.** GitHub only offers **Run workflow** for workflows on the default branch, and today that's
   the old `ccr-f6eeb6a3-yozzh0`. Repository → **Settings → General → Default branch** → switch to `menapoly-cue-2.0`
   → *I understand, update*. No code is merged; you can switch back any time.
2. **GH-2, protected environment.** Settings → **Environments → New environment** → `menapoly-cue-pilot`:
   - **Required reviewers:** add yourself (`pmenapoly`). Leave "Prevent self-review" **off**: you're the only reviewer.
   - **Deployment branches and tags:** *Selected branches* → add `menapoly-cue-2.0`.
   - **Environment secrets** (add as you get them in steps B–D): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
     `RELAY_ACTIONS_TOKEN`, `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `OWNER_EMAILS`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`,
     `S3_SECRET_ACCESS_KEY`, `D1_DATABASE_ID`. Never add them as repository-wide secrets.
3. **GH-3, protect the branch** (recommended). Settings → **Branches → Add rule** → `menapoly-cue-2.0`:
   *Restrict deletions* and *Block force pushes*.
4. **`RELAY_ACTIONS_TOKEN`** (read-only). GitHub → your avatar → **Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate**:
   - Repository access: only **MenapolyRelay**.
   - Permissions: **Actions: Read-only** (Metadata: Read-only is added automatically).
   - Expiry: 90 days.

   Paste it as the environment secret. It lets the preflight *see* the Relay workflow states and can't change anything.

### Step B: Cloudflare account checks (C1–C3, read-only)

1. **C1:** dash.cloudflare.com → **Websites**: `menapoly-digital.com` shows **Active**.
2. **C2:** open it → **DNS → Records**: no record named `cue`.
3. Copy the **Account ID** (Overview page, right side) → secret `CLOUDFLARE_ACCOUNT_ID`.
4. **C3, API token for the workflow.** My Profile → **API Tokens → Create Token → Custom token**, named
   "menapoly-cue-pilot":

   | Scope | Permissions |
   |---|---|
   | Account (your account only) | Workers Scripts **Edit** · D1 **Edit** · Workers R2 Storage **Edit** · Queues **Edit** · Account Settings Read · Access: Apps and Policies Read · Access: Organizations, Identity Providers, and Groups Read |
   | Zone (`menapoly-digital.com` only) | Zone Read · DNS Read · Workers Routes **Edit** |

   Set a 1-year expiry → secret `CLOUDFLARE_API_TOKEN`. If a run reports a missing permission, its error names it;
   nothing is half-created because the run stops at the first error.
5. GitHub → **Actions → Menapoly Cue pilot → Run workflow**: branch `menapoly-cue-2.0`, action **check**, phrase
   `check the pilot` → **Run** → open the run → **Review deployments → Approve**. The log is the C3 preflight result.
   Expected: zone OK, `cue` free, Relay OK; Access and resources "NOT YET".

### Step C: Access (PROD-1, dashboard, free)

As in [deployment-plan.md step 1](deployment-plan.md#step-1-cloudflare-access-dashboard-free-checklist-prod-1), on the
phone:
1. **Zero Trust** → set the team name.
2. **Service token** `menapoly-mac` → keep its ID and secret for the worker. Don't add them to GitHub unless CR-1 is
   approved.
3. App **"Menapoly Cue – Mac worker"** (`cue.menapoly-digital.com` / path `v1/worker`, Service Auth only).
4. App **"Menapoly Cue"** (whole host, Allow → your email, 24 h session) → copy its **AUD tag** → secret
   `CF_ACCESS_AUD`.
5. Team domain (`<team>.cloudflareaccess.com`) → `CF_ACCESS_TEAM_DOMAIN`.
6. Your email → `OWNER_EMAILS`.

### Step D: resources (PROD-2)

1. Run the workflow: action **provision**, phrase `I approve creating the pilot resources` → approve. It creates the
   D1 database, the private R2 bucket (no public URL, CORS for the pilot only, unfinished uploads removed after 2 days)
   and the two queues, then applies the schema.
2. It prints the **D1 id** → save it as `D1_DATABASE_ID`.
3. R2 → **Manage R2 API Tokens → Create**: *Object Read & Write*, **only bucket `menapoly-cue-media`** → copy the
   Access Key ID / Secret Access Key → `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. The S3 endpoint shown there,
   `https://<account-id>.r2.cloudflarestorage.com`, → `S3_ENDPOINT`.

### Step E: deploy (PROD-3, creates the `cue` DNS record)

Run the workflow: action **deploy**, phrase `I approve deploying the Menapoly Cue pilot` → approve. It goes through
the gate, then deploys with the secrets, then runs the after-deploy probe. **Only when that run is green** will I give
you the install link and the Android steps ([android.md](android.md)).

To undo: action **rollback**, phrase `I approve removing the pilot Worker`.

### What the phone-only pilot can't do yet

Until a worker exists (your Mac, or CR-1), jobs stay **queued**. The app says so plainly and starts them when a worker
connects. Everything else in §1 works.
