# Menapoly Cut Cue: architecture

```
Browser (Next.js static UI)
   │  same-origin /api (dev: Next rewrite → :8000; prod: FastAPI serves frontend/out)
   ▼
FastAPI (cutcue.main) ── auth middleware (optional password) ── exception → JSON errors
   │
   ├─ Services (cutcue.services): projects, uploads, assets, transcripts, sequences/versions,
   │                              proposals, renders. All lookups are project-scoped.
   ├─ Assistant (cutcue.assistant): Claude tool loop | local test planner
   └─ JobManager (cutcue.jobs)
         ├─ JobRouter.route(): local unless project.processing_mode == cloud AND
         │                     project.cloud_approved AND CUTCUE_CLOUD_WORKER_URL is set
         ├─ LocalWorker: heavy lane (transcribe, render, proxy) + light lane (analyze)
         └─ CloudWorker: opt-in adapter (contract only, see cloud-worker.md)

SQLite (data/cutcue.sqlite3, WAL) ← ordered migrations in cutcue.db.MIGRATIONS
Files: data/projects/<prj>/{assets,derived/<ast>,renders,uploads}
```

## Data model

`projects` → `assets` (opaque IDs, sha256, probe data) → `analyses` (silences, scenes, document text, captions) and `transcript_segments` (with word timings, FTS5 index).
`sequences` → `timeline_versions` (immutable; restore = new version that copies an old one).
`proposals` (pending → approved/rejected; approval creates versions and preview renders).
`renders` (per version, preview/final, MP4/SRT/WAV) ↔ `jobs` (status, progress, error, attempts, worker).
`chat_messages` stores the exact Claude API transcript (append-only, including thinking/tool blocks) plus a display text.

## Timeline / EDL

```json
{"aspect": "16:9", "burn_captions": false, "normalize_audio": true,
 "clips": [{"asset_id": "ast_…", "start": 12.40, "end": 31.85, "label": "Hook"}]}
```

`timeline.validate_timeline` rejects unknown or other-project assets, non-media assets, unready assets, negative or reversed ranges, clips shorter than 0.1 s, out-of-duration ends (±0.05 s tolerance, clamped), more than 3000 clips, and totals over 6 h. Pydantic `extra="forbid"` blocks smuggled fields such as `path`.

Pause removal (`remove_pauses`) is expanded on the server into explicit clips when a proposal is created, so what you approve is exactly what renders.

## Render pipeline (`cutcue.render`)

1. Write SRT: transcript words inside each clip are shifted to output time and grouped (≤42 chars, ≤3.5 s).
2. For each clip: `-ss/-t` input seek, scale-to-fill + crop to the target aspect, 30 fps, `tpad` and `apad`, cut to the exact clip length. Audio-only sources get a `showwaves` visual; video without audio gets `anullsrc`.
3. Concatenate with the concat demuxer using `-c copy`.
4. Optionally burn in captions (`subtitles`, run in the temp dir to avoid path escaping).
5. Final pass: `loudnorm I=-16:TP=-1.5:LRA=11`, `+faststart`. Optionally export WAV.

Cancellation kills the active FFmpeg process. A per-process timeout applies. Progress comes from `-progress pipe:1`.

## PostgreSQL path

The schema uses portable types, with JSON stored as TEXT. To move to Postgres: replace `Database` with a psycopg pool, port `MIGRATIONS` (FTS5 becomes a `tsvector` column with a GIN index, `AUTOINCREMENT` becomes `GENERATED … AS IDENTITY`), and keep `Services` unchanged.
