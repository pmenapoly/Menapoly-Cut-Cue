# Android: install Menapoly Cue as an app (pilot)

Works with Chrome on Android 10 or newer. Samsung Internet works the same way via its menu → *Add page to* → *Home screen*.

## Install

1. Open **Chrome** and go to `https://cue.menapoly-digital.com`.
2. Sign in on the Cloudflare Access page: enter your email, then the 6-digit code from the email. (Only the address
   on the pilot's Access policy gets a code.)
3. Wait for the Projects page, then tap **⋮** (top right) → **Install app** (older Chrome: **Add to Home screen** →
   **Install**). Confirm.
4. Open **Menapoly Cue** from the home screen. It opens full-screen without the address bar. If it opens as a normal
   browser tab, uninstall it and install again from step 3 after the page has fully loaded.

If **Install app** is missing: make sure you're on the `https://` address, that the page finished loading after
sign-in, and that you're not in an Incognito tab.

## Daily use

- **Sign-in lasts 24 hours** (the pilot's Access session). When it expires the app shows *"Your sign-in expired.
  Reload the page to sign in again."* Pull down to reload, or close and reopen the app, then enter a new email code.
- **Upload:** Project → *Choose files* → pick videos from Photos or Files. Files go in original quality, straight to
  private storage. Keep the app open on screen while the bar moves. Android pauses background tabs, so switching apps
  pauses the upload. If it stops (signal lost, app closed), open the project again and choose the **same file**: only
  the missing parts are sent.
- **Mobile data:** a 1 GB video uses 1 GB of data. Prefer Wi-Fi for big files.
- **Status:** jobs show what the Mac is doing ("Transcribing", "Rendering") and a percentage only when the Mac measured
  it. "Mac offline" means your Mac is asleep, logged out or disconnected; jobs wait and start by themselves later.
- **Approve, export, download:** Edits → *Approve* → choose a format → *Export*. Finished videos → *Play* or
  *Download* (saved to Downloads).
- **Not in the pilot:** client review links, text messages (SMS) and cloud processing are turned off.

## Remove

Long-press the icon → *Uninstall* (or App info → Uninstall). Then Chrome → Settings → Site settings → All sites →
`cue.menapoly-digital.com` → *Delete data* removes cached pages and the remembered upload sessions. Your projects stay
in the pilot.

## What has and hasn't been tested

Tested in the Chromium browser at phone size (390×844, Pixel 7 profile): sign-in handling, upload with a dropped
connection and with the page closed, status, approval, export, preview link, download, settings. **Not yet tested on
a real Android phone**: installing, the Access sign-in inside the installed app, background behaviour and playback.
Step 11 of the acceptance test records those on your phone.
