# Responsive behavior

All five widths named in the brief are tested by `frontend/e2e/cue-shell.spec.ts`. At each width it checks every shell page and a project details page for:

- no horizontal overflow;
- exactly one visible main navigation, with all five destinations reachable;
- named controls;
- navigation and header targets of at least 36 px.

| Width | Layout |
|---|---|
| **375 px** (small phone) and **430 px** (large phone) | Top bar (logo, title, search, notifications, settings) and a bottom tab bar with five 56 px tabs. Single column. Dialogs open as bottom sheets. The projects board scrolls inside its own region. |
| **768 px** (tablet) | Left icon rail (84 px, labelled icons). Two-column card grids. Cue Pro is available. |
| **1280 px** (laptop) | Full labelled sidebar (240 px). Home shows a main column plus a 360 px side column (review queue and processing). |
| **1440 px** (desktop) | The same layout, with content capped at `max-w-7xl`. |

## What works where

- **Mobile:**
  - create a project, upload (also by private upload link), Ask Cue, status;
  - preview in Cue Simple;
  - client review and approval on `/review/`, request a revision;
  - notifications, Inbox approvals, exports (download links).
- **Tablet and desktop:** everything above, plus Cue Pro (multitrack timeline, transcript editing, inspector).
  - The "Pro" buttons are hidden below 768 px.
  - The editor itself keeps its own mobile layout (Cue / Preview / Files tabs), which existing tests already cover.

## Rules

- Grid children use `min-w-0`. Single-column grids use `grid-cols-1`, which Tailwind 4 defines as `minmax(0,1fr)`, so long names truncate instead of widening the page.
- Horizontal scrolling is allowed only inside a labelled, focusable region (the board view and tab strips), never on the page.
- Safe-area insets are respected on the bottom bar (`env(safe-area-inset-bottom)`).
