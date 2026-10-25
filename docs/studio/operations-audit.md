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
