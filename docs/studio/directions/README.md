# Light directions (proposal, not applied)

Three light-themed directions for Menapoly Cue, drawn as twelve static 390 px phone screens: Home, Media Studio,
Editing Room and AI Visibility for each direction. They are mockups only, and nothing in `studio-preview/` has changed.
All names, numbers and media are fictional, and the numbers come from `js/data.js`. The canvas is a private claude.ai
artifact; these files are its source. Images point to the canvas's uploaded copies of `studio-preview/media/*.jpg`
(`/_blob/…`), so they only render on the canvas.

| | A · Light Luxe Executive Creative | B · Light Creative Command Center | C · Light Modern Intelligence Studio |
|---|---|---|---|
| Ground | Warm cream `#FBF8F4`, white panels | Lavender-white `#FAF9FF`, white cards | Neutral `#F7F7FA`, white panels |
| Type | Fraunces serif display (italic accents) + Figtree | Bricolage Grotesque 800 + Figtree (the current brand pair) | Geist + Geist Mono numbers |
| Structure | Dividers and whitespace, few containers, editorial headlines | Coloured sections and rounded cards; one tint per job | Bordered panels, hairlines, compact rows, data first |
| Colour | Almost monochrome plum; one peach spotlight | Mint, sky, peach, amber and lilac tiles used semantically | Neutral; colour only for status, charts and Maven |
| Density | Lowest | Medium | Highest |
| Maven | Quiet lavender pill | Lavender gradient pill and suggestion cards | Outlined lavender button; insight panels |

## Palette reconciliation (WCAG AA, measured)

The only existing brand sources are the current tokens (`#8F6DFF`/`#8B79F7` purple, Bricolage Grotesque, Figtree) and
the cloud PWA's light theme (`#5B47D6`). There are no logo files or brand guide in the repository.

- `#8657F2` is 4.31:1 on `#FAF9FF`, which fails for body text, and white on it is 4.51:1, which is borderline. Buttons
  and text links use **`#6D3FE0`** (white on it 6.11:1; on `#FAF9FF` 5.84:1). `#8657F2` stays for large graphics and
  gradients.
- Blue `#69B7F8`, teal `#57D1B7`, amber `#F1B760`, coral `#F17F86` and lavender `#C3AEFF` are below 2.6:1 on white,
  so they are fills, bars and dots only, and never text or the only signal. Text on the soft tints uses dark partners:
  blue `#1F6FB2`/`#18527F`, teal `#11786A`/`#0D5F53`, amber `#8A5A00`, coral `#B4233B`, purple `#5B3FC4`.
- Plum `#332450` text is 11.9–13.9:1 on every proposed ground and tint. Secondary `#64627A` is at least 5.0:1 on all of
  them.
- Each status also has a word (and an icon where there is room), so status never relies on colour.
