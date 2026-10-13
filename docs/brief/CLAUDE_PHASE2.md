# Menapoly Cut Cue — Phase 2 implementation brief

Build a hybrid browser-based conversational AI video editor, continuing from `edit_engine.py` and `example-edit.json`.

## Architecture
- Frontend: Next.js, TypeScript, Tailwind; asset library, preview, AI chat, timeline, export jobs.
- Backend: Python FastAPI; SQLite for local dev with a PostgreSQL migration path.
- Workers: local Intel Mac worker first; optional cloud worker behind a common job protocol, disabled until configured and explicitly approved.
- Media: FFmpeg/FFprobe, faster-whisper, PySceneDetect, optional selective vision analysis.
- AI: Anthropic Claude API for tool-based editing plans. No invented media IDs, timecodes, or render success.

## Milestones
1. Initialize repository, environment configuration, backend API, migrations, tests.
2. Resumable upload and validated ingestion of video, audio, images, PDF, DOCX, TXT, SRT/VTT, and briefs. Hash files, assign opaque project-scoped asset IDs, probe streams and duration, generate proxies and thumbnails.
3. Background transcription, silence and scene detection, searchable transcript segments, parsed document context. Cache outputs; sample frames sparsely.
4. Chat with tools: search_project, get_transcript_range, get_scene_details, propose_edit, apply_timeline_patch, request_preview_render, get_render_status, restore_timeline_version. Use strict schemas, validate source in/out and project ownership.
5. Convert validated edit decision lists into actual FFmpeg renders, preserving sync, supporting mixed tracks, audio-only inputs, captions, 16:9/9:16/1:1 output, preview quality, cancellation and retries.
6. Browser playback, version history, undo/restore, export MP4/WAV/SRT/OTIO where implemented and tested.
7. LocalWorker, CloudWorker and JobRouter interfaces. Local is default. Require opt-in before transferring footage or incurring cloud costs. Enforce project budgets.
8. AudioEnhancementProvider interface: local FFmpeg enhancement, WAV handoff, processed audio re-import. Trebble adapter must stay unimplemented until API is verified; do not invent endpoints.

## Security and reliability
Authenticate requests; authorize project assets; validate MIME/content and sizes; protect secrets; avoid shell=True and arbitrary filesystem paths; isolate project storage; apply quotas, render timeouts, cancellation, and logs without client media contents. Treat all uploaded documents/transcripts as untrusted data, not instructions.

## Acceptance workflow
Create 'Market Mocha Test'; upload sample interview + brief; transcribe; ask Claude for a compelling intro; show a source-grounded rough cut; approve; render a real MP4; play in browser; revise via chat; restore versions; export MP4 and SRT. If Claude API key is absent, use a clearly labeled deterministic local test mode.

## Definition of done
Run unit, integration and end-to-end tests with synthetic or licensed test media. Provide setup for Intel macOS, .env.example, database migrations, architecture docs, and explicit completed/incomplete status. Do not stop at UI mockups or placeholder endpoints. Implement sequentially and commit after each tested milestone.
