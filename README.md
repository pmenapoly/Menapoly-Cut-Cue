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

## Real-world validation (run this on your Mac first)

```bash
# .env must contain ANTHROPIC_API_KEY; Google Chrome must be installed
make validate MEDIA=~/Movies/episode.mp4 CLIP_MINUTES=10 BRIEF=~/Documents/brief.pdf
```

The harness starts the real server, uploads your file and brief, and runs real faster-whisper. It then asks live Claude for a rough cut, approves it, renders it, and asks Claude for a revision, which it also renders. Next it exports a final 1080×1920 vertical clip with SRT and WAV, and plays every render in headless **Google Chrome**. Along the way it measures transcription time and real-time factor, preview and final render times, peak memory by phase (server, Whisper and FFmpeg together), and Claude cost and tokens.

The output goes to `data/validation/<timestamp>/`:
- `report.md` and `report.json`
- a Chrome screenshot of the dashboard
- every rendered MP4
- the SRT
- a frame showing the burned-in captions
- the transcript
- `server.log`

Each step is marked **PASS** only if it really ran and passed its checks. Missing prerequisites (no API key, no Chrome, synthetic speech) show as **NOT VERIFIED** or **PARTIAL**, never PASS. Leave out `CLIP_MINUTES` to time a full episode.

## Validation status

| Check | Status | Evidence |
|---|---|---|
| App launches in Google Chrome | **Pending your Mac** | Here only Chromium was available: the dashboard rendered (PARTIAL, not Chrome) |
| faster-whisper downloads and transcribes real speech | **Pending your Mac** | Model download blocked in the build container (403); a failure is reported cleanly with Retry |
| Live Claude proposes a valid edit | **Pending your API key** | Real Anthropic SDK request/response checked against a local mock server (`test_claude_wire.py`); validation and approval gate covered by tests |
| Approve, then render a playable MP4 | Render and decode verified; **Chrome playback pending** | H.264/AAC, duration within ±0.35 s, full FFmpeg decode with no errors. The Chrome probe was shown to report both failure and success correctly |
| Revision through chat, new version renders | **Pending your API key** | The version, compare and restore render path is tested |
| 9:16 export plus SRT | Verified (render path, non-AI timeline) | 1080×1920 H.264, 10 SRT cues inside the clip and in order, burned-in caption frame inspected |
| Timings, memory, cost on Intel Mac | **Pending your Mac** | Container numbers (not your hardware): 26 s 9:16 final render in 17 s, peak about 490 MB |

**Not implemented yet:** the remote cloud worker (interface and opt-in contract only, see `docs/cloud-worker.md`); OTIO/Premiere/Resolve export; re-importing processed audio; multicam and B-roll; image clips on the timeline; and resuming an upload after a browser reload. Payments, teams and multi-tenancy are out of scope by design.
