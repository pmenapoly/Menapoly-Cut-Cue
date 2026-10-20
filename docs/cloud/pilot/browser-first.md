# Menapoly Cue: browser-first private launch

Goal: open Cue in **Chrome on your Intel iMac** and **Chrome on your Android phone** (installed as an app). You don't
need to install FFmpeg, Python or anything else on the Mac first. Cue stays private (Cloudflare Access, your email
only). Video work waits in a queue until a Mac worker connects later.

**Ready to launch: see [LAUNCH-REQUEST.md](LAUNCH-REQUEST.md)** (verified checks, the four approval groups, next action, approval text).

Status on 2026-10-20: the browser app and the cloud API are built and tested **on a local copy of the stack** (details
in §7). **Nothing is deployed, purchased or changed** in Cloudflare, DNS or GitHub settings.

---

## 1. What works and what's blocked

"Works" means it works in the deployed browser app with **no Mac connected**. "Queued" means the request is saved
and shown honestly as waiting. It runs only when a worker connects, and nothing pretends to have run.

| Area | Without a Mac | Notes |
|---|---|---|
| Sign-in (Cloudflare Access, your email only), session expiry and sign-in again | **Works** | Expired sessions pause uploads safely and return you to the same screen |
| Dashboard: projects, counts (to review, in progress, need attention), create, archive | **Works** | Counts come from real data; no invented percentages |
| Project instructions (purpose, audience, what to keep) | **Works** | Saved to the cloud; an unsaved draft survives a reload |
| Uploads (video, audio, images, documents), original quality, resumable | **Works** | Go straight to private R2; checksum verified; resume after a dropped connection or a closed tab |
| Media library: search, filter by type, play, download | **Works** | Playback depends on the file's codec. Chrome plays H.264 and AAC; iPhone HEVC `.mov` files may only download |
| Ask Cue (built-in planner: reads your projects, proposes actions, only your Approve acts) | **Works** | Live Claude is **not** connected and not claimed |
| Ask for an edit / Request changes on a suggested edit | **Queued** | Your words are saved with the job and shown on it. The Mac editor tightens pauses and filler words; it **doesn't follow written instructions yet**, and says so on the result |
| Transcription, AI rough cut (suggested edit), exports/renders | **Queued** until a worker connects | No progress bar is shown until a worker really reports progress. Rendering is never simulated |
| Review: approve, reject, request changes (with note); exports after approval | **Works** for edits a worker produced | With no worker, there's nothing to review yet |
| Inbox / notifications | **Works** | Uploads, finished jobs and failures. No email or SMS |
| Settings (pilot safety switches, sign out, this device) | **Works** | Shows client links, cloud processing and SMS as **off** |
| Installable Android app (PWA): manifest, icons incl. maskable, offline shell | **Works** in automated Chrome; **not yet tried on your phone** | |
| Desktop layout (sidebar navigation at ≥ 960 px) | **Works** in automated desktop Chrome; **not yet tried on your iMac** | |
| Client review links / public access | **Off** (by design) | `PUBLIC_REVIEW=disabled` |
| Cloud rendering / paid processing | **Off** (by design) | `CLOUD_RENDERING=disabled` |
| SMS | **Off** (by design) | No provider connected |

---

## 2. Minimum remaining steps to a private URL

This is the shortest safe path. Everything happens in **Chrome**, on the iMac or the phone: github.com and
dash.cloudflare.com. Nothing is installed on the Mac. Each step is approved separately (codes in §3). Detailed clicks
are in [phone-only.md §4](phone-only.md#4-phone-only-deployment-path-no-mac-no-cli).

1. **C1–C2 (read-only, 2 min):** Cloudflare → Websites: `menapoly-digital.com` is *Active*; DNS: no `cue` record.
2. **Make "Run workflow" available.** GitHub only shows manual workflows that exist on the **default branch** (today
   `ccr-f6eeb6a3-yozzh0`). Pick one of these:
   - **GH-A (recommended, smallest change):** add only the file `.github/workflows/pilot.yml` to the default branch.
     On github.com, switch to `ccr-f6eeb6a3-yozzh0` → *Add file → Create new file* → name
     `.github/workflows/pilot.yml` → paste the file from `menapoly-cue-2.0` → *Commit directly*. The default branch
     doesn't change. The file only reacts to **Run workflow** (no push, pull-request or schedule triggers), and its
     gate refuses any branch except `menapoly-cue-2.0`. On "Run workflow" GitHub uses the copy on the branch you pick,
     so you always pick `menapoly-cue-2.0`.
   - **GH-1:** change the default branch to `menapoly-cue-2.0`. I reviewed this: the repository has no open pull
     requests, no branch protections, no rulesets and no other registered workflows, so nothing else is affected. It
     is still a default-branch change, so it needs your explicit approval.
3. **GH-2 (environment):** create environment `menapoly-cue-pilot`. You are the required reviewer, and only branch
   `menapoly-cue-2.0` may use it. Its secrets are listed in phone-only.md §4. **GH-4:** a read-only
   `RELAY_ACTIONS_TOKEN`.
4. **C3-P:** create the Cloudflare API token, then run the workflow with action **check** and the phrase
   `check the pilot`. This step is read-only.
5. **PROD-1 (free):** set up Access in the Zero Trust dashboard: a team, the service token `menapoly-mac` and two Access
   apps, with no Bypass rule. Copy the AUD tag and the team domain into the environment secrets.
6. **PROD-2:** run the workflow with action **provision** and the phrase `I approve creating the pilot resources`.
   It creates D1, the private R2 bucket and the queues. Then create an R2 API token limited to that bucket and add it
   to the environment secrets.
7. **PROD-3:** run the workflow with action **deploy** and the phrase `I approve deploying the Menapoly Cue pilot`.
   This creates the `cue.menapoly-digital.com` record and certificate. The after-deploy probe removes the Worker
   automatically if anything is reachable without Access.
8. Open `https://cue.menapoly-digital.com` in Chrome on the iMac and sign in. On Android: open it in Chrome, sign in,
   then *⋮ → Install app*.

Time: about 45–60 minutes of clicking, plus waiting on Cloudflare (zone checks, certificate). The Mac worker is
**not** needed for any of this.

---

## 3. Exact approvals needed from you

Reply with the codes, for example *"I approve GH-A, GH-2, GH-4, C3-P, PROD-1, PROD-2, PROD-3 and stay on Workers
Free"*.

| Code | What | Kind | Cost |
|---|---|---|---|
| **GH-A** *or* **GH-1** | Add `pilot.yml` to the default branch (GH-A), **or** switch the default branch (GH-1) | GitHub production change | free |
| **GH-2** | Protected environment `menapoly-cue-pilot` + its secrets | GitHub production change | free |
| **GH-3** | Protect `menapoly-cue-2.0` (optional, recommended) | GitHub production change | free |
| **GH-4** | Read-only token to check the Relay workflows stay disabled | credential | free |
| **C3-P** | Cloudflare API token for the workflow, then the read-only **check** run | credential | free |
| **PROD-1** | Cloudflare Access (Zero Trust Free, up to 50 users) | Cloudflare production change | free |
| **PROD-2** | Create D1, private R2 bucket, queues | Cloudflare production change | needs R2 enabled → **PAID-2** |
| **PROD-3** | Deploy the Worker + create the `cue` DNS record | **deploy + DNS change** | free on either plan |
| **PAID-2** | Enable R2 (Cloudflare asks for a payment method; first 10 GB free) | paid service (usage) | $0 up to 10 GB |
| **PAID-1** | Workers Paid **or** stay on Workers Free | paid service (optional) | $5.00/mo or $0 |

Not needed for the browser launch: **PROD-4** (Mac worker), **PROD-5** (real-video acceptance; needs the worker),
**CR-1** (GitHub-hosted processing). Stay off: client review links, SMS, cloud rendering, the Relay deploy
workflows (S1 stays as done).

---

## 4. Monthly cost

| Setup | Monthly | What it covers |
|---|---|---|
| **Workers Free + R2 ≤ 10 GB** | **$0.00** | Worker, D1, Queues (10k ops/day), cron, Access (≤ 50 users), DNS, certificate, R2 storage up to 10 GB, downloads (no egress fees) |
| Workers Free + 50 GB of footage | **$0.60** | R2 above 10 GB at $0.015 per GB-month |
| **Workers Paid + R2 ≤ 10 GB** | **$5.00** | Same, plus 10M requests and 30M CPU-ms included, no 10 ms CPU limit per request |
| Workers Paid + 50 GB | **$5.60** | |
| Workers Paid + 100 GB | **$6.35** | |
| GitHub Actions for the deploy runs | **$0.00** | A few minutes per run, within the 2,000 free minutes |

Plus tax where applicable. R2 operation charges are $4.50 per million writes and $0.36 per million reads; a single
user's uploads stay far inside the free 1M and 10M monthly allowance.

**Recommendation:** start on **Workers Free** ($0). The one risk is Workers Free's **10 ms CPU limit per request**,
which hasn't been measured on Cloudflare yet. Signature checks and presigning are done with WebCrypto and are expected
to fit. If any request is refused for CPU (Cloudflare error 1102), approve PAID-1 ($5/month); no code changes are
needed. Full breakdown: [charges.md](charges.md).

---

## 5. Launch-blocking bugs

**None known.** The issues found while preparing the launch are fixed and covered by tests:

| Found | Fix |
|---|---|
| "Mac online" stayed on for minutes after the worker stopped | The worker says goodbye on shutdown; status updates at once |
| After a worker restart, interrupted jobs failed with "No speech was found" | The worker re-runs the interrupted analysis step |
| Duplicate "offline" toast and banner | One banner only |
| An expired session could replace the screen you were on | You stay on the same screen and sign in again |

Unverified until launch (not bugs, but can't be checked from here):
- Access, DNS and the certificate on your account.
- R2 CORS from the real origin.
- CPU per request on Workers Free.
- Chrome on your real iMac and phone.

The first **check** run and the after-deploy probe cover the first three. §7 covers the devices.

Known limits that don't block the launch:
- Written edit requests are stored and shown, but the Mac editor doesn't act on them yet. It says so.
- HEVC files may not preview in Chrome; they can still be downloaded.
- Ask Cue uses the built-in planner. Live Claude isn't connected.

---

## 6. Adding Mac rendering after the browser pilot is running

Nothing in the browser app changes; queued work starts by itself once a worker is online.

1. **On the iMac, once:** run `scripts/mac_setup.sh`. It checks macOS, Homebrew, Python 3.12, Node and FFmpeg, and
   installs each one only after you answer *y*. Secrets are never printed.
2. **In Cue (Settings → Mac workers → Add a Mac → Create worker token):** copy the token. It is shown once. **PROD-4:** put `CUE_CLOUD_URL`,
   `CUE_WORKER_TOKEN` and the Access service-token ID and secret into `.env`, then run `make agent-check` (read-only).
3. Start it: `scripts/cue_mac.sh worker-start`. To keep it running after login, use `make agent-install` (launchd).
   The pill turns **Mac online** within seconds, and the queued transcriptions, edits and exports run in order.
4. **PROD-5:** run the real-video acceptance test ([acceptance-test.md](acceptance-test.md)) and
   `make validate MEDIA=…` for CPU, memory and time on the iMac.
5. Stop at any time with `scripts/cue_mac.sh worker-stop`. The current job goes back to the queue and the app shows
   *Mac offline* at once.

Mac-free alternative (not built, needs **CR-1**): a manual workflow that drains the queue on a GitHub-hosted runner.
See [phone-only.md §3](phone-only.md#3-proposal-a-mac-free-worker-on-github-actions-not-enabled).

---

## 7. Testing: automated vs. real devices

| Test | Kind | Result |
|---|---|---|
| Control plane unit tests (Access JWT, SHA-256, pilot config guard) | automated | 9/9 passed |
| Cloud end-to-end (real Worker under wrangler dev, moto for R2, real Mac agent on Linux, real FFmpeg) | automated, local | full backend suite 121 passed, 1 skipped; pilot workflow and preflight 16/16 |
| Browser UI, Chrome **Android profile at 375 px and 430 px** | automated (Playwright Chromium, Pixel 7 emulation) | 20/20 passed (10 flows × 2 widths) |
| Browser UI, **desktop Chrome at 1440 × 900** (iMac stand-in) | automated (Playwright Chromium) | 10/10 passed |
| PWA install checks (manifest, icons, service worker, offline launch) | automated | passed on all 3 profiles |
| **Chrome on your Intel iMac** | **real device** | **Not run.** Needs the deployment (PROD-3) or your Mac. Nothing here claims it |
| **Chrome on your Android phone + installed app** | **real device** | **Not run.** Needs the deployment |
| Live Claude API | real service | **Not run.** No authorized call was made; not claimed |

Screenshots of the automated runs: `docs/cloud/screenshots/android-375/`, `android-430/`, `desktop-1440/`.

### Real-device checklist (after PROD-3, ~10 minutes)

On the iMac in Chrome:
1. Open the URL and sign in. The sidebar shows Projects, Ask Cue, Library, Inbox, Settings.
2. Create a project, write instructions, save, and reload: they're still there.
3. Upload a short video. The progress bar finishes with "… uploaded", and the file is listed under Footage.
4. Request an edit. It shows **Queued** and "Your Mac is offline", with no progress bar.
5. Library: the file is listed. Play and Download both work.

On the phone in Chrome:
1. Sign in, then *⋮ → Install app*, and open it from the home screen.
2. Repeat 2–5 on a phone video. Rotate the phone: nothing scrolls sideways.
3. Turn on airplane mode: the app shows the offline banner. Turn it off: it recovers by itself.

Report what you see. I'll record each line as **real-device verified** only from your confirmation.
