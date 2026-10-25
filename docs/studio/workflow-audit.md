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
