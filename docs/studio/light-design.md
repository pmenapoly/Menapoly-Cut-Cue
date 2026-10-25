# Light design: "Creative Command Center"

The approved hybrid (preview only, branch `menapoly-cue-studio-preview`):
- **Direction B** is the base: bright, tinted sections, media-rich cards.
- **Direction A** provides the editorial headings (Fraunces), used only for featured moments.
- **Direction C** provides the AI Visibility layout.

The mockups that led here are in [directions/](directions/).

## Proportions and meaning

- **About 80% light surfaces:** ground `#FAF9FF` and white cards.
- **About 15% soft tinted sections.**
- **About 5% dark:** the video player only. Its colours are scoped inside `.vp`, so the dark tokens never leak into the page.

| Colour | Means | Text on its tint |
|---|---|---|
| Purple `#6D3FE0` (buttons), `#5B3FC4` (text) | Cue/Maven and the main action on each screen | `#5B3FC4` on `#F0EAFF`: 6.1:1 |
| Blue `#69B7F8` (fills) | Being edited, production | `#18527F` on `#DDF0FF`: 7.1:1 |
| Teal `#57D1B7` (fills) | Completed, approved | `#0D5F53` on `#DDF7EC`: 6.7:1 |
| Amber `#F1B760` (fills) | Needs your review, deadlines | `#8A5A00` on `#FFF0C9`: 5.2:1 |
| Coral `#F17F86` (fills) | Changes requested, errors | `#B4233B` on `#FDE6E7`: 5.4:1 |
| Peach, sky, mint, lilac | Editorial sections (create tiles, discovery, spotlight) | as above |

**Reconciling the palette with the brief:**
- `#8657F2` reaches only 4.3:1 as text, so it is used for gradients and large graphics. Buttons use `#6D3FE0`
  (white text 6.1:1).
- The bright accent colours (under 2.6:1 on white) are fills and dots, never text.
- Plum `#332450` text is 12–14:1 on every ground. The secondary `#64627A` is at least 4.7:1 on every ground.
- Every status also has a word and, where there's room, an icon.

## Type

| Use | Face |
|---|---|
| Featured moments: Home greeting, spotlight headline, Editing Room status headline, AI Visibility insight | Fraunces (editorial serif) |
| Page and section headings, metrics | Bricolage Grotesque |
| Everything else: navigation, controls, body, data | Figtree; timecodes in JetBrains Mono |

## Tokens and components (`studio-preview/styles.css`)

- **Tokens** (`:root`): surfaces, text, signature purple, tints with their ink colours, status triples
  (text / soft / fill), `--stage` (dark player), `--editorial`, radii, `--shadow-1/2`, `--ease`, `--space-*`.
- **Shared components:**
  - `.btn` (primary, dark, sky, ghost, ok, danger; sm/lg);
  - `.status[data-tone]` with `statusInfo()` / `statusBadge()` in `js/ui.js`;
  - `.seg` (segmented filters);
  - `.tile` (media);
  - `.pcard` (project);
  - `.panel` and `.metric` (analytics);
  - `.maven-btn` and `.maven-card` (assistant identity);
  - `.status-card[data-tone]` (Editing Room).

**Each destination's personality:**
- **Home:** priority order on phones (needs me → create → spotlight → discover → Maven → recent → in progress → feed).
  On desktop the Maven, discovery, progress and notification panels share a sticky side column.
- **Studio:**
  - search, status chips with counts (also filters), and Gallery/List views;
  - project covers use the video poster;
  - the project waiting for review is featured first.
- **Editing Room:**
  - the dark player sits on a light page;
  - the status card changes colour, headline and actions with the status (review → Approve / Request changes;
    approved → Make more from this video);
  - on desktop the status card heads the side panel.
- **AI Visibility:**
  - a FICTIONAL DEMO DATA banner, plus a label on every panel;
  - one metric strip;
  - "what happened → why it matters → what to do next" (first on phones);
  - coverage bars with the weakest highlighted, share of voice with a competitor picker, and "Explore this action".
    That action opens a pre-filled request form; nothing is sent until the person submits it.
  - Plan entitlements are respected: share of voice and coverage only show when the plan includes them.

**Navigation:** the bottom bar is Home · Studio · Review · AI Visibility · More. Editors can't open AI Visibility, so
they get Ask Cue in that slot. There is no Coaching or My Media tab. Maven sits in the header on every screen.

**Motion:** hover lift on cards, press scale on buttons, sheets slide up, toasts and messages rise in, and progress
bars animate. All of it is off under `prefers-reduced-motion`.

## Wording changes

| Before | After |
|---|---|
| Make another version | Make more from this video |
| Translate video | Add captions in another language |
| Compare with original | Compare versions |
| Comment at … / Send comment | Leave feedback at … / Send feedback |

## Limits

- Checked in Playwright's Chromium with Android device emulation, not on a physical phone.
- Fonts load from Google Fonts. When they're unavailable, the system fallbacks keep the layout but lose the
  editorial character.
- The spotlight art is a generated gradient: no approved Menapoly imagery exists in the repository, and none was
  invented.
- Media thumbnails are the synthetic demo clips.
