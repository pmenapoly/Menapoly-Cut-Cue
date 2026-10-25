# Menapoly Cue Studio: audit, design and preview

Branch: `menapoly-cue-studio-preview` (created from `menapoly-cue-2.0` at `8e17b9e`).
Preview code: `studio-preview/`. Tests: `studio-preview/tests/` (Node) and `frontend/e2e-studio/` (Playwright).
Integration proposal: [integration-plan.md](integration-plan.md).

## Phase A: audit of what exists (read-only, 2026-10-25)

### Deployed pilot
`https://menapoly-cue-cloud.pmenapoly.workers.dev` runs commit `8e17b9e`, the tip of `menapoly-cue-2.0`. It was
deployed by the owner-approved workflow run #9 on 2026-10-23.

| Layer | What it is | Reusable for Studio |
|---|---|---|
| `cloud/control-plane` (Cloudflare Worker, TypeScript) | 45 API routes. D1 holds 16 tables: projects, assets, upload_sessions, jobs, job_events, timeline_versions, review_links, review_events, notifications, workers, audit_log, idempotency, cost_ledger, authorizations, rate_limits, cue_actions. Private R2 is reached through presigned URLs only. Queues and cron recovery. | Yes: uploads, jobs, leases, versions, audit, idempotency, rate limits, Ask Cue proposals |
| Auth | Cloudflare Access JWT verified in the Worker, plus email allowlists → `owner` / `editor` | Yes, but roles must grow (below) |
| `cloud/web` (plain-JS PWA, about 1,350 lines) | Projects, uploads, Ask Cue, Library, Inbox, Settings, Mac worker setup | Patterns (resumable upload, session expiry); the Studio UI replaces it |
| `backend/cutcue` (FastAPI, local) | The real editing engine: FFmpeg, faster-whisper, auto-edit, podcast, moments, brief compliance; `agent.py` is the outbound Mac worker | Yes: the processing engine behind the job API |
| `frontend` (Next.js, local studio) | Local desktop UI | Design ideas only |

### Security boundaries already in place
- Access at the edge, plus an independent JWT and allowlist check in the Worker. It fails closed (503) without Access
  settings, and a test calls every route with forged credentials.
- Media never passes through the Worker. Signed R2 links last 15 minutes (upload) and 10 minutes (download); the
  bucket is private.
- AI edits are proposals until approved. Ask Cue proposes; only `POST /v1/actions/:id/approve` acts.
- Deploys are manual, owner-approved, branch-locked and probed after deploy.

### Gaps against the product vision

| Needed | Status in the pilot |
|---|---|
| Tenants (client workspaces) and a **client** role | Missing. Every signed-in person sees every project |
| Editor **assignments** (editors see only their projects) | Missing. Editors see everything |
| Folders, tags, Channel Media | Missing |
| Editing request types, briefs, revision limits | Partial (job `params.request` only) |
| Frame annotations, threads, resolve, compare | Missing (versions and approve/reject only) |
| Content feed, comments, saves | Missing |
| Social drafts, approvals, calendar | Missing |
| Coaching content and progress | Missing |
| AI Visibility (sources, measurements, reports) | Missing; there is no data source yet |
| Plan entitlements | Missing |

The first gap is the important one. **The pilot has no tenant isolation.** It is safe today only because a single
owner email is allowed in. Inviting a client before workspaces and server-side role checks exist would expose every
project to them.

## Isolation of this preview (verified)

| Boundary | How it's enforced | Evidence |
|---|---|---|
| Separate branch | `menapoly-cue-studio-preview`; `menapoly-cue-2.0` is untouched | `git log` |
| Can't deploy | The deploy workflow refuses any branch but `menapoly-cue-2.0`, and so does the `menapoly-cue-pilot` environment's branch rule | `.github/workflows/pilot.yml`, GH-2 settings |
| Separate code | Everything lives in `studio-preview/`; `cloud/control-plane` and `cloud/web` are unchanged | `git diff menapoly-cue-2.0 --stat` |
| No production access | The preview has no `fetch`, XHR, WebSocket or beacon calls, and no production URL. A test records every request and fails on any host but the local server (Google Fonts allowed) | `isolation` test, `grep` |
| No production data | Fictional fixtures (`studio-preview/js/data.js`) and synthetic clips made by `tools/make_media.sh` | source |
| Queued jobs and Mac worker | The preview has no job queue and no worker protocol. The three queued production jobs and the Mac worker are never contacted | source, isolation test |
| State | Stored only in the viewer's browser (`localStorage`); **Settings → Reset demo data** restores the fixtures | source |
| Hosting | A private claude.ai artifact (static files), with no Cloudflare resources | artifact |

## Phase B: design system

- **Palette:** midnight ground `#090B17`, raised night `#10132B`, surfaces `#161A37` to `#2A3060`; signature purple
  `#8F6DFF` and `#A88CFF`, lavender `#D2C4FF`. Semantic colours: ok `#45D19F`, warn `#F4C35A`, danger `#FF8A98`,
  info `#7CC3FF`. Fictional and simulated markers use amber with a dashed outline.
- **Type:** Bricolage Grotesque for display, Figtree for text, JetBrains Mono for timecodes.
- **Shape:** 20 px cards, 14 px media, 12 px controls. Every touch target is at least 44 px on touch screens (tested).
- **The Cue mark:** a conic purple-to-sky gradient tile with a spark. Maven artwork isn't in this repository; approved
  Maven assets can replace the assistant mark once you share them.

**Navigation:**

| Phone (360–430 px) | Desktop (≥ 1024 px) |
|---|---|
| Fixed bottom bar: Home · Studio · Review · Ask Cue · More | Left rail grouped as Workspace / Resources / Menapoly |
| More: Social Sharing, AI Visibility, Library, Coaching, Inbox, Clients and Team (admin), Settings | Inline search in the header |
| Header: search, inbox, role chip | |

Each view is a plain link (`#review-rv_launch`), so the back button and deep links work.

## What's implemented, simulated or future

| Area | In the preview | Simulated | Future (needs the server) |
|---|---|---|---|
| Home feed, search, tabs, comments, saves | ✅ | | live activity stream |
| Library: folders, tags, filters, move | ✅ | upload (name and size only) | R2 multipart (exists in the pilot) |
| Editing requests: 10 types, briefs, assignment, progress, revision limits | ✅ | | job creation to the engine |
| Review: frame annotations (box and draw), threads, resolve, versions, compare, approve, request changes, audit | ✅ | new version upload | real uploads and renders |
| Export presets and delivery | | ✅ labelled | Mac or cloud render |
| Social Sharing: drafts, per-channel captions, approval, calendar, reuse ideas | ✅ | prepare-to-schedule | network connections (not built) |
| Coaching: tracks, lessons, progress | ✅ | | content management |
| AI Visibility: 8 modules, date filter, plan gating, methodology notes | ✅ **fictional data** | | data sources (see the plan) |
| Ask Cue: deterministic answers, approval-gated proposals | ✅ | | Claude provider through the server |
| Roles: admin, two clients, two editors | ✅ rules in `policy.js` | enforced in the browser | **the same rules in the Worker** |
| Downloads | | off (the artifact frame blocks them) | signed links |

## Test results (2026-10-25)

| Suite | Result |
|---|---|
| `node --test studio-preview/tests/*.test.mjs`: authorization rules (tenant isolation, assignments, approvals, entitlements, deny-by-default) | **10 / 10 passed** |
| `npx playwright test -c playwright.studio.config.ts`: 13 interactive tests × Android 360, Android 430, desktop 1440 | **39 / 39 passed** |
| `npx tsc --noEmit` (frontend, includes the new spec) | clean |

What the Playwright tests cover:
- navigation and the back button, and no sideways scroll on any view;
- touch targets of at least 44 px on phones, accessible names on every control, alt text on images;
- search respecting access; folders and filters; empty states; simulated upload, including rejecting a file type;
- request drafts that survive a reload, validation, and submission;
- annotation with a drawn box that persists across reloads, replies, resolve, audit trail, and compare;
- the request-changes → new version → approve → Channel Media flow;
- denial for the wrong role or client;
- visibility filters, modules and plan gating;
- Ask Cue proposals acting only after approval;
- social draft, approve and prepare; coaching progress; the error state and the 404 view;
- network isolation.

Screenshots: `docs/studio/screenshots/{android-360,android-430,desktop-1440}/`.

Not run: a real Android phone (yours) and real video playback. Playwright's Chromium lacks H.264, which Chrome on
Android has.
