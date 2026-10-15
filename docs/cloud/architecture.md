# Menapoly Cue — hybrid cloud + Intel Mac architecture

Status: **built and tested locally; not deployed.** Nothing in this document is live until the owner approves a
deployment (see [setup.md](setup.md) and [blockers.md](blockers.md)).

## Picture

```
 Phone / laptop browser (PWA)                                   Client (review link)
        │  HTTPS, Cloudflare Access session                           │ HTTPS, token in URL #fragment
        ▼                                                             ▼
 ┌──────────────────────── Cloudflare (one Worker: menapoly-cue-cloud) ─────────────────────────┐
 │  Static app (cloud/web)   /v1/* API (cloud/control-plane/src)    cron */5   Queue consumer  │
 │        │                         │            │                     │              │         │
 │        │                    D1 (metadata,  presigns short-lived  recovery:     notifications │
 │        │                    audit, leases)  S3 URLs (no bytes)   leases,        (+ optional   │
 │        │                                       │                 uploads,        email)       │
 │        │                                       ▼                 orphans                      │
 │        │                            R2 Standard bucket (private, no public URL)                │
 └───────────────────────────────────────────────▲───────────────────────────────────────────────┘
          media bytes go browser ⇄ R2 directly   │   media bytes go Mac ⇄ R2 directly
                                                 │
        Intel Mac (home/studio) ── outbound HTTPS only ── python -m cutcue.agent (launchd)
            poll /v1/worker/lease → download inputs (verify SHA-256) → existing Cut Cue pipeline
            (FFmpeg, faster-whisper, podcast auto-edit, render) → upload outputs → report stage/progress
```

## Components

| Piece | Where | What it does |
|---|---|---|
| Control plane | `cloud/control-plane` (TypeScript Worker) | Versioned `/v1` API, auth, D1 metadata, presigned storage URLs, leases, cron recovery, queue consumer. Never proxies media. |
| Web app (PWA) | `cloud/web` (plain JS modules, no build) | Phone-first: projects, resumable uploads, jobs with honest status, approve/reject edits, export, preview, download, review links, inbox, workers, costs. Installable; caches only the app shell. |
| Review page | `cloud/web/review.html` | Public, token-scoped page for one video: watch, comment, approve, request changes. |
| Mac agent | `backend/cutcue/agent.py` | Outbound-only worker that runs the existing Cut Cue pipeline in its own data directory (`~/Library/Application Support/MenapolyCue/agent`), so the personal editor's data is untouched. launchd template in `deploy/macos`. |
| Local stack | `scripts/cloud_stack.py`, `scripts/cloud_dev.py` | `wrangler dev --local` (workerd + local D1/Queues/cron) and moto S3 standing in for R2 — used by tests and `make cloud-dev`. |

The existing FastAPI editor (`python -m cutcue`) is unchanged and still runs on its own. The agent imports its
`Services` directly; no FastAPI server is exposed anywhere.

## Data model (D1, `migrations/0001_init.sql`)

projects · assets (source/output, SHA-256, private object key) · upload_sessions · jobs (type, target, status,
attempts, lease, stage, measured progress) · job_events · timeline_versions (proposed → approved/rejected) ·
review_links (hashed token, expiry, revocation) · review_events · notifications (deduplicated) · workers (hashed
secret) · audit_log (append-only by trigger) · idempotency · cost_ledger · authorizations · rate_limits.
IDs are `<prefix>_<16 hex>`; every create accepts an `Idempotency-Key`.

## Flows

**Upload (phone → R2, resumable).** The browser fingerprints the file (streaming SHA-256 in a Web Worker), creates an
upload session (type/extension/size checked; ≤ 20 GB video), then PUTs 8 MiB parts straight to R2 using 15-minute
presigned URLs, three at a time, retrying with backoff and waiting out offline periods. Completion asks R2 which parts
arrived (ListParts), checks every part size, completes the multipart upload and checks the stored size. The session is
kept in IndexedDB, so after a closed tab the same file resumes with only the missing parts. Unfinished sessions are
aborted by cron after 24 h.

**Job (phone → Mac → phone).** Creating a job queues it (target `mac`). The agent polls, and one atomic
`UPDATE … RETURNING` gives it a 180 s lease plus 10-minute download URLs and the expected SHA-256 of each input. The agent
verifies every byte, ingests through the normal Cut Cue upload path, and runs the pipeline. It reports the local job's
own message and FFmpeg/Whisper-measured progress, which also renews the lease. Outputs upload through presigned PUTs to
deterministic keys (`projects/<p>/outputs/<job>/<name>`); completion checks each object's size and is idempotent. A
suggested edit (`auto_edit`) goes through `Services.create_proposal` on the Mac and becomes a **proposed** version
in the cloud. Rendering refuses anything that isn't **approved** by a person.

**Failure and recovery.** Lease expired (Mac asleep/offline/crashed) → cron requeues; after 3 attempts the job is
`dead` and you get a notification; you can retry. A restarted agent releases the lease it held (no attempt spent).
SIGTERM releases the current job. Revoking a worker requeues its jobs immediately. Queue messages retry 3× and then go
to the dead-letter queue `menapoly-cue-events-dlq`.

**Review.** The owner creates a link for one finished video (1 h–14 days, default 3 days, download optional). Only the
SHA-256 of the token is stored; the token travels in the URL fragment, which browsers don't send to servers or in
Referer headers. Links can be turned off instantly.

## Security model

- **People:** Cloudflare Access in front of the hostname; the Worker independently verifies the Access JWT (RS256 with
  the team's keys, audience, issuer, expiry), then requires the email to be in `OWNER_EMAILS` or `EDITOR_EMAILS`.
  Editors can't change budgets, manage workers, authorize spend or read the audit log. In production with Access
  settings missing, every private route returns 503: there is no unauthenticated fallback. The local dev identity works
  only when `ENVIRONMENT=development` **and** the request is to localhost.
- **Mac workers:** `Authorization: Bearer cqw_<id>.<secret>`; only the secret's SHA-256 is stored; revocable. Optionally
  also an Access service token on `/v1/worker/*`.
- **Clients:** review token (hashed, expiring, revocable, one video, rate-limited).
- **Storage:** private R2 bucket, no public access, no r2.dev URL; all access through presigned URLs that last 10–15
  minutes. The R2 API keys live only in Worker secrets.
- **Requests:** JSON-only bodies (415 otherwise) with a 256 KB cap, cross-site state changes refused (Origin check),
  rate limits in D1, `no-store`, `nosniff`, `X-Frame-Options: DENY`, HSTS; strict CSP on the app (`_headers`).
- **No inbound ports on the Mac**, no router port forwarding, no tunnel needed.
- **Costs:** cloud processing is off (`CLOUD_RENDERING=disabled`); a cloud job can't even be created. If it is ever
  turned on, each paid job waits for the owner's explicit authorization with a dollar cap.

## Interim option without any deployment

Tailscale Serve (free personal plan) can publish the existing local editor to your own devices only, over your
tailnet with HTTPS: `tailscale serve --bg 8000`. It's private to devices signed in to your tailnet and opens no router
ports. It's the quickest way to use the current editor from your phone while the cloud deployment waits for approval.
It doesn't give clients review links (Funnel would make it public, so don't use Funnel).
