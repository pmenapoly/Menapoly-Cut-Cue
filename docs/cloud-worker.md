# Optional cloud worker (contract only; not deployed)

Local processing is the default and the only implemented worker. The cloud path exists so heavy jobs (transcription, final renders) can later run on a rented GPU or CPU box without changing the app.

## Gates (all required before any footage leaves the Mac)

1. `CUTCUE_CLOUD_WORKER_URL` (and `CUTCUE_CLOUD_WORKER_TOKEN`) set in `.env`.
2. The project's **Processing** selector set to *Cloud*.
3. The per-project approval checkbox ticked: "I approve uploading this project's footage to my cloud worker".
4. Only heavy job types (`transcribe`, `render`, `proxy`) are routed. Analysis stays local.

If any gate is missing, `JobRouter` keeps the job local. When the gates are met, the current `CloudWorker.submit` **refuses** with a clear error, because no remote worker is shipped yet. The job shows as failed with that message and nothing is uploaded.

## Proposed protocol (to implement when a worker exists)

The worker is your own service. This is not a third-party API.

- `POST {url}/jobs` with `Authorization: Bearer <token>` and body `{job_id, type, payload, inputs: [{asset_id, sha256, size, upload_url}], callback_url}`
- The app uploads only the assets that job references, to `upload_url`. The worker deduplicates by sha256.
- `GET {url}/jobs/{job_id}` returns `{status, progress, message, error, outputs: [{name, download_url, sha256}]}`
- The app downloads the outputs, verifies their sha256, and stores them exactly as a local job would (same `renders` / `transcript_segments` rows).
- Cost: the worker reports `cost_usd`, which is added to the project's spend and checked against `budget_usd` before submission.
