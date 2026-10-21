# Test results (2026-10-15, Linux cloud container)

Everything here ran against the real control-plane Worker code under `wrangler dev --local` (workerd, local D1,
local Queues, cron via `/__scheduled`), moto's S3 server in place of R2, and the real Mac agent and Cut Cue pipeline
(real FFmpeg; the fixture transcriber stands in for Whisper). **Nothing touched Cloudflare.** Items that need real
Cloudflare, a real Intel Mac or a real phone are listed in [blockers.md](blockers.md) as unverified.

## Auth and security (`cloud/control-plane/test/access.test.ts`, `backend/tests/test_cloud_e2e.py`)

| Check | Result |
|---|---|
| Valid Access JWT (real RS256 key) accepted; email normalised | pass |
| Wrong audience, wrong issuer, expired, not-yet-valid, HS256, other key, tampered payload, missing email, garbage token | all rejected |
| Unknown key id refreshes the key set exactly once | pass |
| Email not on the owner/editor lists → 403; no token → 401 | pass |
| `cf-access-authenticated-user-email` / `x-dev-user` headers alone never authenticate | pass |
| Dev identity refused on a public hostname and in production on localhost | pass |
| Production without Access settings → 503 on every private route (no fallback) | pass (unit + live wrangler instance) |
| Production with Access settings, missing/garbage token → 401 | pass |
| Editor can't set budgets, list/register/revoke workers or read the audit log | pass |
| Cross-site POST (foreign `Origin`) → 403; non-JSON body → 415; body over 256 KB → 413 | pass |
| `cache-control: no-store`, `nosniff`, `X-Frame-Options: DENY` on API responses; CSP on the app | pass |
| Worker token: wrong secret → 401; revoked → 401; only SHA-256 stored | pass |
| Worker can't act on another worker's lease; stale lease token → 409 `lease_lost` | pass |
| Uploads: .exe/.html refused (415), extension/type mismatch (415), 21 GB video and 201 MB image (413), bad size/SHA/part size (400), path traversal in file name neutralised | pass |
| Editors can't read another person's upload session | pass |
| Review links: token stored only as a hash; 2 h expiry honoured; expired → 410; turned off → 410; unknown → 404; response exposes nothing else from the project | pass |
| Audit log rejects UPDATE and DELETE (triggers) | pass |
| Cloud processing off: cloud job → 409; authorize → 409 | pass |
| Agent logs never contain the worker token | pass (browser test checks the agent's output) |

## Workflow (`test_cloud_e2e.py`, 13 tests: all pass)

- Resumable upload: parts 1 of 3, "interruption", status shows `[1]`, early completion → 409 `missing_parts [2,3]`,
  wrong-size part → 409, re-send → complete, repeat completion is idempotent, downloaded bytes match the SHA-256.
- Expired upload session is aborted by cron, and its asset is marked failed.
- Idempotent job creation (same key → same job, `idempotent-replay: true`, one row).
- Lease expiry → requeue (×2) → dead after 3 attempts → "job_failed" notification → owner retry resets attempts.
- Offline worker: `worker_online: false`, no progress shown; after a heartbeat it's online. Revoking a worker requeues
  its leased job.
- Crash recovery: a restarted agent releases the lease it held (attempt not spent).
- Honest failures: bytes that aren't video → `failed` with FFmpeg's reason; tampered checksum → `failed`
  ("doesn't match the checksum").
- Full remote workflow on a real **H.264/AAC** file: transcribe (segments stored as JSON output) → auto-edit →
  **proposed** version (render refused until approved) → approve → YouTube preset render on the "Mac" → output
  verified in storage → downloaded file's SHA-256 matches; ffprobe: h264 + aac; duration within 0.5 s of the render
  report → review link → client comment + approval → notifications (upload, job done, review) → revoke/expiry.

## Phone-size browser tests (`frontend/e2e-cloud`, Chromium, Pixel 7 profile at 390×844: 4 pass)

1. Sign-in: owner gets in; an email not on the list sees "not allowed".
2. Upload: a dropped connection on one part is retried automatically. With the page closed after 1 of 3 parts, picking
   the same file again sends **only parts 2 and 3**.
3. Remote edit: with no agent running the job says "Waiting for your Mac · Your Mac is offline" (no progress bar).
   Starting the agent → the queued job runs by itself → approve → export → preview URL serves the MP4 → download →
   share link → client requests changes and approves on the review page → feedback and inbox update → link turned
   off → 410.
4. Settings: workers, costs ("No recorded spending", "Cloud processing: off"), worker token shown once; manifest,
   service worker and CSP present.

Screenshots: [screenshots/](screenshots) (tokens and links masked).

**Unverified here:** in-browser H.264 playback. This Chromium build has no H.264 decoder. The test checks the
private URL returns the real MP4 and records playback as unverified rather than passing it.

## Other checks

- `npx tsc --noEmit` (control plane and frontend): clean. `npm run build` (frontend): clean.
- `wrangler deploy --dry-run`: builds with the D1, Queue, assets and vars bindings (nothing uploaded).
- Streaming SHA-256 (browser) matches node:crypto on all padding edge cases.
- `scripts/validate.py` step 19 (remote worker end to end against a local control plane) ran here: VERIFIED
  (fixture transcriber; on the Mac it uses your real Whisper settings). Step 20 reports BLOCKED until a deployment exists.
- Full backend suite (`make test`, includes the 13 cloud tests): 106 passed, 1 skipped (7 min 10 s).

## Pilot preparation (2026-10-19)

- Relay deploy workflows: both disabled since 2026-10-20 (S1). Relay's own security checks are tracked in its private repository.
- Control plane: 9 unit tests, including the new config guard (custom domain only, no workers.dev/preview URLs,
  cloud processing and client links off, separate from Relay). Wrangler dry-run with the
  `cue.menapoly-digital.com` route.
- New: client review links off by default (`PUBLIC_REVIEW=disabled`): no link can be created, and old tokens are
  refused before lookup (`test_client_review_links_are_off_by_default`).
- New: `scripts/pilot_acceptance.py` passes end to end against the local stack with the real agent process
  (`test_pilot_acceptance.py`: steps 2–10 VERIFIED; 1 and 11 need the real deployment and phone).
- Preflight Access-policy rules (Bypass, Everyone, IP ranges, Service Auth placement): `test_pilot_tools.py`.
- Phone-size browser tests: 4/4 pass after the changes.
- Full backend suite after pilot preparation: 111 passed, 1 skipped (9 min 46 s).

## Phone-only round (2026-10-20)

- Chrome-on-Android browser tests (Pixel 7 profile) at **375 px and 430 px: 18/18 pass**. They cover:
  - install: manifest, icons including maskable, a real service worker, offline launch;
  - sign-in and refusal;
  - project drafts surviving a reload;
  - upload retry and resume;
  - Ask Cue proposals and approval;
  - Mac offline, then reconnect, review, approve, export, play and download;
  - session expiry: banner, paused upload, return to the same screen, only missing parts sent;
  - offline banner;
  - inbox, settings and archive.

  No page scrolls sideways at either width. Screenshots: `screenshots/android-375/`, `screenshots/android-430/`.
- Unverified in this browser: H.264 playback (no codec in this Chromium build; the bytes are checked instead), and
  live Cloudflare Access (simulated with its redirect).
- Backend: **120 passed, 1 skipped**. New tests:
  - Ask Cue proposes and only approval acts; double-tap safe; editors can't approve;
  - archive stops queued work;
  - a worker that goes offline shows at once;
  - agent drain mode;
  - workflow safety: manual-only, branch-locked, approval environment, SHA-pinned actions, fail-closed Relay gate.
- `actionlint` 1.7.7: `.github/workflows/pilot.yml` clean. Control plane 9/9, Wrangler dry-run, frontend build OK.
