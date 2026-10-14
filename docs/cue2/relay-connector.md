# Relay connector (publish to the client portal)

The connector publishes an approved Cut Cue render into a MenapolyRelay project (Menapoly Cue on Cloudflare) as a new review version.

- **Cut Cue side:** `backend/cutcue/relay.py` and migration 6.
- **Relay side:** branch `feature/cue-connector` in `pmenapoly/MenapolyRelay`, built on the security fix branch.

## Flow

```
Delivery tab → "Publish to client portal" → proposed action (Inbox → Approvals or inline card)
  → owner approves (second confirmation: "sends something outside the app")
  → Cue.approve_action → RelayConnector.publish(project, render)
      1. claim the (relay, workspace, render) publication row atomically — a second approval or retry can't run in parallel
      2. find or create the Relay project: linked id → else marker "cue-project:<id>" in description → else add_project
      3. if a version named cutcue-<render>-<sha256[:12]>.mp4 already exists there → mark published (reconciled), stop
      4. multipart upload in 8 MB parts streamed from the render file (each part retried up to 3x; same part number)
      5. complete → Relay creates version N (status in_review, notifies its approvers) → mark published
  → in-app (and email) notification "Published to the client portal" or "…failed" with the reason
```

## Guarantees

| Risk | Guarantee | Test |
|---|---|---|
| **Accidental publish** | Only from an approved action. Proposing does no network I/O. | `test_publish_requires_approval_and_is_idempotent` |
| **Duplicate version** after a lost response or retry | The deterministic file name is reconciled before every upload | `test_lost_response_after_commit_reconciles_instead_of_duplicating`, `test_real_relay_publish_twice_one_version` |
| **Duplicate project** | Linked once; marker reconcile; a remote project that disappeared is *reported*, not recreated | `test_failures_are_safe_and_explained`, `test_flaky_part_is_resent_and_new_renders_reuse_the_project` |
| **Overwriting** | Only additive remote calls. The only delete is aborting the connector's *own* unfinished upload session. | code review: `relay.py` |
| **Publishing different bytes under the same render** | Refused (SHA-256 recorded on first attempt) | `relay.py` |
| **Concurrent approvals** | Atomic claim; a second run gets "already being published" | `test_failures_are_safe_and_explained` |
| **Unnecessary media copies** | Streamed from the existing render file; no staging copy | `relay.py` |
| **Wrong workspace or permissions** | A clear error for 401, 403, an Access redirect, or not being a member; status "failed" | `test_failures_are_safe_and_explained` |

## Identity

- **Production:** a Cloudflare Access **service token**. Its headers are `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
  - Relay maps the token to a member email **only** if its Client ID is in `CF_ACCESS_SERVICE_TOKENS`.
  - That email must be invited to the workspace, normally as **Editor**. An Editor can create projects and upload versions, but cannot invite people, change the brand or approve on the client's behalf.
- **Local testing only:** `CUE_RELAY_DEV_IDENTITY` sends the ChatGPT-preview header. It is refused unless `CUE_RELAY_URL` is localhost. Production Relay strips that header anyway (see the security fix).

## Verified

- With the in-process emulation (6 tests): failure injection for lost responses, flaky parts, a deleted project, 403s and redirects.
- Against the **real Relay app** (`feature/cue-connector`, `vite` dev server with D1/R2 in miniflare): publish, then a simulated lost response and a retry. The result is exactly one remote project and one version, with the same byte size and `status=in_review`.

## Not verified

- A live Cloudflare deployment and a real Access service token. The `common_name` claim format follows Cloudflare's documentation.
- Uploading very large renders (over 2 GB) through Cloudflare.

## Configure (after the Relay branches are approved and deployed)

```
CUE_RELAY_URL=https://<relay host>
CUE_RELAY_WORKSPACE_ID=<workspace id from Relay>
CUE_RELAY_ACCESS_CLIENT_ID=<service token client id>
CUE_RELAY_ACCESS_CLIENT_SECRET=<service token secret>
```

Relay side: see `CUE_CONNECTOR.md` on `feature/cue-connector`.
