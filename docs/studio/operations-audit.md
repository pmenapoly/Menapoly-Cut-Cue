# Production operations audit: social approvals, revision allowances, deadlines

This audits the Studio preview at commit `22f978e`, using fictional data. It covers three areas: social approvals,
revision allowances and deadlines.

## 1. Social content approval

**Today:**
- Statuses are `Draft` → `Awaiting approval` → `Approved` → `Ready to schedule (simulated)`.
- Data is `posts[] { id, ws, assetId, status, by, at, captions, platforms, scheduledFor, history[] }`.

**Gaps:**
- **Approval doesn't require submission.** `approvePost` accepts a `Draft`, and the interface offers Approve on
  drafts.
- **Anyone who can draft can approve, including their own post.** There's no separate reviewer role.
- **No "changes requested".** No reviewer comments, and no resubmission cycle.
- **No notifications** for any post event.
- **No stale or duplicate protection.** Approve runs in any status, and editing captions after approval keeps the
  approval.
- **Roles aren't shown.** The interface doesn't show the content owner, creator or reviewer, and history entries
  carry no comments.
- **Publishing:** nothing claims "Published" today. That must stay true.

## 2. Revision allowances

**Today:**
- `project.revisionLimit` (Spring Launch 3, Brew Tips 2, Harborline 2) and `request.revisionsUsed`.
- `decide("changes")` adds 1 and refuses once `used ≥ limit`.

**Gaps:**
- **Allowances can't be set by plan or workspace**, only hard-coded per project.
- **Usage is a bare counter.** It doesn't record which version and decision used a round.
- **No duplicate-charge protection** beyond the review-status check.
- **No administrator override:** no extra rounds with a reason, approver and timestamp, so a request at its limit is
  stuck.
- **Included and additional rounds aren't distinguished.** Remaining rounds aren't shown.
- **No migration path.** Existing usage needs to carry over without blocking in-progress work.

## 3. Deadlines and workload

**Today:**
- `request.due` is set on creation.
- The board shows overdue items and an editor workload of open and overdue counts.
- The room header shows "Due …".

**Gaps:**
- **No way to change a date.** There's no date history, no notification and no activity entry.
- **No "at risk" state.**
- **Dates read as guarantees** ("Due"), not estimates.
- **No stale-update protection** for date changes.

## Implementation plan (smallest coherent changes)

| Area | Data | Service | Interface |
|---|---|---|---|
| Social approval | `post.rev`, `createdBy`, `submittedBy`, `reviewerId`, `history[] { action, note, rev }` | `submitPost`, `reviewPost(approve or changes, note, expectedRev)`, `preparePost`. Editing returns an approved or submitted post to Draft (`rev + 1`). Reviewers are the workspace's clients and admins, never the submitter. Notifications go to reviewers, the creator and admins | Status chip, creator/reviewer/owner line, Submit, Approve / Request changes (comment required), history with comments, Prepared for publishing (simulated) |
| Revision allowances | `PLANS[plan].revisionsIncluded`; optional `workspace.revisionsIncluded` and `project.revisionLimit` overrides; `review.rounds[] { version, at, by, note }`; `review.extraRounds[] { id, rounds, reason, by, at }`; `review.extraAsks[]` | `allowance(review)`. A change request adds one round per version (duplicate → 409). `grantExtraRound(rid, reason)` is admin only; `askExtraRound(rid, note)` is client | Room status card: included · additional · used · remaining; "Ask for an extra round" (client) and "Approve an extra round" (admin, reason required); history |
| Deadlines | `request.dueRev`, `request.dueHistory[] { from, to, by, at, reason }` | `setDue(rid, date, reason, expectedRev)`, admin only (409 when stale). Activity and notifications go to the editor and requester. `atRisk` = due within 3 days and not yet with the client or approved | Board: "Change target date" and at-risk highlights. Room and project: "Target delivery … (estimate)" and the date history |
| Migration | Seed version 6; `load()` migrates a version 5 state | Posts are mapped to the new statuses. `revisionsUsed` becomes rounds. Usage above the new allowance is covered by a recorded carry-over grant, so nothing in progress is blocked | — |

---

## After this round

### Social approval lifecycle

The lifecycle is **Draft → Submitted → Changes requested or Approved → Prepared for publishing (simulated)**.

- **Roles shown on each post:** owner (workspace), creator, submitter and reviewer, plus the revision number.
- **Review rules:**
  - Approval requires a submitted post.
  - Reviewers are the workspace's clients and Menapoly admins, never the submitter (403). Editors never review.
  - Requesting changes needs a comment, which stays on record. The author revises (revision + 1) and resubmits.
  - Editing a submitted or approved post sends it back to Draft, because approval covers exact text.
- **Safeguards:** decisions check the revision and status, so a stale or repeated approval, resubmission or
  preparation gets 409.
- **Notifications:**
  - On submission: reviewers.
  - On changes requested: the author.
  - On approval: the author and admins.
  - On preparation: the author.
- **Publishing:** there is no "Published" status. The pipeline's Published count is always 0, and prepared posts say
  "Not published: no social account is connected".

### Revision allowances

- **Configuration:** included rounds per video come from the plan (Essentials 2, Growth 3). A workspace or project
  override is optional; Brew Tips keeps its contracted 2.
- **Counting:**
  - A round is one formal change request against a submitted version. Comments never count.
  - Each video keeps a ledger, so a second request on the same version is refused and not charged.
  - The room shows used, total, included (and where that number comes from), additional and remaining.
  - Once the rounds run out, "Request changes" is disabled and the client can **ask for an extra round**.
- **Administrator overrides:** **Approve an extra round** requires a reason. It records the approver, time and
  adjustment; a stale approval gets 409; the client, editor and requester are told. Rounds taken from the additional
  allowance are marked "additional". There is no billing.
- **Migration:** a saved demo from the previous version (5) is migrated, not wiped:
  - Post statuses map to the new ones.
  - Project limits become contracted overrides.
  - Counted revisions become ledger rounds.
  - Usage above the new allowance becomes a visible, recorded carry-over grant.
  - Remaining rounds match the old rules, so nothing in progress is blocked silently.

### Target dates and workload

- **Changing dates:** admins change target dates from the production board, the Editing Room or the Project
  Workspace, with a reason.
  - Each change bumps `dueRev`; a save based on an older revision gets 409 rather than overwriting.
  - Changes are listed in the date history and the project activity.
  - The assigned editor, the requester and the workspace's clients are told.
- **Labels:** dates read "Target … (estimate)" everywhere clients see them.
- **Board:**
  - Overdue (past target) and **at risk** (target within 3 days and not yet with the client) highlights.
  - Editor workload shows open, overdue and at-risk counts, plus Behind / Busy / Has room.
  - Revision usage on every row.

### Integrity fixes found while testing

- **Actions were credited to the wrong person.** If the demo role was switched while a call was in flight, the
  action was recorded as the new person. Calls are now bound to the person who started them, as a server would.
- **A missing value showed as the text "null"** in a few optional parts of the interface (for example the room's
  status card when no rounds are left). Fixed in the toolkit, and the layout sweep now fails on any printed
  null/undefined/NaN.
- **Duplicate notifications:** a person in two target groups now gets one notification, not two.

### Results

| Check | Result |
|---|---|
| Authorization rules (`node --test`) | **18/18 passed** (3 new: social review, revision rounds, target dates) |
| Browser tests (`npx playwright test -c playwright.studio.config.ts`) | **99 passed, 0 failed, 15 skipped by design** in the final full run (the workflow, reliability and operations specs run at 430 and 1440) |
| New `operations.spec.ts` (Android 430 and desktop 1440) | **10/10 passed:** social review cycle; revision rounds through exhaustion and override; target dates; workload; migration |
| 23-step `workflow.spec.ts` | 23/23 on Android 430 and desktop 1440 (step 22 now: submit → another reviewer approves → prepared) |
| Accessibility (axe, WCAG 2.1 AA) | No violations on the major screens, the production board, the request form, Social Sharing and the Maven sheet |
| Layout sweep at 360–1440 px | Passed, including the new null/undefined check |
| Visual baselines | Two refreshed for intended changes (the revision panel and "Target … (estimate)" in the Editing Room) |
| `npx tsc --noEmit` | Clean |

Two existing tests changed on purpose. Both assumed a client could approve the post they had just submitted; that is
now refused by design.

### Remaining limitations

- **Browser-only enforcement:** every rule here runs in the browser against a mock. It isn't security.
- **Publishing:** no social account is connected, so "Prepared for publishing" is a label and Published is always 0.
- **Billing:** extra rounds are recorded but nothing is invoiced, by design.
- **Fixed settings:**
  - The at-risk window is fixed at 3 days.
  - Plan allowances are constants in `policy.js`, with no settings screen.
  - Only one extra round can be approved at a time from the interface (the service accepts 1–3).
- **Cross-tab sync** covers tabs in one browser only.
- **Single reviewer:** a workspace with one client and no admin available can't approve that client's own posts.
  That's intended separation of duties, but Menapoly may want a "self-approval allowed" workspace setting.

## Backend contracts for production

**Identity and permissions:**
- Identity comes from the Access JWT per request, never from the client.
- Every route enforces the ported `policy.js` actions: `post.review`, `post.prepare`, `revision.ask`,
  `revision.grant`, `request.schedule`.

```sql
-- plans & overrides
plans(id PK, label, revisions_included INT NOT NULL)
workspaces.revisions_included INT NULL      -- override
projects.revisions_included INT NULL        -- contracted override (most specific wins)

-- revision ledger: one round per (review, version); duplicates are impossible by constraint
revision_rounds(id PK, review_id, version INT NOT NULL, kind TEXT CHECK(kind IN ('included','additional')),
                decision_id, by, at, note, UNIQUE(review_id, version))
revision_grants(id PK, review_id, rounds INT CHECK(rounds BETWEEN 1 AND 3), reason TEXT NOT NULL, approved_by, at)
revision_asks(id PK, review_id, by, at, note, status CHECK(status IN ('open','granted','declined')))

-- social review
social_posts(id PK, workspace_id, asset_id, status CHECK(status IN ('draft','submitted','changes_requested','approved','prepared','published')),
             rev INT, created_by, submitted_by, reviewer_id, captions_json, platforms, scheduled_for, updated_at)
social_post_events(id PK, post_id, rev, action, note, by, at)          -- append-only history
-- 'published' may be set only by a verified callback from a connected publishing integration (provider post id stored)

-- target dates
requests.target_date DATE, requests.target_rev INT DEFAULT 0
request_date_changes(id PK, request_id, from_date, to_date, reason, by, at)
```

```
POST  /v1/posts/:id/submit            { expected_rev }                 post.edit     → 409 stale/status
POST  /v1/posts/:id/review            { decision, note, expected_rev } post.review   → 403 self-review, 409 stale/status, 400 note missing
PUT   /v1/posts/:id                   { captions, … }                  post.edit     → rev+1; submitted/approved → draft
POST  /v1/posts/:id/prepare                                            post.prepare  → 409 unless approved
POST  /v1/versions/:id/decision       { decision, note, expected_version }  review.decide → 409 stale, duplicate round, or allowance used
POST  /v1/reviews/:id/extra-round-asks { note }                        revision.ask
POST  /v1/reviews/:id/extra-rounds    { rounds, reason, expected_total } revision.grant → 400 no reason, 409 stale
PATCH /v1/requests/:id/target-date    { date, reason, expected_rev }   request.schedule → 409 stale
```

**Behaviour the server must guarantee:**
- Each decision and its ledger insert run in one transaction.
- Notifications fan out on the server, de-duplicated per person, using the targeting rules above.
- Every change writes an append-only activity row with `project_id`.
