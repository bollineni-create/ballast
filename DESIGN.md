# Ballast design system

Ballast follows the bollineni.co house style (the Archivo typeface, plain ink on plain surfaces, one accent per app) and adds what a data-heavy tool needs: a number-first type scale, gain/loss colors and chart colors.

See it live at `/design.html` (next to the app), which draws every token and component with the real stylesheet.

## How it is put together

| File | What it holds |
|---|---|
| `tools/tokens.mjs` | The source of truth: scales and every theme's colors. Run `node tools/tokens.mjs` after editing. |
| `public/tokens.css` | Generated. CSS variables for the scales and themes. Never edit by hand. |
| `public/styles.css` | Components. Uses only token names: no raw hex colors, no one-off font sizes. |
| `public/theme.js` | Applies the saved theme and light/dark choice before the page paints. |
| `public/design.html` | The living reference. |

## Principles

1. **Show less first.** A view opens with one verdict and at most four numbers. Everything else (the reasons behind a score, settings, extra statistics) sits one click away in a tab or a fold. If a screen needs a tour, it has too much on it.
2. **Flat and quiet.** White or near-black page, hairline borders, no gradients, no shadows on cards, no glow. Boxes are used to group, never to decorate; a row of numbers is one ruled strip, not a wall of tiles.
3. **Color only where it means something.** The interface itself is ink and paper. Color is kept for the strategy's own line on a chart, for gains (`--up`) and losses (`--down`), and for cautions (`--warn`).
4. **One primary action** per view or card, in solid ink. Everything else is an outlined button or plain text.
5. **Numbers lead, in plain words.** The figure is the largest thing in its block, with a small label above and context below. Labels are sentence case ("Return per year", "Worst drop"), never uppercase. Numerals are tabular so columns line up.
6. **Say what it means.** Every score, flag and chart carries one sentence in everyday language with the number that backs it.
7. **Same on a phone.** One column under 1000px, bottom tab bar under 760px, 16px inputs so iOS doesn't zoom, nothing that needs hover.

## Tokens

**Color roles** (each theme defines all of them for light and dark):
`--bg` page · `--surface` cards · `--raised` wells and inputs · `--line` borders · `--grid` chart gridlines · `--ink` headings and key numbers · `--text` body · `--quiet` labels and notes · `--tint` / `--tint-ink` / `--tint-soft` the accent, text on it, and its pale fill · `--up` `--down` `--warn` (+ `--down-soft`, `--warn-soft` fills) · `--c1`…`--c6` chart series, in order of use.

**Type**: Archivo variable. `--fs-1` 12 labels and captions · `--fs-2` 13 notes · `--fs-3` 14 buttons and tables · `--fs-4` 15 body · `--fs-5` 17 composer · `--fs-6` 20 names and big numbers · `--fs-7` 24 section statements · `--fs-8` 28–40 page titles. Headings are 650–700 weight at normal width; labels are 12–13px in sentence case.

**Space**: a 4px grid. `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 20 · `--s-6` 24 · `--s-8` 32 · `--s-10` 40. Inside a component use `--s-2`/`--s-3`; between components `--s-4`/`--s-5`; between sections `--s-6` and up.

**Shape**: `--r-s` 6 inputs · `--r-m` 8 buttons · `--r-l` 10 cards · `--r-xl` 12 composer, dialogs · `--r-full` chips only.

**Motion**: `--ease` with `--t-fast` (hover, press), `--t-base` (view changes), `--t-slow` (score ring and meters filling). Everything stops under `prefers-reduced-motion`.

## Themes

A theme is a full set of color roles. Set it with `data-theme` on `<html>`; light or dark follows the device unless `data-mode` forces one. The **Look** menu in the app's footer does both and remembers the choice on that device. `?theme=ink&mode=dark` previews a look without saving it.

| Theme | Character |
|---|---|
| **Ink** (default) | Near-black on white with hairlines, like bollineni.co itself; color appears only in charts, gains and losses. |
| **Tide** | Teal on deep green: Ballast's bollineni.co tint carried through the whole surface. |
| **Harbor** | Cobalt on warm paper and navy; calmer and more traditional. |

To add a theme, add an entry to `THEMES` in `tools/tokens.mjs` with every role for light and dark, regenerate, and add it to the list in `theme.js` and the two Look menus. Body text must reach 4.5:1 contrast on `--surface` and `--raised`; `--tint-ink` must reach 4.5:1 on `--tint`.

The logo keeps its own two colors (`--brand-wash`, `--brand-tint`) in every theme.

## Components

| Component | Class | Rules |
|---|---|---|
| Button | `.btn`, `.btn.primary`, `.btn.small` | Rounded rectangle. One `.primary` per view or card. Labels are verbs: "Run test", not "Go". |
| Chip | `.chip`, `.on`, `.bad`, `.active` | Status or a selectable filter. Never a primary action. |
| Card | `.card` | The only raised container. Title is an `h3`; an optional `.note` under it explains the card in one sentence. |
| Metric | `.metric` in `.metrics` | One ruled strip of up to four. Label, value, optional sub-line. Value takes `.pos`/`.neg` only when the sign matters. |
| Field | `.field` in `.fields` | Label above the control. Two columns, one on phones. |
| Tabs | `.tabs` + `.panel` | For views of the same result. Sections of the app use the top bar instead. |
| Table | `table` in `.table-wrap` | Numbers right-aligned (`.num`). Sticky header. Scrolls inside its wrapper, never the page. |
| Messages | `.error`, `.callout`, `.rules-check`, `.findings` | Error = it stopped. Callout = caution. Findings = a title that states the fact and a sentence with the number. |
| Chart | `canvas.chart` (`.tall`, `.short`) | The user's line is `--c1` and solid; comparisons are `--quiet` and dashed. Legend sits in the card header. |
| Score | `.score` | Number, word, one sentence; the five checks open under "Why this score". |
| Fold | `details.fold`, `details.settings` | For anything most visits don't need. Closed by default. |

## Writing

Short, concrete, in the second person. Prefer "Worst drop" to "Maximum drawdown" and "Return per year" to "CAGR"; give the technical term once, in a sub-line, where an expert would look for it. Never promise a result: describe what happened and how often.
