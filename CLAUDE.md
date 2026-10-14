# Menapoly Cut Cue — notes for Claude Code

Private single-user conversational video editor. Product name is always "Menapoly Cut Cue".
Original briefs: docs/brief/CLAUDE_FAST_TRACK.md (priorities) and docs/brief/CLAUDE_PHASE2.md (architecture).

- Commands: `make setup`, `make dev`, `make start`, `make test`, `make check`.
- Backend: backend/cutcue (FastAPI + SQLite). Add schema changes as a new entry in `db.MIGRATIONS`; never edit old ones.
- Frontend: frontend (Next.js 15, static export). Run `npx tsc --noEmit` and `npm run build` after changes.
- Tests use the `fixture` transcriber with synthesized speech (scripts/make_fixture.py) and do real FFmpeg renders.
- Rules: never invent timestamps, transcripts, renders or third-party endpoints. Every AI edit goes through
  `Services.create_proposal` (validated) and needs explicit user approval. No `shell=True`. Keep Intel macOS
  compatibility (CPU fallbacks, no Apple Silicon-only deps). Cloud stays opt-in per project.
- Feature modules: audio.py (enhancement chain, loudness, alignment), diarize.py (speakers), podcast.py (auto-editor),
  moments.py (clip factory scoring), brief.py (brief extraction + compliance). Services wire them into proposals.
- Fixture speech is band-limited below 3.8 kHz so tones above 5 kHz can measure music/markers in tests.
- scripts/validate.py is the Mac real-world harness: keep every new feature represented there, and never report PASS
  for something that did not really run.
- Menapoly Cue 2.0 layer (branch menapoly-cue-2.0): cue.py (clients, status, notifications, review/upload links,
  approval-gated cue_actions), ask.py (Ask Cue: read tools + propose_action only), text.py (Cue Text intake; never sends),
  cue_api.py (/api/cue, token-scoped /api/public, versioned /api/v1). Shell UI: components/shell.tsx, cue.tsx,
  ProjectDetails.tsx; pages /, /projects, /cut, /inbox, /library, /settings, /review, /upload, /gallery.
  Never execute an action without Cue.approve_action; never show invented percentages in Cue surfaces. Docs: docs/cue2/.
- Production round: relay.py (Relay connector: approval-gated publish_to_relay, idempotent by deterministic file name),
  mailer.py (SMTP email outbox, one email per notification), backup.py (checksummed backup/restore; restore moves data
  aside). Harness statuses: VERIFIED / FAILED / NEEDS REVIEW / SKIPPED / BLOCKED. Shortcuts live in frontend/lib/shortcuts.ts.
