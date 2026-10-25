# Menapoly Cut Cue — notes for Claude Code

Private single-user conversational video editor. Product name is always "Menapoly Cut Cue".
Original briefs: docs/brief/CLAUDE_FAST_TRACK.md (priorities) and docs/brief/CLAUDE_PHASE2.md (architecture).

- Commands: `make setup`, `make dev`, `make start`, `make test`, `make check`.
- Backend: backend/cutcue (FastAPI + SQLite). Add schema changes as a new entry in `db.MIGRATIONS`; never edit old ones.
- Frontend: frontend (Next.js 15, static export). Run `npx tsc --noEmit` and `npm run build` after changes.
- Tests use the `fixture` transcriber with synthesized speech (scripts/make_fixture.py) and do real FFmpeg renders.
- Rules: never invent timestamps, transcripts, renders or third-party endpoints. Every AI edit goes through
  `Services.create_proposal` (validated) and needs explicit user approval. No `shell=True`. Keep Intel macOS
  compatibility (CPU fallbacks, no Apple Silicon-only deps). Cloud stays opt-in per project.
- Feature modules: audio.py (enhancement chain, loudness, alignment), diarize.py (speakers), podcast.py (auto-editor),
  moments.py (clip factory scoring), brief.py (brief extraction + compliance). Services wire them into proposals.
- Fixture speech is band-limited below 3.8 kHz so tones above 5 kHz can measure music/markers in tests.
- scripts/validate.py is the Mac real-world harness: keep every new feature represented there, and never report PASS
  for something that did not really run.
- Menapoly Cue 2.0 layer (branch menapoly-cue-2.0): cue.py (clients, status, notifications, review/upload links,
  approval-gated cue_actions), ask.py (Ask Cue: read tools + propose_action only), text.py (Cue Text intake; never sends),
  cue_api.py (/api/cue, token-scoped /api/public, versioned /api/v1). Shell UI: components/shell.tsx, cue.tsx,
  ProjectDetails.tsx; pages /, /projects, /cut, /inbox, /library, /settings, /review, /upload, /gallery.
  Never execute an action without Cue.approve_action; never show invented percentages in Cue surfaces. Docs: docs/cue2/.
- Production round: relay.py (Relay connector: approval-gated publish_to_relay, idempotent by deterministic file name),
  mailer.py (SMTP email outbox, one email per notification), backup.py (checksummed backup/restore; restore moves data
  aside). Harness statuses: VERIFIED / FAILED / NEEDS REVIEW / SKIPPED / BLOCKED. Shortcuts live in frontend/lib/shortcuts.ts.
- Hybrid cloud (docs/cloud/): cloud/control-plane (Cloudflare Worker, TS: D1 metadata, presigned S3/R2 URLs only, never
  proxies media, Access JWT + allowlists, worker bearer tokens, hashed review tokens; schema changes = new migration file),
  cloud/web (plain-JS PWA, no build), backend/cutcue/agent.py (outbound-only Mac worker; own data dir; AI edits go
  through create_proposal and stay proposed until approved in the cloud). Tests: tests/test_cloud_e2e.py and
  `make cloud-ui-test` (wrangler dev + moto via scripts/cloud_stack.py), `make cloud-check`. Never deploy, create
  Cloudflare resources, or enable CLOUD_RENDERING / PUBLIC_REVIEW without the owner's explicit approval. Pilot
  (cue.menapoly-digital.com): docs/cloud/pilot/ (APPROVAL-CHECKLIST.md), cloud/control-plane/pilot/ (read-only preflight,
  provision.sh that prints unless --execute), scripts/pilot_acceptance.py; test/config.test.mjs guards the pilot config.
- Phone-only pilot: cloud/control-plane/src/ask.ts (Ask Cue built-in planner: reads D1, proposes cue_actions; only
  POST /v1/actions/:id/approve acts), .github/workflows/pilot.yml (workflow_dispatch only, menapoly-cue-2.0 only, typed
  phrase, environment menapoly-cue-pilot, fail-closed preflight --ci, probe + auto-remove). Never add push/schedule
  triggers to it and never re-enable Relay's deploy workflows. Phone tests: `make cloud-ui-test` (android-375/430).
- Browser-first launch (docs/cloud/pilot/browser-first.md): cloud/web has Projects (dashboard counts), Ask Cue, Library
  (GET /v1/library), Inbox, Settings; project instructions (PUT /v1/projects/:id/instructions), edit requests
  (job params.request) and "request changes" (decision changes_requested + note queues a new auto_edit). Desktop
  sidebar at >= 960px. Playwright projects: android-375, android-430, desktop-1440. With no worker, jobs stay queued;
  never show progress or results a worker didn't report.
- Pilot address: PILOT_TARGET=workers-dev (pinned in pilot.yml): Worker on its workers.dev hostname behind Access
  self-hosted apps; no DNS change (menapoly-digital.com stays on Canva nameservers; moving them stops the Canva site).
  custom-domain stays in wrangler.jsonc for later. See docs/cloud/pilot/domain-options.md and LAUNCH-REQUEST.md.
- Studio preview (branch menapoly-cue-studio-preview, never deployed): studio-preview/ is a static, fixture-only app
  (fictional data, no network calls; service.js mocks the API, policy.js holds the role/tenant rules the Worker must
  adopt). Tests: `node --test studio-preview/tests/*.test.mjs`, `npx playwright test -c playwright.studio.config.ts`
  (android-360/430, desktop-1440). Docs: docs/studio/ (audit, design, integration-plan.md). Never point it at production.
- Studio Editing Room: js/views-room.js (Project Workspace #project-*, Editing Room #video-*), js/player.js (custom
  controls + annotation canvas), js/maven.js (header launcher, contextual proposals). No Coaching tab; Home = feed +
  announcements + 14-day spotlight + upload filters. Contract and real/simulated list: docs/studio/editing-room.md.
- Studio light design (docs/studio/light-design.md): tokens in studio-preview/styles.css (player is the only dark surface),
  statusInfo()/statusBadge() in js/ui.js; bar = Home/Studio/Review/AI Visibility/More. Design checks: e2e-studio/design.spec.ts
  (7-width layout sweep, axe WCAG AA, toHaveScreenshot baselines; update with --update-snapshots only for intended changes).
