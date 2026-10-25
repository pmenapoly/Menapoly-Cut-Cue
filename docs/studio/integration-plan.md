# Phase E: integrating Studio into the Cue pilot (proposal; nothing done)

The goal: reuse the pilot's verified pieces (Access, the Worker API, private R2, Queues, the Mac worker) and add what
the Studio needs, in an order where **no client is invited before tenant isolation is enforced on the server**.
Every step below is a separate pull request into `menapoly-cue-2.0` with tests. Every deploy is the existing manual,
owner-approved workflow.

## Step 1: tenancy and roles in the Worker (blocking; nothing else ships to clients before it)
- Migration `0004`: `workspaces`, `memberships (workspace_id, email, role: admin|client|editor)`,
  `project_assignments (project_id, email)`, `projects.workspace_id` (backfilled to one "Menapoly" workspace, so the
  three queued jobs and all existing records keep working unchanged).
- Port `studio-preview/js/policy.js` to `src/policy.ts` and call it in every route, replacing the owner/editor
  allowlist. It stays deny-by-default. Admins are the `OWNER_EMAILS`; others come from memberships.
- Port the policy tests to the Worker: every list and get filtered by workspace and assignment, plus the existing
  "every route refuses without Access" test extended with a *wrong tenant* case.
- Access: no change to the policies you set up. People still sign in through the same app, with the allowlist
  widened by email when you invite someone.

## Step 2: Studio data on the existing API
- `folders`, `asset_tags`, `assets.channel` (approved for sharing).
- `edit_requests` (type, brief, aspect, length, due, revision limit and used). Jobs keep the engine contract.
- `annotations (version_id, t, shape_json, body, resolved)` and `annotation_replies`, with the audit log written on
  each change.
- `feed_items` derived from audit events, plus comments and saves.
- Each new route goes through `policy.ts`, validated input, rate limits and idempotency keys, as today.

## Step 3: replace `cloud/web` with the Studio UI
- Swap the fixture service (`studio-preview/js/service.js`) for API calls with the same method names. The views
  don't change.
- Keep the pilot's resumable R2 upload (`cloud/web/upload.js`) in place of the simulated upload.
- Media plays from 10-minute signed links. Downloads use signed links with `Content-Disposition`.

## Step 4: processing
- Editing requests create jobs. The existing Mac worker (once you choose to connect it) or a later cloud worker
  processes them. Renders are only reported from real worker results; the preview's "simulated" labels go away only
  where real processing exists.

## Step 5: optional modules, behind entitlements (feature flags per workspace plan)
- **Social Sharing:** drafts and approvals are server records. Platform connections are a separate, later decision:
  each network's API terms, OAuth app review and per-client authorization. Nothing posts without an explicit
  approval.
- **Coaching:** lessons are stored as content records with progress per member.
- **AI Visibility:** a scheduled prompt panel per workspace, storing the prompt, assistant, answer, cited URLs and
  timestamp, plus read-only analytics and social grants per client. Every chart shows its source, timestamp and
  calculation. No number is shown that wasn't measured.
- **Ask Cue:** a server-side provider adapter (Claude through the Anthropic API) that runs with the signed-in
  person's permissions, may only return proposals, and is metered per workspace. It needs your approval and an API
  key stored as a Worker secret.

## Approvals this plan will need (later, one at a time)
1. Merging each step's pull request into `menapoly-cue-2.0`.
2. Each deploy run (the existing workflow).
3. Inviting the first client (after step 1 is deployed and verified).
4. Any paid service: Claude API usage, analytics or social APIs, Workers Paid if CPU limits are reached.
5. Connecting the Mac worker.
