# Cut Cue integration contract v1

Base: `/api/v1` on the Cut Cue server. Auth: the owner session cookie (`CUTCUE_PASSWORD`) like all owner APIs.
`GET /api/v1/contract` returns `{"contract": "1.0", ...}`; clients must check the major version.
Shapes below are stable for 1.x; fields may be added, never removed or renamed. Tested in `backend/tests/test_cue.py::test_v1_contract`.

| Concept | Endpoint | Shape |
|---|---|---|
| Project identity | `GET /projects/{id}` | `{id, name, client, stage, status, created_at, archived}` — `id` is `prj_` + 16 hex, stable forever |
| Asset registration | `POST /api/projects/{id}/uploads` → `PUT …?offset=` chunks → `POST /api/v1/projects/{id}/assets {upload_id}` | `{id, project_id, kind, name, status, sha256, size, duration, has_transcript, error}`. Same bytes in the same project return the existing asset (no duplicate). |
| Assets | `GET /projects/{id}/assets` | list of the above |
| Job creation | `POST /projects/{id}/jobs {type, args}` | `type=auto_edit|clip_factory` → `{type:"proposal", proposal_id, status:"pending"}` (an edit is never applied without approval). `type=render` with `args.version_id` (+ `quality`, `preset`, `wav`) → `{type:"render", render_id, job_id, status}` |
| Job status | `GET /projects/{id}/jobs`, `GET /projects/{id}/jobs/{job_id}` | `{id, project_id, type, status: queued|running|succeeded|failed|cancelled, stage, error, created_at, started_at, finished_at}` — **no progress percentage** by design |
| Edit proposals | `GET /projects/{id}/proposals` | `{id, title, status: pending|approved|rejected, created_by, created_at, sequences:[{name, duration, clips}], result}`. Approve/reject: `POST /api/projects/{id}/proposals/{pid}/approve|reject` |
| Timeline versions | `GET /projects/{id}/versions`, `GET /projects/{id}/versions/{version_id}` | sequences with `current_version_id` and version list; a version includes the full validated `timeline` JSON |
| Render outputs | `GET /projects/{id}/renders` | `{id, project_id, version_id, status, quality, preset, duration, files:{mp4, srt, wav?}}` — file URLs only when they exist |
| Review links | `GET /projects/{id}/review-links` | `{id, label, render_id, active, expires_at, revoked_at, last_viewed_at, decision, comments}`; create via `POST /api/cue/projects/{id}/review-links` (owner) — the raw token is returned once |

## Cue layer (owner UI API, not versioned yet)

`/api/cue/home`, `/api/cue/projects[?q&client_id&stage&archived]`, `PATCH /api/cue/projects/{id}` (client, stage, archived),
`/api/cue/clients`, `/api/cue/notifications` (+ `/read`), `/api/cue/actions` (+ `/{id}/approve|reject`), `/api/cue/ask`,
`/api/cue/search`, `/api/cue/library`, `/api/cue/text` (+ `/senders`, `/simulate`, `/messages/{id}/retry`), `/api/cue/meta`.

## Public (token- or signature-scoped)

| Endpoint | Purpose |
|---|---|
| `GET /api/public/review/{token}` | project name, label, duration, events |
| `GET /api/public/review/{token}/media` | MP4 with HTTP Range support |
| `GET …/captions`, `GET …/download` (only if allowed) | SRT; download |
| `POST /api/public/review/{token}/events {kind: comment|approved|changes_requested, author, body, at_seconds}` | client feedback |
| `GET/POST /api/public/upload/{token}`, `PUT/GET …/{upload_id}`, `POST …/{upload_id}/complete` | resumable upload into one project |
| `POST /api/public/text/twilio` | inbound SMS webhook (form-encoded, `X-Twilio-Signature` required; 503 when not configured) |
