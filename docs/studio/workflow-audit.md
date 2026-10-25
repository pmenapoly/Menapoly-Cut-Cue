# Workflow audit: request to growth (Studio preview)

This audits branch `menapoly-cue-studio-preview` at commit `1c8575d`, using fictional data and synthetic clips.

**Method:**
- I read `js/service.js`, `js/policy.js` and the views.
- I ran a probe (Playwright calling the preview's own service layer in the browser; nothing external) for the
  claims marked *probe*.
- I used the 77 existing browser tests for the claims marked *test*.

**Classifications:** **Verified** (implemented and verified) · **Incomplete** (implemented but incomplete) ·
**Simulated** · **Missing** (not implemented).

## Gap matrix: before this round

| # | Step | Status | Evidence and gap |
|---|---|---|---|
| 1 | Client uploads footage | Simulated | Library upload keeps only the name, size and type; nothing leaves the device (*test*) |
| 2 | Client creates an editing request | Incomplete | Form, validation and the saved draft work (*test*). **Uploaded footage can't be attached** (`assetIds` is always empty, *probe*) |
| 3 | Template or own instructions | Verified | "Start from a template" and "Use for a new request" (*test*) |
| 4 | Administrator reviews the request | Incomplete | Visible in the Project Workspace. There's no admin queue of new or unassigned requests, and no workload or deadline view |
| 5 | Administrator assigns an editor | Verified | Admin only, by policy (*test*) |
| 6 | Editor receives the assignment | Verified | Notification to the editor (*probe*) |
| 7 | Editor reviews brief and checklist | Missing for new requests | **A new request never gets an Editing Room, so it has no checklist or instructions page** (*probe*: no video created). Only seeded videos have one |
| 8 | Editor submits an edited version | Simulated, seeded videos only | Reuses a demo clip and is labelled simulated. Impossible for new requests (see 7) |
| 9 | Client gets a review notification | Verified | `uploadVersion` notifies the workspace's clients |
| 10 | Client plays the video and adds timestamped feedback | Verified | Real VP9 playback and comments (*test*) |
| 11 | Frame annotation | Verified | Box and freehand (*test*) |
| 12 | Client requests changes | Incomplete | Works (*test*). **No stale-state guard:** changes can be requested on an already approved video (*probe*) |
| 13 | Editor receives and resolves feedback | Incomplete | The "Changes requested" notification works. **Individual comments, replies and resolutions notify no one** (*probe*). Resolve works (*test*) |
| 14 | Editor submits a new version | Simulated | As step 8 |
| 15 | Client compares versions | Verified | Side-by-side sheet (*test*) |
| 16 | Client approves | Incomplete | Works (*test*). **A second approval is accepted, and there's no check that the client approved the latest version** (*probe*). Double clicks can send twice |
| 17 | Approved video available for reuse | Verified | The approved file is marked shareable; "Add to sharing library" |
| 18 | "Make more from this video" | Incomplete | Creates a request, but that request has the same gap as step 7 and isn't in the activity log |
| 19 | Maven prepares repurposing suggestions | Simulated (deterministic) | Room prompts give one suggestion each. Home's "Repurposing ideas" lists files with no actionable proposals |
| 20 | Client approves selected suggestions | Incomplete | Only one proposal per answer; no choosing among several |
| 21 | New requests or drafts are created | Incomplete | Approval runs the real service call, but the new requests hit the gap in step 7 |
| 22 | Approved content prepared for Social Sharing | Simulated | Draft, send for approval, approve, "Ready to schedule (simulated)". Publishing isn't implemented (by design) |
| 23 | Activity and notifications reflect the workflow | Incomplete | Only admins see the audit log. **There's no per-project activity**, several steps aren't logged, and notifications are missing for comments, replies, editing starting and approvals (to admins) |

**Reliability probe:**
- Duplicate request submissions are accepted.
- Cross-workspace video and file access is denied (403).
- Clients can't read the global audit log (correct).

**Maven:** it knows the open video only. It doesn't use the person's role, the current project, unresolved feedback,
next steps or AI Visibility context beyond one summary sentence, and it doesn't help with navigation.

**Content growth:** the steps exist, but nothing shows the person what exists, what's approved, what's only a draft
and what hasn't been published.

## Priorities (impact × risk)

| Priority | Improvement | User impact | Risk |
|---|---|---|---|
| P1 | Every request gets its own Editing Room (instructions from the brief, checklist from the template or defaults, attached footage); a single production status | Closes steps 7, 8, 14, 18 and 21 | Low: the service layer and views only |
| P1 | Footage can be attached to a request | Step 2 | Low |
| P1 | Stale and duplicate safeguards: approval of the latest version only, no decisions on settled videos, idempotent request submission, busy buttons | Steps 12 and 16, plus reliability | Low |
| P2 | Notifications and activity: comments, replies, resolutions, editing started, approvals and requests reach the right people; per-project Activity | Steps 13 and 23 | Low |
| P2 | Admin production board: new and unassigned requests, editor workload, deadlines and overdue items; editor "My queue" | Steps 4 and 6 | Low |
| P2 | Maven: role and screen aware, unresolved feedback, next steps, navigation help, accurate AI Visibility explanations, several repurposing suggestions each approved separately | Steps 19 and 20, Phase 2 | Medium: deterministic rules only |
| P3 | A content pipeline summary (exists → approved → in the sharing library → drafts → awaiting approval → ready to schedule, simulated → published: none) | Phase 4 | Low |

## Implementation sequence

1. Service: request lifecycle (request → video and review), footage attachment, status transitions, safeguards,
   notifications and project activity.
2. Views: request form footage picker, Project Workspace activity and request-to-room links, admin production board,
   editor queue, busy buttons.
3. Maven: a context-aware assistant (role, screen, project, video, visibility), with several suggestions approved
   separately.
4. Content pipeline summary on Social Sharing and the Library.
5. Tests: a 23-step end-to-end workflow spec and a reliability spec. Re-run the authorization, browser, axe and
   visual checks.

---

## After this round

`frontend/e2e-studio/workflow.spec.ts` runs all 23 steps through the interface as four fictional people: Jordan
(client), Avery (admin), Mika (editor) and Priya (another client, used as the isolation check). It passed **23/23 on
Android 430 and on desktop 1440**. The per-step record is in `workflow-results/`.

| # | Step | Before | Now | What makes it work (and what's still simulated) |
|---|---|---|---|---|
| 1 | Client uploads footage | Simulated | Simulated, verified | Library upload: only the name, size and type are kept |
| 2 | Client creates a request | Incomplete | **Verified** | Footage picker. A double tap creates one request (draft key) |
| 3 | Template or instructions | Verified | Verified | The template's checklist and look/sound/captions go into the new Editing Room |
| 4 | Admin reviews the request | Incomplete | **Verified** | Notification links to the **Production board**; "Needs an editor" lane; workload and overdue counts |
| 5 | Admin assigns an editor | Verified | Verified | From the board, the Editing Room or the Project Workspace. The editor and the requester are both told |
| 6 | Editor receives the assignment | Verified | Verified | The notification opens the Editing Room; "My queue" in Studio |
| 7 | Editor reviews brief and checklist | Missing | **Verified** | Every request now has an Editing Room; checklist tasks are owned by the assigned editor |
| 8 | Editor submits a version | Simulated (seeded only) | Simulated, verified | "Start editing" then "Upload new version". The version reuses a synthetic clip and is labelled simulated |
| 9 | Client review notification | Verified | Verified | "Version N of … is ready for your review" opens the room |
| 10 | Playback and timestamped feedback | Verified | Verified | Real playback of the synthetic clip |
| 11 | Frame annotation | Verified | Verified | Box saved with the comment |
| 12 | Request changes | Incomplete | **Verified** | Refused once the video is settled, or when a newer version exists (409) |
| 13 | Editor receives and resolves feedback | Incomplete | **Verified** | Notifications for each comment, reply, resolve and change request |
| 14 | New version | Simulated | Simulated, verified | "Start the changes" then upload (status shows "Being edited" while reworking) |
| 15 | Compare versions | Verified | Verified | |
| 16 | Client approves | Incomplete | **Verified** | Only the version on screen; a second or stale approval gets 409; single-shot buttons |
| 17 | Available for reuse | Verified | **Verified (new requests too)** | Each submitted version is a deliverable file; approval makes it shareable |
| 18 | Make more from this video | Incomplete | **Verified** | Creates a request with its own Editing Room, carrying the source video's brand and look |
| 19 | Maven repurposing suggestions | Simulated | Simulated (deterministic), verified | Up to three separate proposals per approved video, from its brief and formats; no video analysis |
| 20 | Approve selected suggestions | Incomplete | **Verified** | Each proposal is approved or declined on its own |
| 21 | Requests or drafts created | Incomplete | **Verified** | Approval runs the same authorized service call |
| 22 | Social Sharing preparation | Simulated | Simulated, verified | Draft → approval → "Ready to schedule (simulated)". The pipeline shows **Published: 0** |
| 23 | Activity and notifications | Incomplete | **Verified** | Per-project Activity; targeted notifications; nothing reaches another workspace |

### New in this round

- **Request lifecycle** (service):
  - A request creates its Editing Room: instructions, checklist, and attached footage when playable.
  - Status changes are validated: start only from Assigned or Revision; nothing after approval.
  - Each version becomes a deliverable file.
- **Safeguards:**
  - Request submission is idempotent per draft key.
  - Approving a Maven proposal can't run twice.
  - Decisions are refused on a stale version or a settled video.
  - Buttons are single-shot.
  - Other tabs' changes reload, with the note "Updated with changes from another tab".
  - Unsent feedback and change requests survive navigation and reloads.
- **Production management:**
  - **Production board** for admins: stages, editor workload, overdue items. **My queue** for editors.
  - Admin Home shows requests needing an editor.
  - Assign or start directly from the Editing Room.
  - Due dates in the room header.
  - "No editor yet" and "Nothing to play yet" states that invent nothing.
- **Notifications:** to the assigned editor, the requester, clients, admins and comment authors; never to yourself or
  other workspaces.
- **Activity:** each project's activity lists requests, assignments, starts, versions, feedback, resolutions,
  decisions and approvals.
- **Maven:**
  - Knows the signed-in person and role, and the screen (video, project, AI Visibility, elsewhere).
  - Summarises unresolved feedback.
  - Suggests next steps for that role, from live demo records.
  - Drafts editing requests as proposals.
  - Offers several repurposing suggestions, each approved separately.
  - Gives navigation help with links.
  - Explains AI Visibility metrics with their definitions and the FICTIONAL DEMO DATA label, respecting the plan.
  - Each answer is labelled Information, Recommendation, Draft or Proposed action.
- **Content growth:** Social Sharing opens with a **content pipeline**: In production → Approved videos → Ready to
  reuse → Post drafts → Prepared posts → Published (always 0, "publishing isn't connected in the preview").

### Remaining gaps (preview)

- Uploads, renders and versions are simulated. A version reuses a synthetic clip. Uploaded files can't play.
- Maven follows deterministic rules. It can't watch videos, and it only knows the records your role can see.
- No real publishing or scheduling; no email or push notifications (in-app only).
- An admin override for an extra revision round isn't built. Changing due dates after submission isn't built.
- A client can approve a social draft without first sending it for approval (a shortcut kept from the earlier preview).
- Cross-tab syncing only works between tabs of one browser on one device.

## Production-readiness blockers (backend requirements for a real-client launch)

Everything above runs in the browser. **The role checks in `policy.js` and `service.js` are frontend checks on a
mock**: anyone with developer tools can change local state. None of it is server authorization. Before any real
client uses this:

1. **Enforce on the server:** port `policy.js` to the Worker, deny by default, on every route. Tenancy
   (`workspace_id`) belongs on every table. The role comes from the Access JWT and the allowlist, never from the
   client.
2. **Persist the request lifecycle:** D1 migrations for `videos`, `checklist_tasks`, `annotations`, `templates` (see
   [editing-room.md](editing-room.md)), plus `requests.idempotency_key`, `requests.template_id`, `request_assets`,
   `versions.asset_id`, and `activity.project_id`.
3. **Concurrency:** decisions carry `expected_version`, and the server returns 409 when it's stale. A state machine
   allows only valid status changes. Idempotency keys apply to every create.
4. **Media:** private R2 with short-lived presigned URLs, checked against the same policy. The preview's synthetic
   clips are static files anyone can fetch. That's acceptable for fictional media, never for client footage.
5. **Uploads and renders:** resumable uploads with type and size validation (and virus scanning), and real versions
   from the Mac worker. Results only come from what a worker reported.
6. **Notifications:** server-side fan-out with the same targeting rules (tested), an in-app inbox, and email through
   the existing mailer.
7. **Activity:** an append-only, per-project audit log, written by the server.
8. **AI:** a server-side model that reads through tools scoped to the person's role. It may only propose; actions run
   through the existing approval endpoint.
9. **Growth:** social publishing via OAuth integrations with an approval gate. AI Visibility from connected
   sources, with provenance; fictional numbers never reach a real client.
10. **Operations:** rate limits, backups and restore, plus axe and visual checks in CI.

## Confirmation

- The work is on `menapoly-cue-studio-preview` only: `studio-preview/`, `frontend/e2e-studio/` and `docs/studio/`.
- The production Worker, the three queued jobs, Cloudflare and Access, Relay, Growth Loop, DNS, credentials, billing
  and the Mac worker were not touched.
- No production calls were made. Only fictional data was used.
