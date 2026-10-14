# Intel Mac (16 GB) setup and validation checklist

Work through this top to bottom on your Mac. Each check says how it's verified and where to record the result.

`make validate` writes `data/validation/<time>/report.md`, which marks every step with one of these outcomes:

| Outcome | Meaning |
|---|---|
| **VERIFIED** | It really ran and its checks passed. |
| **FAILED** | It ran and failed. The report says why. |
| **NEEDS REVIEW** | It ran, but a person has to judge it (listen, look). |
| **SKIPPED** | You didn't provide the input (for example, no long podcast). |
| **BLOCKED** | A prerequisite is missing (for example, no Claude key, no Chrome, email not set up). |

Nothing in this list has been run on your Mac yet. Everything below was verified only in a Linux container, using FFmpeg 6.1 and Playwright Chromium.

## 0. Before you start (about 20 minutes)

- [ ] **Back up existing data.** If you used an earlier version: `cp -a data data.bak-$(date +%F)`. Once this version is installed, `make backup` does it with checksums.
- [ ] **Install the tools:** `brew install python@3.12 node ffmpeg`, plus Google Chrome from google.com/chrome.
- [ ] **Switch to this branch:** `git fetch origin && git checkout menapoly-cue-2.0`.
- [ ] **Install dependencies:** run `make setup`. It should end with every dependency OK.
- [ ] **Download the speech model:** `make whisper-model`. The `base` model is about 150 MB; `small` is about 500 MB and slower on Intel.
- [ ] **Edit `.env`:**
  - `ANTHROPIC_API_KEY=…` for live Claude;
  - optionally `CUE_SMTP_*`, `CUE_EMAIL_FROM` and `CUE_EMAIL_TO` for email;
  - optionally `CUE_RELAY_*` for the client portal.
- [ ] **Have two recordings ready:**
  1. a 5–15 minute real interview or podcast (`MEDIA`);
  2. a full 30–90 minute episode (`LONG`).
- [ ] **Have a brief ready** (PDF, DOCX or TXT), optional.

## 1. Automated run

```bash
make validate MEDIA=~/Movies/interview.mp4 BRIEF=~/Documents/brief.pdf LONG=~/Movies/full-episode.mp4 PHONE=1
```

`PHONE=1` makes the server listen on your Wi-Fi network and pauses at step 15 so you can use your phone.

| Step | What it checks | Verified when |
|---|---|---|
| 1 | Real **H.264/AAC playback in Google Chrome** | Chrome decodes the rendered MP4 and plays forward (no errors) |
| 2 | Real **faster-whisper transcription** of your recording | Segments with word timestamps. The real-time factor is recorded. |
| 3 | **Live Claude** proposes a valid edit | A proposal is created and passes server validation |
| 4 | Approve and render a playable MP4 | H.264/AAC, the right duration, a clean full decode, Chrome playback |
| 5 | Revision through chat | A new version renders |
| 6 | 9:16 export with SRT | 1080×1920; captions inside the clip and in order |
| 7 | Timings, memory, API cost | Measured on your hardware |
| 8 | Speaker detection | Ran (NEEDS REVIEW: you listen and compare the labels) |
| 9–11 | **FFmpeg exports**: podcast auto-edit, Clip Factory, audio −16 LUFS | Renders pass ffprobe, a full decode and loudness within ±1 LU |
| 12 | Cue 2.0: client, status, review link, client feedback, notifications | API checks pass |
| 13 | Ask Cue with live Claude only *proposes* | At least one proposal, nothing executed |
| 14 | **Long podcast** (30+ min) | Transcription, auto-edit and preview render succeed; time and peak memory recorded |
| 15 | **Mobile review link** | You open the link on your phone, the video plays, and your note arrives |
| 16 | **Database backup and restore** | Backup verifies; a second server on the restored copy serves identical render bytes |
| 17 | Publish to the client portal | Only if `CUE_RELAY_*` is set; otherwise BLOCKED |
| 18 | Email notifications | Only if SMTP is set: a test email is sent (NEEDS REVIEW: check your inbox) |

## 2. Manual checks (10 minutes; record them in the report)

- [ ] **Chrome on the Mac.** Run `make start` and open `http://127.0.0.1:8000`, then:
  - create a project and drop in a recording;
  - wait for **Ready**, then ask Cue for "a tight rough cut with a hook";
  - press **Preview**: audio and captions play;
  - **Approve**, then **Export → YouTube**, and download the MP4;
  - play the downloaded file in QuickTime.
- [ ] **Phone review.** Use the step 15 link, or set `CUTCUE_HOST=0.0.0.0` and `CUTCUE_PASSWORD`.
  - On an iPhone or Android phone, the video plays inline, the note pins to the current time, and "Request changes" asks to confirm.
  - Back on the Mac, the bell shows "requested changes".
- [ ] **Phone owner use.** Open `http://<mac-name>.local:8000` on the phone and sign in.
  - The bottom tabs work.
  - Creating a project and uploading from the camera roll work.
- [ ] **Keyboard.** Press `?` anywhere; search for "split". Then press `G`, `I` to go to the Inbox.
- [ ] **Restore drill.**
  1. Stop the app, then run `make backup`.
  2. Run `make restore BACKUP=backups/<name>`. The current data is moved to `data.pre-restore-*`, not deleted.
  3. Run `make start`: your projects are all there.

## 3. Record the outcome

Copy the summary line from `report.md`, for example "VERIFIED: 14 · FAILED: 0 · NEEDS REVIEW: 3 · SKIPPED: 0 · BLOCKED: 1", together with any FAILED or BLOCKED details.

To report problems, include `report.md` and `server.log` from the same folder.
