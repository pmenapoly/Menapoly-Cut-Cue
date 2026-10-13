# MENAPOLY CUT CUE — 14-DAY SINGLE-USER FAST TRACK

Product name: Menapoly Cut Cue. Repository/package slug: `menapoly-cut-cue`. Display name, page titles, application metadata, documentation, tests, API descriptions, logs, and sample project names must consistently use the new name. Do not change generic Python function names just for branding.

## Objective
Ship a **working private, single-user hybrid browser application** on Intel macOS, with local processing by default and optional cloud processing only after explicit user approval. Target: a testable MVP in 14 days of active development, contingent on environment, dependencies, credentials, and test footage. Do not promise full Eddie AI parity.

## Critical path
1. Days 1–2: local Next.js browser app + FastAPI API, one-user auth, project creation, media upload, storage, FFprobe inspection, and job status.
2. Days 3–4: faster-whisper transcription with timestamps, scene/silence analysis, parse PDF/DOCX/TXT briefs, searchable media index.
3. Days 5–6: Anthropic Claude API chat with grounded transcript search, typed JSON edit plans, strict source ID/time validation, explicit user approval.
4. Days 7–8: FFmpeg rough-cut rendering, MP4 preview, source-to-timeline mapping, retryable jobs.
5. Days 9–10: podcast preset, SRT captions, short clip extraction, 16:9 and 9:16 export.
6. Days 11–12: revisions/restore, audio loudness normalization, WAV import/export, cost caps and optional cloud-worker contract.
7. Days 13–14: smoke tests on an Intel Mac, real licensed podcast footage, fix bugs, verify final exports.

## MVP acceptance criteria
- Launch locally and open browser dashboard.
- Upload one 30–90 minute podcast plus a creative brief (actual media duration depends on available hardware).
- Show transcript with real timestamps and asset-backed search.
- Chat: request a hook, remove selected pauses, produce a rough cut, and create two vertical clips.
- Approve and render real MP4 files and SRT captions.
- Request a second edit, compare versions, restore previous version.
- Show job status, errors, and local/cloud processing selection.
- Cloud processing disabled unless configured and explicitly approved.
- No fabricated timestamps, transcript, finished renders, or integration endpoints.

## Deliberately defer
Team roles, multi-tenant SaaS, billing, extensive multicamera automation, auto B-roll generation, Trebble API automation without verified API, collaborative review, Premiere/Resolve native project fidelity, autonomous publishing. Trebble manual WAV handoff may be implemented.

## Engineering directions
Read `CLAUDE_PHASE2.md` and `edit_engine.py`. Build in vertical slices. Prefer reliable tested implementations over broad mockups. Keep local processing compatible with Intel macOS (CPU fallback, no Apple Silicon-only dependencies). Keep cloud worker an optional adapter. Provide a `make dev` or equivalent one-command start, `.env.example`, dependency checks, sample fixtures, and automated smoke test. Validate uploaded content and isolate user assets. Use server-side API keys only.

Start with the first end-to-end slice: upload one video -> transcribe -> request a cut via chat -> validate edit decision list -> render MP4 -> play in browser. Demonstrate with real outputs and test results.
