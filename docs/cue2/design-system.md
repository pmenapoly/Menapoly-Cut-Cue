# Menapoly Cue design system

You can see every component live in both themes at **`/gallery/`** (Settings → Design).
The source of truth is `frontend/app/globals.css` (tokens) together with `frontend/components/ui.tsx`, `shell.tsx` and `cue.tsx`.

## Color tokens

Tokens are CSS variables exposed to Tailwind through `@theme inline`, so `bg-panel`, `text-muted`, `border-line`, `bg-accent/20` and the rest follow the active theme.

| Token | Role | Dark (default) | Light |
|---|---|---|---|
| `ink` | Page background | **#11121B** | #F6F5FB |
| `panel` | Surface (cards, sheets) | **#1C1D2A** | #FFFFFF |
| `panel2` | Raised surface and inputs | #242536 | #F0EEF8 |
| `panel3` | Hover and selected | #2E2F44 | #E6E3F2 |
| `line` / `line2` | Borders | #34354B / #46475F | #DDDAEA / #C6C2DA |
| `text` | Primary text | **#F5F4FA** | #17182A |
| `muted` | Secondary text | #BDBBD0 | #47465E |
| `faint` | Tertiary text | #A3A1BC | #5D5B76 |
| `accent` / `accent-strong` | Primary: fills, focus, borders, primary buttons | **#8B79F7** | #5B47D6 |
| `on-accent` | Text on a primary fill | #11121B | #FFFFFF |
| `violet` | Secondary accent; also used for accent-colored *text* | **#C3A6FF** | #6B4CC9 |
| `ok` | Success | **#39B8A5** | #187064 |
| `warn` / `danger` | Warning / error | #E9B949 / #F4838F | #8A5A00 / #B4233B |

### Contrast

Every pair below was computed with the WCAG 2.1 relative-luminance formula. `python3 scripts/check_contrast.py` re-checks all 58 text/surface pairs in both themes straight from `globals.css` and fails if any is below 4.5:1.

- **Dark theme:**
  - `text` measures 15.3:1 on `panel`, `muted` 8.9:1 and `faint` 6.7:1.
  - Primary #8B79F7 measures 4.9:1 on `panel` but only 3.8:1 on `panel3`. It is therefore used for fills, borders and focus, not small text. Accent-colored text uses `violet` (#C3A6FF, at least 6.4:1).
  - Primary buttons use dark text on #8B79F7 (5.5:1). White text on #8B79F7 would be only 3.0:1, so it fails AA.
- **Light theme:** every text token measures at least 4.5:1 on every surface. White on #5B47D6 is 6.3:1.

### Themes

- The default follows the device setting (`prefers-color-scheme`).
- Settings → Appearance or the header toggle forces light or dark through `<html data-theme>`, saved in `localStorage` (`cue-theme`).
- A tiny inline script in `layout.tsx` applies the saved theme before first paint, so there is no flash.
- Any subtree can preview a theme with `data-theme="light"` or `data-theme="dark"`; the gallery uses this to show both side by side.

## Type, spacing and shape

- **Font:** Inter / SF Pro / system UI. Sizes: 11 px labels, 12 px meta, 14 px body, 16–18 px titles, 24–30 px page headings.
- **Shape:** cards use `rounded-2xl`, controls `rounded-lg`, pills `rounded-full`.
- **Touch targets:** primary actions use `min-h-11` (44 px). Navigation items are 48–56 px. Icon buttons are 36 px or larger.
- **Motion:** 180–220 ms fades and rises, all disabled under `prefers-reduced-motion`.

## Components

| Component | Where | Notes |
|---|---|---|
| Navigation: sidebar, rail, bottom tabs | `shell.tsx` (`AppShell`) | Five destinations plus Settings; `aria-current="page"`; Inbox badge shows waiting approvals |
| Top bar | `shell.tsx` | Page title, search (⌘K), notification bell with unread count, theme toggle |
| Project card / row | `cue.tsx` (`ProjectCardView`, `ProjectRow`) | Status pill text comes from the backend's plain-language status |
| Status indicator | `ui.tsx` (`StatusPill`) | Always has text, so color is never the only signal; spinner when busy |
| Upload surfaces | `ProjectDetails.tsx` (Media), `MediaPanel.tsx` (`UploadZone`), `/upload/` | Drag and drop, chunked and resumable, real byte progress |
| AI chat | `cue.tsx` (`AskCuePanel`), `CueChat.tsx` (Cut Cue) | Proposals render as action and proposal cards inside the thread |
| Action card | `cue.tsx` (`ActionCard`) | **Proposed** = dashed border and "needs your approval". **Done** = solid with a check. **Failed** = red with the reason. Risky kinds ask a second time. |
| Video player | `Player.tsx` (editor), native `<video>` with captions (client review) | |
| Timeline | `Timeline.tsx` (Cue Pro) | |
| Review panels | `ProjectDetails.tsx` (Reviews tab), `/review/` | |
| Notification center | `shell.tsx` (`NotificationCenter`) | Dialog on desktop, bottom sheet on phones; mark one or all read; paginated |
| Dialogs | `ui.tsx` (`Dialog`) | Focus trap, Escape to close, focus returned to the opener, bottom sheet on phones |
| Toasts | `ui.tsx` (`Toasts`) via `useShell().toast` | `role=status`, or `role=alert` for errors |
| Empty / error / loading | `ui.tsx` (`Empty`, `ErrorState`, `Loading`) | Error states explain the problem in plain words and offer *Try again* |
| Processing list | `cue.tsx` (`ProcessingList`) | Shows the real stage message and elapsed time, **never an estimated percentage** |

## Content rules

- Plain words: "Waiting for your review", "Couldn't process", "Turn off link". No job IDs in the main text; technical details sit behind a disclosure.
- Never claim completion early. A render action says "Rendering started. You'll get a notification when it is actually finished." Notifications are only created from real job-finished events.
- A percentage appears only for bytes uploaded (measured) and inside the Cut Cue editor, where it comes from FFmpeg's reported position.
