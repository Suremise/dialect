# Dialect branding

The app icon and the accent colours it gives the app. Everything here is build-only: the rendered icons ship, the
tools that make them don't.

| File | What it is |
| --- | --- |
| `icon.svg` | The master, on a 512×512 viewBox. Used for 48 px and up. |
| `icon-small.svg` | The 16–32 px variant on a 64×64 viewBox: flat fill, no gradient or gloss, thicker strokes. |
| `tray.svg` | The desktop app's notification-area icon on a 64×64 viewBox: the small icon filling its square, with heavier strokes, readable on light and dark taskbars. |
| `theme-tokens.css` | The accent tokens for the UI, light and dark. |
| `out/` | Generated: `icon.png` (512), `icon-16.png` … `icon-256.png` (16, 24, 32, 48, 64, 128, 256), `icon.ico` (all seven sizes), `icon.icns`, and `tray-16.png` and `tray-32.png` from `tray.svg`. |
| `concepts/` | The three phase-1 concepts, kept as a record (see its README). |

## Regenerating

From the repo root (the scripts are `scripts/build-icons.mjs` and `scripts/check-contrast.mjs`):

```sh
npm run icons      # rewrites branding/out/
npm run contrast   # exits 1 if a token pair drops below AA
```

Edit the SVGs, never the files in `out/`: they're overwritten on every run. 32 px and below come from
`icon-small.svg`, the rest from `icon.svg`. The SVGs are rasterised at twice the target size and scaled down.

`icon.icns` is written by the script itself (an ICNS file is a header plus PNG entries, so it doesn't need macOS),
with entries for 16 to 512 px and their @2x versions up to 1024. It hasn't been opened on a Mac yet. When the Tauri app
is scaffolded, check it there, or let `tauri icon branding/out/icon.png` make Tauri's own set from the 512 PNG.

**Tools and licenses.** `sharp` (Apache-2.0, bundles libvips, LGPL-3.0) and `png-to-ico` (MIT) are build-only dev
dependencies of the repo root. They never ship, so they're allowed (see the license rule in `docs/SPEC.md`): they're
listed in `docs/BUILD_ONLY_PACKAGES.md`, not in `THIRD_PARTY_NOTICES.md`. The icons they produce are original work
under the project's MIT license.

## The icon

**Braces to block.** A curly brace opening onto three indented lines: config written in braces, read back as a flat,
indented block. That's what Dialect does: it says the same config again in another vendor's dialect. It's built like
Hive's icon, one bold shape (here a circle) with a gradient, a soft gloss ring, a dark face and a simple glyph in the
brand colours, but with its own shape, palette and glyph.

It doesn't use any vendor's name, logo, mark or brand colours. The violet stays clear of the vendors' blues and greens.

The small variant drops the gradient, gloss and face. At 16 px it's a violet disc with the brace and lines in the dark
face colour, 3.8:1 against both light (`#f3f3f3`) and dark (`#202020`) taskbars, with the glyph 4.4:1 on the disc.

## Palette

The icon's colours (fixed, the same in both themes):

| Token | Hex | Used for |
| --- | --- | --- |
| `--brand-violet-300` | `#C4B5FD` | Light: gradient top, the brace and the lower lines |
| `--brand-violet-400` | `#A78BFA` | Base: gradient middle, the top line |
| `--brand-violet-500` | `#8B5CF6` | The small icon's flat fill |
| `--brand-violet-600` | `#7C3AED` | Dark: gradient bottom |
| `--brand-violet-700` | `#6D28D9` | Darker still, for light-theme text (not in the icon) |
| `--brand-face` | `#251C35` | The face, top |
| `--brand-face-deep` | `#140F1E` | The face, bottom and ring; the small icon's glyph |

## Theme tokens

Violet is Dialect's accent throughout the app, as honey amber is Hive's. `theme-tokens.css` uses **the same token
names as Hive's `src/renderer/src/styles/app.css`**, so the UI card can take over Hive's rules that use them as they
are. Hive's `--honey-light` becomes `--violet-light`. Two tokens are new: `--accent-fill-hover` (Hive mixes its
hover in per rule) and `--focus-ring` (Hive's `:focus-visible` outline uses `--accent` directly; point it at
`--focus-ring` instead).

| Token | Dark | Light | What it is (as in Hive) |
| --- | --- | --- | --- |
| `--accent` | `#A78BFA` | `#7C3AED` | The accent: borders, outlines, selected marks |
| `--accent-strong` | `#8B5CF6` | `#6D28D9` | A stronger accent for emphasis |
| `--accent-soft` | `rgba(167,139,250,.16)` | `rgba(124,58,237,.12)` | Tint behind badges and selected rows |
| `--accent-fill` | `#A78BFA` | `#7C3AED` | Primary-button fill |
| `--accent-fill-hover` | `#C4B5FD` | `#6D28D9` | That fill hovered (new) |
| `--accent-fg` | `#1B1B1B` | `#FFFFFF` | Label on the fill |
| `--accent-ink` | `#C4B5FD` | `#6D28D9` | The accent as text and icons on the backgrounds |
| `--accent-on-activity` | `#A78BFA` | `#7C3AED` | The accent as an icon on the activity bar |
| `--violet-light` | `#C4B5FD` | `#A78BFA` | Highlights (Hive's `--honey-light`) |
| `--dot-accent` | `#A78BFA` | `#7C3AED` | Status dots |
| `--status-bg` / `--status-fg` | `#7C3AED` / `#FFFFFF` | `#7C3AED` / `#FFFFFF` | The status bar |
| `--focus-ring` | `#A78BFA` | `#7C3AED` | Focus outlines (new) |

**Contrast** (`npm run contrast`, WCAG 2.x: 4.5:1 for text, 3:1 for icons and focus rings). The surfaces are Hive's
backgrounds (page, sidebar, activity bar, title, panels, inputs, hovered and selected rows) until Dialect's UI sets its
own; rerun the check when it does. Worst case over every surface:

| Pair | Dark | Light | Needs |
| --- | --- | --- | --- |
| `--accent-ink` text on the backgrounds | 6.40 | 5.71 | 4.5 |
| `--accent-ink` text on `--accent-soft` | 5.03 | 4.84 | 4.5 |
| `--accent-fg` on `--accent-fill` | 6.33 | 5.70 | 4.5 |
| `--accent-fg` on `--accent-fill-hover` | 9.33 | 7.10 | 4.5 |
| `--status-fg` on `--status-bg` | 5.70 | 5.70 | 4.5 |
| `--focus-ring` on the backgrounds | 4.34 | 4.58 | 3 |
| `--accent-on-activity` on the activity bar | 5.13 | 4.65 | 3 |

Two things to keep in mind. In dark, white on the accent is only 2.7:1, so labels on violet fills stay dark. And
`--accent` itself isn't for body text on the darkest dark surfaces (4.34:1 on Hive's selected row): use `--accent-ink`.
