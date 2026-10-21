# Menapoly Cue 2.0 — feature-completion matrix (2026-10-14)

Legend:
- **Done**: implemented and covered by automated tests against the real backend.
- **Partial**: works, but with stated limits.
- **Simulated**: only a labelled simulator exists.
- **Not built**: not implemented.

"Verified on" is where it actually ran: this Linux container, with real FFmpeg 6.1 and Playwright Chromium. Nothing here was run on the Intel Mac, with live Claude, with Google Chrome, or with an SMS provider.

## Phase A — audit, architecture, design system, shell

| Item | Status | Evidence |
|---|---|---|
| Audit of Cut Cue and MenapolyRelay (verified branch) | Done | `audit.md`; Relay's 39 unit tests and typecheck were re-run here |
| Architecture and integration boundaries | Done | `architecture.md` |
| Design tokens (requested palette) plus accessible light theme | Done | `design-system.md`; `scripts/check_contrast.py` (58/58 AA); theme e2e test |
| Component library and gallery | Done | `/gallery/`; screenshots |
| Responsive docs; 375 / 430 / 768 / 1280 / 1440 checks | Done | `responsive.md`; `cue-shell.spec.ts` (overflow, navigation, names, target sizes) |
| App shell with 5 destinations plus Settings | Done | Sidebar, rail and bottom tabs; notification center; ⌘K search |

## Phase B — dashboard, projects, upload, brief, status

| Item | Status | Evidence |
|---|---|---|
| Home: priority actions, recent projects, review queue, processing | Done | `/api/cue/home`; `test_cue.py` |
| Projects: card, board and list views; search; client and stage filters; archive | Done | `cue-shell.spec.ts` |
| Client association | Done | `clients` table; project details "Add client" |
| Project details: overview, media, brief, edits, reviews, delivery | Done | `ProjectDetails.tsx`; e2e tests |
| Upload (chunked, resumable), phone upload links, media dedupe | Done | `test_upload_link_and_media_dedupe` (hard link verified by inode) |
| Plain-language status and failure explanations with Retry | Done | `test_ask_cue_local_answers_from_real_data` |
| No invented percentages in Cue 2.0 surfaces | Done | ProcessingList shows the stage message and elapsed time; the v1 job shape has no progress field |

## Phase C — Ask Cue and Cut Cue Simple

| Item | Status | Evidence |
|---|---|---|
| Ask Cue with typed read tools and `propose_action` only | Done (local planner); Claude path tested with a scripted fake | `test_ask_cue_claude_treats_documents_as_untrusted_and_only_proposes` |
| Live Claude for Ask Cue | **Not verified** | No API key in this environment. Harness step 13 checks it on the Mac. |
| Proposed vs. executed actions are visibly different | Done | ActionCard states; e2e test |
| Approval before client-facing, destructive, AI-cost or external actions (double confirm) | Done | e2e test (revision card) |
| Documents and transcripts treated as untrusted | Done | Prompt-injection test |
| Cut Cue Simple / Pro, proposals, preview, approve, real renders, version history | Done (built earlier, unchanged) | 16 earlier Playwright tests and 63 backend tests still pass |
| Versioned integration contract `/api/v1` | Done | `api-contract-v1.md`; `test_v1_contract` |

## Phase D — reviews, approvals, notifications

| Item | Status | Evidence |
|---|---|---|
| Client review links (hashed, expiring, revocable, byte-range streaming, optional download) | Done | `test_review_link_tokens_*`; e2e client flow in a separate browser context |
| Timecoded notes, approve, request changes; project stage follows | Done | `test_full_workflow_*` |
| Prepare a revision from open notes (approval-gated, uses Cut Cue's assistant) | Done (proposal); execution with live Claude **not verified** | Local mode would answer with its built-in planner |
| In-app notifications from real job events, deduplicated | Done | Notification tests; bell e2e test |
| Inbox: approvals, reviews, notifications, texts, activity | Done | e2e tests |
| Email notifications | Not built | — |

## Phase E — Cue Text

| Item | Status | Evidence |
|---|---|---|
| Webhook signature verification (Twilio format) | Partial | Tested with locally computed signatures only; no live provider |
| Approved senders with consent records; STOP / START / HELP | Done | `test_cue_text.py` |
| Dedupe on provider message ID; error recording with retry; audit history | Done | `test_cue_text.py` |
| Natural-language intake leading to proposals only | Done (keyword patterns) | `test_cue_text.py`; simulator e2e test |
| Photo and video attachments | Partial | Recorded only. Download needs provider credentials; the upload-link fallback works. |
| Sending replies, status notifications and review links by SMS | **Not built (deliberately)** | Replies are stored as `draft_not_sent`; `send_text` fails honestly |
| Dedicated number, A2P registration | Blocked | Needs your provider account and consent paperwork |

## Phase F — Pro, audio, clips, shortcuts, accessibility, performance

| Item | Status | Evidence |
|---|---|---|
| Cue Pro multitrack timeline, transcript editing | Done (earlier round) | `pro.spec.ts` |
| Advanced audio, Clip Factory, podcast auto-editor | Done (earlier round) | Backend tests; harness steps 9–11 |
| Keyboard shortcuts | Partial | Editor shortcuts (earlier); ⌘K search in the shell; no shortcut sheet in the shell yet |
| Accessibility: skip link, focus trap, named controls, AA contrast, reduced motion | Done | `a11y.spec.ts`, `cue-shell.spec.ts`, contrast script |
| Performance budget | Partial | Pages are 109–142 kB first-load JS (Next build output; the editor is the largest); no profiling on the Intel Mac |

## Not verified anywhere (needs your hardware or accounts)

- Intel Mac (macOS, VideoToolbox, real faster-whisper): run `make validate MEDIA=…` (steps 1–13).
- Live Claude for Ask Cue and Cut Cue: set `ANTHROPIC_API_KEY`.
- Google Chrome with H.264 playback: harness step 1. Playwright Chromium here has no H.264, so the review page's `<video>` was checked for presence, not for playback.
- Any SMS provider.
- MenapolyRelay connector: not built.

## Security and production-readiness sprint (2026-10-14, second round)

| Item | Status | Evidence |
|---|---|---|
| Relay authentication hardening | tracked in the private MenapolyRelay repository | — |
| Relay connector (approval-gated, idempotent, no duplicate projects, versions or copies) | Done | 6 failure-injection tests and 1 test **against the real Relay app** running locally |
| Relay service-token identity (allow-listed) and `add_project` returning its ID | Done on `feature/cue-connector`, not deployed | 2 tests; live Access service token **not verified** |
| Consistent project, asset and render identity across Projects, Cut Cue, v1, Library, reviews and delivery | Done | `test_identities_are_consistent_across_surfaces` |
| Email notifications over SMTP (renders, failures, review requests, client decisions, stage changes, portal) | Done | Real SMTP to a local test server; exactly-once; retry with backoff; background sender |
| In-app notifications for stage changes and review requests | Done | `test_notifications.py` |
| Database backup and restore (checksummed; restore moves old data aside) | Done | `test_backup.py`; harness step 16 VERIFIED here |
| Mac validation checklist and harness steps 14–18 with VERIFIED / FAILED / NEEDS REVIEW / SKIPPED / BLOCKED | Done | `mac-validation-checklist.md`; smoke run here |
| Searchable keyboard-shortcut guide (`?`) and G-then-letter navigation | Done | `cue-usability.spec.ts` |
| Usability fixes from the screenshot review (9 items) | Done | `usability-review.md` |
| SMS sending | Disabled (unchanged) | `send_text` fails honestly; drafts only |

## Secure launch preparation (2026-10-14, third round)

| Item | Status | Evidence |
|---|---|---|
| Relay production status and security patch | tracked in the private MenapolyRelay repository | — |
| Read-only security readiness CI (secret presence, lint, typecheck, tests, build, dry run) | Done | Green on the security, hotfix and connector branches |
| Connections page (ready / not set up / unavailable / awaiting authorization; no secrets) | Done | `/connections/`; `test_connections.py`; e2e test |
| First-run setup (computer, AI, privacy, email, backup, first project) | Done | `/setup/`; e2e test |
| End-to-end launch workflow (create → upload → AI edit → review → client approval → H.264/AAC exports → email → backup) | Done | `test_launch_workflow.py` |

## Private remote access: hybrid cloud + Intel Mac (2026-10-15, fourth round)

| Item | Status | Evidence |
|---|---|---|
| Phase 0 security gate (Relay deploy workflows) | Resolved 2026-10-20: both disabled (S1) | `docs/cloud/pilot/security-gate.md` |
| Versioned control-plane API (projects, assets, uploads, jobs, leases, events, versions, review links, notifications, workers, costs, audit) | Done, local | `cloud/control-plane`; `test_cloud_e2e.py` |
| Direct-to-R2 resumable multipart uploads (signed URLs, type/size/extension limits, SHA-256, resume, orphan cleanup) | Done, local (moto) | upload tests; phone test with dropped connection and closed tab |
| Mac worker agent (leases, verified inputs, real pipeline, progress, restart recovery, launchd) | Done (Linux-tested) | `backend/cutcue/agent.py`; crash-release and dead-letter tests; **Intel Mac run pending** |
| Phone workflow (create, upload, offline Mac → reconnect, approve, export, preview, download, client review, inbox) | Done, local | `frontend/e2e-cloud`; `docs/cloud/screenshots` |
| Access JWT verification, roles, no dev fallback in production | Done | `cloud/control-plane/test/access.test.ts`; production-mode e2e tests |
| Budget controls (cloud processing off, owner authorization, per-project budget, monthly costs) | Done | `docs/cloud/costs.md` |
| Deployment to Cloudflare | **Not done**, awaiting approval | `docs/cloud/setup.md` §3 |
| Private pilot preparation (cue.menapoly-digital.com): security gate analysis, Access design, read-only preflight, provisioning script, Mac/Android guides, acceptance test, exact charges, approval checklist | Prepared, **not executed** | `docs/cloud/pilot/APPROVAL-CHECKLIST.md` |

