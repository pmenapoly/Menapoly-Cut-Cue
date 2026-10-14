# Menapoly Cue 2.0 — codebase audit (2026-10-14)

Inspected, not assumed: each claim below was checked by reading the code and running tests in this session.

| Repository / branch | Commit | How it was checked |
|---|---|---|
| `pmenapoly/Menapoly-Cut-Cue` @ `ccr-f6eeb6a3-yozzh0` | `089c095` | 63 backend tests and 16 Playwright tests (5 skipped by design) passed in the previous round. Full code read. |
| `pmenapoly/MenapolyRelay` @ `codex/menapoly-cue-verified-20260913` | `0169a60` | `npm ci`; `npm run test:unit` gave **39/39 pass**; `npm run typecheck` **passed**. Read the key files. |
| `pmenapoly/MenapolyRelay` @ `main` (production, auto-deploys to Cloudflare) | `e5a904d` | Diff against the verified branch only. Nothing was modified. |
| `pmenapoly/MenapolyClientPortal` | — | Visible to this account but not named in the brief, so not inspected. |

## 1. What each codebase is

**Menapoly Cut Cue** is the local, single-user editor.
- **Stack:** FastAPI and SQLite (WAL, versioned migrations), FFmpeg rendering, faster-whisper, Claude through tools. The frontend is a Next.js 15 static export served by the same process.
- **Where it runs:** on the user's Mac. Media stays on disk.

**Menapoly Cue (Relay)** is a multi-tenant client-production SaaS on Cloudflare.
- **Stack:** Next.js 16 through vinext on Workers, with D1 (Drizzle, migrations 0000–0009) and R2. Identity comes from Cloudflare Access or ChatGPT Sites.
- **Features:**
  - workspaces with seven roles;
  - projects, tasks and queues;
  - versioned review with timecoded and on-frame comments, threaded replies and @mentions;
  - approvals;
  - per-user notifications;
  - an append-only audit log;
  - Brand Mind (formerly Brand Brain);
  - AI Visibility evidence;
  - Video Flow requests;
  - 10 GB resumable R2 multipart uploads.

The two apps don't share a runtime or storage. A Worker can't run FFmpeg or reach a FastAPI on a laptop. Any integration therefore has to go through an explicit contract, not shared code.

## 2. Working and tested

**Cut Cue (verified by its test suite):**
- upload, ingest, analysis and transcription (fixture transcriber in tests; faster-whisper in real use);
- proposals that need approval;
- versioned timelines with undo/redo;
- real FFmpeg renders with captions, reframing and export presets;
- audio enhancement and processed-audio re-import;
- podcast auto-editor, Clip Factory, brief extraction and compliance;
- Simple and Pro UI, keyboard editing and the instant preview player.

**Relay (verified by 39 unit tests against a fake D1/R2 using the real migrations):**
- workspace authorization;
- review workflow with decisions;
- append-only audit log;
- notifications with dedupe and cursor pagination;
- upload completion and rollback.

## 3. Broken, incomplete or unverified

- **Cut Cue:** never run on the user's Intel Mac. Live Claude, real faster-whisper and real Chrome H.264 playback haven't been verified.
- **Cut Cue:** no client, review-link, inbox, notification or library concepts. Before this round, every surface was one project at a time.
- **Relay:** has no editing, transcription or rendering. "Video Flow" tracks requests and costs only.
- **Relay:** no email or SMS delivery. Notifications are in-app only.
- **Relay:** production deployment state can't be seen from here. Secrets and the Cloudflare dashboard weren't accessed.

## 4. Technical risks

1. **Identity header trust in Relay (high).**
   - **What happens:** `app/chatgpt-auth.ts` returns a user straight from the `oai-authenticated-user-email` request header whenever it is present. It checks this *before* verifying the Cloudflare Access JWT.
   - **Why it matters:** on the Cloudflare deployment nothing strips that header (`worker/index.ts` passes requests through unchanged). An Access-authenticated low-role user, for example a client, could send `oai-authenticated-user-email: <owner email>` and act as the owner.
   - **Recommended fix:** when `CF_ACCESS_AUD` is configured, ignore the ChatGPT headers entirely (or strip them in `worker/index.ts`). Add a test for it.
   - **Status:** *Not changed here.* That branch feeds production and the brief says not to overwrite production code. It needs your go-ahead.
2. **Two databases, one concept.** Projects exist in both D1 and SQLite. Without a single ID mapping, versions and reviews will drift. *Mitigation:* the v1 contract below. Cut Cue owns edit state; Relay mirrors only what it publishes.
3. **Media duplication.** Uploading the same footage to R2 and to the local store doubles storage and transfer. *Mitigation:* assets carry a `sha256`, so register by reference and publish only renders to the cloud.
4. **Prompt injection through briefs and transcripts.** Both apps feed user documents to AI. *Mitigation in Cut Cue:* document text is wrapped as untrusted data, and all tools return proposals. Ask Cue follows the same rule.
5. **Production auto-deploy.** Any merge to Relay `main` deploys and migrates D1. No work in this round touches Relay branches.
6. **Single-user auth in Cut Cue.** Cut Cue has an optional shared password. Public review links therefore need their own scoped, revocable tokens; they must not reuse the app session.

## 5. Reusable services

| Need in Cue 2.0 | Reuse from |
|---|---|
| Edit, render, transcript, proposals, versions | Cut Cue `Services` (unchanged) |
| Job queue and status | Cut Cue `JobManager` (real progress from FFmpeg `out_time`; no invented values) |
| Review threads, decisions, notification dedupe patterns | Relay design: `(recipient, type, source)` unique dedupe and cursor pagination. Re-implemented locally in SQLite; no code shared across runtimes. |
| Roles and multi-tenant client access | Relay. Stays there; Cut Cue stays single-user. |
| Large cloud uploads and client portal | Relay R2 multipart and review UI (a future connector target) |

## 6. Recommended integration boundaries

```
 ┌──────────── Menapoly Cue 2.0 (this branch, local, single user) ────────────┐
 │  App shell: Home · Projects · Cut Cue · Inbox · Library · (Settings)        │
 │  Cue layer (backend/cutcue/cue.py): clients, review links, notifications,   │
 │  Ask Cue actions, library, Cue Text intake  ── SQLite migrations 5+          │
 │            │ calls only through Services (+ /api/v1 contract)              │
 │  Cut Cue core (unchanged): Services · JobManager · FFmpeg · Claude tools    │
 └────────────┬───────────────────────────────────────────────────────────────┘
              │ /api/v1 (versioned contract, docs/cue2/api-contract-v1.md)
              ▼ future connector (opt-in, needs approval per publish)
      Menapoly Cue on Cloudflare (Relay): client workspaces, roles, R2 review
```

- **Cut Cue stays independently runnable.** The Cue layer is additive: new tables, routes and pages. With the Cue pages ignored, `/project/` is the same editor as before.
- **Cue 2.0 is built in the Cut Cue repo first.** The priority is "a genuinely usable private application as quickly as possible". The working editor, renderer and AI already live here, and the user's machine is where FFmpeg runs.
- **Relay stays the place for multi-client collaboration.** Connecting the two (publishing a render to a Relay review workspace) is a later, approval-gated step that needs Relay credentials. It is not part of this round.
