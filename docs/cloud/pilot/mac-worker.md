# Intel Mac worker: installation and startup (pilot)

The Mac connects **out** to `https://cue.menapoly-digital.com` over HTTPS. It opens no ports and needs no router changes or
tunnel. Its work happens in its own folder (`~/Library/Application Support/MenapolyCue/agent`), so your desktop
editor's projects aren't touched. It's free to run (your electricity).

## Before you start

- macOS on Intel, with the repository set up (`make setup` done, `make check` green: FFmpeg, Python 3.12, Node).
- Whisper model downloaded once: `make whisper-model` (uses `CUTCUE_WHISPER_MODEL`; `base` is the Intel default,
  `small` is better quality and slower).
- From the pilot deployment: the **worker token** (app → Settings → Mac workers → Create worker token) and the Access
  **service token** Client ID and Secret (deployment-plan step 1).

## Install (about 10 minutes)

1. Add to the repository's `.env` (it stays on this Mac):

   ```sh
   CUE_CLOUD_URL=https://cue.menapoly-digital.com
   CUE_WORKER_TOKEN=cqw_…                  # shown once in the app
   CUE_ACCESS_CLIENT_ID=….access           # Access service token "menapoly-mac"
   CUE_ACCESS_CLIENT_SECRET=…
   ```

   Then `chmod 600 .env`.

2. Check the connection: `make agent-check`. Expected:
   `OK: connected to cue.menapoly-digital.com as a registered worker (Darwin x86_64, transcriber=faster-whisper).`
   - `403` / Access login HTML: the service token or the "Mac worker" Access app is wrong.
   - `401 Worker credentials rejected`: the worker token is wrong or was removed in the app.
3. Install as a login service: `make agent-install`. This writes `~/Library/LaunchAgents/com.menapoly.cue.agent.plist`,
   starts the agent now and at every login, restarts it if it crashes (after 30 s), and runs it at low CPU and disk
   priority (`Nice 10`, `LowPriorityIO`). Logs go to `~/Library/Logs/MenapolyCue/agent.log`.
4. In the app the pill at the top turns **Mac online** within 30 seconds.

## Keep it available

| Setting | Why |
|---|---|
| System Settings → Energy Saver (or Battery → Options): **Prevent automatic sleeping when the display is off** on power adapter. Or in Terminal: `sudo pmset -c sleep 0` (undo: `sudo pmset -c sleep 1`) | a sleeping Mac can't take jobs. If it sleeps mid-job, the lease expires within 3 minutes and the job waits, then runs when the Mac wakes. |
| Stay logged in (log out = the agent stops; it's a per-user LaunchAgent) | it runs with your user's permissions only, not as root |
| After a restart: log in once | the agent starts at login. With FileVault there's no unattended start before login, by design. |
| Lots of disk free | the agent refuses work below 5 GB free (`CUE_AGENT_MIN_FREE_DISK_GB`) and below 1.5 GB of free memory |

## Everyday control

```sh
tail -f ~/Library/Logs/MenapolyCue/agent.log                   # what it's doing
launchctl kickstart -k gui/$(id -u)/com.menapoly.cue.agent     # restart it
scripts/install_agent_launchd.sh --remove                      # stop and uninstall
```

When stopped (or the Mac shut down), the current job goes back to the queue right away, without spending one of
its 3 attempts. The phone shows **Mac offline**, and new jobs wait with "This starts when it reconnects".

## If the Mac is lost or the token leaks

App → Settings → Mac workers → **Remove** (the token stops working at once; its jobs requeue). Zero Trust → Service
Auth → revoke `menapoly-mac`. Then create new ones and update `.env`.

## What it can and can't do

It runs transcription (faster-whisper on CPU, int8), suggested edits (the podcast auto-editor, which comes back as a
**proposal** you approve on the phone) and exports (FFmpeg; `h264_videotoolbox` when the Mac has it, otherwise
`libx264`). It makes no paid AI calls. How fast it is on your Mac hasn't been measured yet: the acceptance test records the real
transcription and export times.
