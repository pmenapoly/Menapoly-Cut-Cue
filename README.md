# Menapoly Cut Cue

A private, single-user video editor that you run in your browser and edit by chatting. You upload podcasts, interviews, client videos or promo footage along with a creative brief, and ask the AI editor for a hook, a pause-free rough cut or vertical clips. You review the proposal, approve it, and the app renders real MP4s with FFmpeg. You can then revise, compare and restore versions, and export MP4, SRT and WAV files.

By default everything runs locally on your Mac. Footage never leaves the machine unless you set up a cloud worker *and* approve it for a specific project.

## Quick start (Intel Mac, 16 GB RAM)

```bash
# 1. One-time system tools
brew install python@3.12 node ffmpeg

# 2. Install app dependencies and create .env
make setup PY=python3.12

# 3. Optional: add your Claude API key to .env  (without it: labeled local test mode)
#    ANTHROPIC_API_KEY=sk-ant-...

# 4. Optional: pre-download the Whisper model (otherwise it downloads on first transcription)
make whisper-model

# 5. Run
make dev      # API :8000 + live-reload UI → open http://localhost:3000
# or
make start    # one process, built UI → open http://127.0.0.1:8000
```

`make check` re-runs the dependency check. `make test` runs the automated test suite (about one minute; it does real FFmpeg renders).

## Using it

1. **Create a project** on the dashboard (e.g. "Market Mocha Test").
2. **Upload** media (MP4/MOV/MKV/WebM, WAV/MP3/M4A…), briefs (PDF/DOCX/TXT/MD) and optional captions (SRT/VTT). Uploads are chunked and can resume.
3. Analysis then runs in the background: probe, thumbnail, pause detection, scene cuts, a browser proxy for non-H.264 sources, and **local Whisper transcription**. You can watch progress in the **Jobs** tab.
4. **Chat** with the AI editor, for example "find a 20-second hook", "rough cut with long pauses removed", or "two vertical clips with captions". It searches the real transcript and proposes timelines.
5. **Approve** a proposal. That saves a new timeline version and renders a quick preview MP4.
6. **Revise** by chatting again, or edit the timeline directly: trim in/out points, reorder, split at the playhead, delete, or add lines from the transcript with "+ timeline". Then **Save version**.
7. Use **Versions** to compare any two versions or restore an older one. Restoring adds a new version, so history is never lost.
8. **Export final** renders 1080p (or 1080×1920 / 1080×1080) with loudness normalization to −16 LUFS, an SRT file and an optional WAV for audio hand-off (for example, Trebble).

## Intel Mac tuning (already the defaults)

| Area | Setting | Why |
|---|---|---|
| Transcription | faster-whisper `base`, `int8`, CPU, all cores, VAD on | Best speed/accuracy trade-off on Intel CPUs. Use `small` for better accuracy at roughly 2–3× the time. |
| Memory | One Whisper model resident; 16 kHz mono WAV extraction | Keeps RAM low on 16 GB. |
| Job lanes | 1 heavy lane (transcribe/render/proxy) + 1 light lane | The machine stays responsive while you keep working. |
| Rendering | One clip at a time, then stream-copy concat | Flat memory use; per-clip progress; A/V sync is kept for each clip. |
| Previews | 640×360 `ultrafast` | Fast to iterate. |
| Final export | `CUTCUE_VIDEO_ENCODER=auto` uses `h264_videotoolbox` when the Mac supports it, otherwise `libx264 veryfast` | Hardware encoding on supported Intel Macs. |
| Analysis | Scene detection on a 4 fps, 160 px sample | Cheap even for 90-minute files. |

Rough guide for a 60-minute podcast on a 4-core Intel i5/i7: transcription with `base` takes about 10–20 min (`small` about 25–45 min), and a final 1080p render takes about 10–20 min with libx264 (faster with VideoToolbox). These are estimates, not measurements on your machine.

## Claude

- Default model `claude-opus-5-5`, effort `medium`, with server-side refusal fallback (`fallbacks: "default"`) enabled. Change these in `.env`.
- Claude only gets read tools (`search_project`, `get_transcript_range`, `get_media_analysis`, `read_briefs`, `get_sequence`, `get_render_status`) and *proposal* tools (`propose_edit`, `propose_restore`). Every clip is validated against real asset IDs and probed durations. Invalid plans go back to Claude as errors for it to fix. **Nothing changes until you click Approve.**
- Transcripts and briefs are passed to Claude as clearly delimited untrusted data.
- Each project has an AI spend cap ($5 by default, editable in the header). The running cost is estimated from token usage.
- If no API key is set, a **local test mode** clearly labeled in the UI answers instead. It is a deterministic planner that understands hook, pause removal, rough cut and N vertical clips. It exists for testing without network access or cost.

## Security model (single user)

- The app binds to `127.0.0.1` by default. Binding to any other address requires `CUTCUE_PASSWORD`, which turns on an HMAC session cookie (`httponly`, `samesite=strict`).
- Uploads are checked by extension and by content: media must pass ffprobe, PDF and DOCX headers are verified, and text must be valid UTF-8. Uploads also have size limits.
- Files are stored as `data/projects/<project>/assets/<opaque-id>.<ext>`. User file names are never used as paths. Every lookup is scoped to its project and IDs are format-checked.
- No `shell=True` anywhere. FFmpeg receives argument lists the server builds itself.
- API keys stay on the server, read from `.env`, which git ignores.

## Project layout

```
backend/cutcue/      FastAPI app (main.py), services, jobs/router, media (FFmpeg), transcribe,
                     timeline validation, render engine, Claude assistant, SQLite + migrations
backend/tests/       unit, security, Claude-loop (scripted client) and end-to-end render tests
frontend/            Next.js 15 + TypeScript + Tailwind UI (static export served by FastAPI)
scripts/             dev.sh, check_deps.py, make_fixture.py (synthetic spoken interview)
docs/                architecture.md, cloud-worker.md, original briefs (docs/brief/)
edit_engine.py       original FFmpeg starter, kept for reference (superseded by backend/cutcue/render.py)
```

## Status (MVP milestone 1)

**Working and tested here** (Linux container, real FFmpeg, synthetic speech):
- Browser dashboard, project management, resumable chunked uploads with content validation
- Probe, thumbnails, proxies, silence and scene analysis, brief parsing (PDF/DOCX/TXT), SRT/VTT import as transcript
- Transcript view, full-text search across the project, click-to-seek
- Claude tool loop with grounding, validation feedback, approval gating, budget cap and refusal fallback (tested with a scripted client; **not yet run against the live API**)
- Labeled local test mode
- Timeline editor, versions, compare, restore
- Preview and final renders in 16:9, 9:16 and 1:1, burned-in captions, loudness normalization, SRT, WAV export
- Audio-only sources rendered with a waveform
- Job status, progress, cancel, retry, and restart recovery
- Optional password, and local/cloud selection with per-project approval

**Needs your machine to verify:**
- Real faster-whisper transcription. This container cannot download model weights. The code path, its error handling and Retry are tested.
- Live Claude API calls (needs your key).
- In-browser H.264 playback. The test browser here has no H.264 codec; Chrome and Safari do.
- Intel Mac timings and VideoToolbox.

**Not implemented yet:** the remote cloud worker itself (only the interface and an opt-in contract exist, see `docs/cloud-worker.md`), OTIO/Premiere/Resolve export, re-importing processed audio from WAV hand-off, multicam, B-roll, image clips on the timeline, and resumable uploads after a browser reload (resume currently works within one session). Payments, teams and multi-tenancy are out of scope by design.
