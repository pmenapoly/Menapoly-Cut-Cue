# First-project acceptance test (real video)

Run once after the pilot is deployed and the Mac shows **Mac online**. It takes about the length of your video ×2–3,
mostly Whisper and the export on the Mac. It creates one project ("Pilot acceptance <date>") that you can keep or delete.

## Pick the video

A real recording with speech, 2–10 minutes long, as recorded by a phone or camera: `.mp4`/`.mov`, H.264 or HEVC
video with AAC audio. Don't use a synthetic test file: this step proves the real pipeline.

## Run (on the Mac, or any computer with the repo)

```sh
brew install cloudflared                                     # once
cloudflared access login https://cue.menapoly-digital.com     # browser sign-in, once per 24 h
backend/.venv/bin/python scripts/pilot_acceptance.py \
    --url https://cue.menapoly-digital.com --video ~/Movies/first-interview.mp4 --phone
```

The script gets your Access token from `cloudflared` (never printed or saved). It asks before approving the
suggested edit, and with `--phone` asks you to confirm the phone checks. It writes `data/pilot/<time>/report.md` and
`report.json` and keeps the downloaded export next to them.

| # | Check | Passes when |
|---|---|---|
| 1 | Nothing answers without Access | `/`, `/v1/health`, `/v1/projects`, `/v1/status` and a review URL all redirect to sign-in or refuse; none returns app data |
| 2 | Owner sign-in and pilot settings | role owner, environment production, cloud processing **disabled**, client review links **disabled**, public review endpoint refuses |
| 3 | Mac worker online | at least one worker checked in within 2 minutes |
| 4 | Resumable upload | real file uploaded in 16 MB parts. After part 1 the script "loses the connection", asks the server what arrived, and sends only the rest. Records MB/s from that computer. |
| 5 | Transcription on the Mac | job succeeds with faster-whisper; segment count and the seconds of audio covered are recorded (the text is not printed) |
| 6 | Suggested edit is a proposal | the edit arrives as **proposed**; exporting it before approval is refused (409) |
| 7 | Owner approval | you answer **y** (or pass `--approve`) |
| 8 | Export, download, verify | YouTube preset export succeeds. The downloaded file's SHA-256 matches what the Mac uploaded; ffprobe shows **h264 + aac**; the duration matches the render report; the download header is recorded. |
| 9 | No paid processing | a cloud job request is refused; recorded spending this month is $0; stored GB and its estimate are shown |
| 10 | Audit trail | project, upload, jobs, approval, completion and download are logged |
| 11 | Android phone (`--phone`) | you confirm: installed app opens full-screen, Access sign-in works, project shows the edit, export and Mac online, the export plays on the phone, a phone upload over mobile data reaches "Stored privately" |

**Pilot accepted** = steps 1–10 VERIFIED and step 11 VERIFIED. Any FAILED step: stop, keep the report, and send it to
me. If step 1 fails, follow the rollback first.

## Already proven locally (2026-10-19)

`backend/tests/test_pilot_acceptance.py` runs this same script against the local stack (wrangler dev + local S3)
with the real agent process and the synthesized H.264/AAC fixture: steps 2–10 VERIFIED, 1 and 11 SKIPPED (local).
That proves the script and the workflow, **not** your Cloudflare setup, your Mac's speed or your phone. The real run
above is what proves those.
