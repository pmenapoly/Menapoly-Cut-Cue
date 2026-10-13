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
