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
8. **Export final** renders 1080p (or 1080×1920 / 1080×1080) with two-pass loudness normalization to the timeline's target, an SRT file and an optional WAV for audio hand-off (for example, Trebble).

## Features

All four features run locally with FFmpeg and numpy: no cloud service and no model downloads beyond Whisper. Each one produces a **proposal** that you approve before anything changes. You can use them from the tabs under the timeline (**Auto-edit**, **Clips**, **Brief**, **Source**) or by asking the AI editor in chat.

### Podcast Auto-Editor
- **Speaker detection** runs after transcription.
  - Stereo recordings with one voice per channel are split by channel.
  - Mono or mixed recordings are split by MFCC voice-feature clustering, with the speaker count chosen automatically.
  - In the Source tab you can rename speakers, set their framing, or re-run with a fixed count.
- **Intelligent silence removal** works from word timestamps:
  - Cuts land only between words, and only where the audio is actually silent. The silence threshold follows each recording's own noise floor, so untranscribed laughter is never cut.
  - Pauses within one speaker are shortened to 0.35 s.
  - Speaker changes and answers to questions keep a 0.6 s beat, so the conversation still breathes.
- **Filler removal and dead-air trimming:** "um", "uh" and similar are cut and the gap around them is retimed; dead air at the start and end is trimmed.
- **Rough cut:** pass `add_hook` (or ask "rough cut with a hook") to open with the strongest short moment.
- **Change report:** every proposal lists the seconds removed, pauses tightened and each filler cut with its timestamp.

### AI Clip Factory
- **Candidate moments** are windows of whole sentences, scored with visible reasons:
  - a strong opening line;
  - concrete proof (numbers, results);
  - emphasis words;
  - brief keywords and must-include phrases;
  - a question answered by the other speaker.
- **What it avoids:** openers that need earlier context ("And…", "So…", "It…") are penalized, and any window containing a must-avoid phrase is excluded.
- **Selection:** the best non-overlapping set is chosen. With no length in the brief, short episodes still get the requested number of clips, at a minimum of 6 s.
- **Each clip gets:**
  - 9:16 format with pauses and fillers tightened inside the clip;
  - captions burned in, with lines up to 28 characters;
  - framing on the dominant speaker, using that speaker's `focus_x`;
  - an optional title and −14 LUFS loudness.
- Later runs avoid moments you've already clipped. Claude can review the candidates and pick different ranges.

### Audio enhancement
- **Settings per timeline (Audio row):**
  - denoise: off, light or strong;
  - voice EQ and compression;
  - loudness target: −16 podcast, −14 social or −23 broadcast;
  - background music with volume and **ducking**.
- **How denoise works:** spectral noise reduction set from the program's measured noise floor, plus a soft gate in pauses.
- **Ducking:** the music dips under the voice using a sidechain compressor.
- **Loudness:** two-pass `loudnorm` hits the target within 1 LU.
- **Clean cuts:** every cut gets 12 ms fades, so there are no clicks.
- **WAV hand-off and re-import:**
  - *Source tab:* export a source's audio, clean it in Trebble or Adobe Podcast, upload the result and **Attach** it. The offset is detected automatically, and unrelated audio is rejected. Every later render uses the processed track.
  - *Render level:* **Re-import audio** on a finished render produces a new render with the processed WAV; the video is copied without re-encoding.

### Creative Brief Intelligence
- **Extraction:** briefs in TXT, DOCX, PDF or MD become structured requirements:
  - client, goals, audience, tone and platforms;
  - deliverables, with count, aspect, length range and captions;
  - key messages, must-include and must-avoid phrases;
  - call to action, deadline, and the loudness target for each platform.
- **Editing:** you can correct the requirements in the Brief tab, and Claude can refine them with a tool.
- **Driving edits:** the requirements set the clip count, length, aspect, captions and loudness.
- **Compliance on every proposal and version:** aspect, length range, captions, must-include and must-avoid phrases, key-message coverage, CTA, loudness and deliverable count. Failures and warnings show on the proposal card, and are returned to Claude so it can fix them.

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

The harness starts the real server, uploads your file and brief, and runs real faster-whisper. It also runs steps 8–11 on your recording: speaker detection, podcast auto-edit, Clip Factory and audio enhancement. It then asks live Claude for a rough cut, approves it, renders it, and asks Claude for a revision, which it also renders. Next it exports a final 1080×1920 vertical clip with SRT and WAV, and plays every render in headless **Google Chrome**. Along the way it measures transcription time and real-time factor, preview and final render times, peak memory by phase (server, Whisper and FFmpeg together), and Claude cost and tokens.

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
| Podcast auto-edit (silence, fillers, turns) | Verified on synthetic two-speaker fixture | Every pause checked against the rules; fillers absent; rendered program has no silence ≥ 0.75 s; untranscribed sound never cut. **Real-speech quality pending your listening test** |
| Speaker detection | Verified on fixtures only | 100% on the stereo fixture and on the mono fixture (two very different synthetic voices). **Accuracy on real voices unverified**; the harness reports confidence and you check the labels |
| Clip Factory + captions | Verified on fixture | 9:16 renders; SRT text equals the words kept in the cut; cues ordered, non-overlapping, each within 60 ms of its first word |
| Audio enhancement | Verified on fixture | Loudness within 1 LU of target; noise in pauses −13 to −27 dB with speech unchanged (< 0.1 dB); music ducked > 6 dB under speech; re-imported audio in sync within 20 ms |
| Brief intelligence | Verified on sample briefs | Same requirements from TXT, DOCX and PDF; compliance pass/fail on real cuts. **Your real client briefs may phrase things differently**: check the Brief tab |

**Not implemented yet:** the remote cloud worker (interface and opt-in contract only, see `docs/cloud-worker.md`); OTIO/Premiere/Resolve export; multicam and face-tracked framing (framing is a per-speaker manual setting); B-roll; image clips on the timeline; and resuming an upload after a browser reload. Payments, teams and multi-tenancy are out of scope by design.
