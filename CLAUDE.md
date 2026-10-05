# Notes for working on this repo

Zero-install browser app: classic `<script>`s sharing globals, no build step,
works from `file://`. Keep it that way. Commits go straight to `main`; the
pre-commit hook runs Prettier + `npm test`.

## Champion scanner (src/scan-\*.js) — read before touching it

**The owner's diagnosis: when the scanner is wrong, the BOXES are wrong.**
If the 15 boxes (10 bench squares, 5 ally circles) sit on the icons, mapping
them to champions is the easy part. So judge a read in this order:

1. Did it find champ select at all (client rect, or a decline)?
2. Are the boxes on the icons? (geometry — measured in bench cells)
3. Only then: are the names right?

Never tune the matcher to fix what is really a geometry error, and never call
a read "correct" from the names alone.

**Look at the image.** Real frames live in `test_data/recordings/` (gitignored).
Open the PNG and check where the boxes are before trusting any number.

**Measure with labelled geometry.** A case JSON carries `"boxes"`: the 15
icons' TRUE positions in frame pixels (`{kind, cx, cy, size}`, size = square
side / gold-ring diameter), set by hand in `scan-debug.html`. They are
deliberately NOT stored as a client rect alone — a rect only means "where the
current template puts the boxes" and silently changes meaning whenever the
template is re-measured. Older rect-only labels are frozen into boxes on
import.
`node scripts/scan-report.js --dir=test_data/recordings` then prints
`boxes vs labelled: off by N cells` per frame and a `BOXES` total; over 0.25
cells the crop is off the icon. `test/scan-cases.test.js` asserts the same.

**Getting real data** (only possible while the owner plays):
`scan-debug.html` → Go live → ⏺ Record samples → after the game ✎ Review &
label (📐 Place boxes = click bench slot 0's centre, then the 5th ally's
centre; 🧲 Snap / `S` fits the gold ally rings to <1 px; arrows nudge ½ px,
Shift = 5 px; every card shows a 3× crop of its box; names are re-read at your
boxes) → ⬇ Export .zip →
`node scripts/import-recording.js <zip>` (→ `test_data/recordings/`). Labels save on every edit (the
review bar shows ✓ saved); `⤒ Import .zip` loads an export back in to label it.

**Traps that already cost a session each:**

- `scan-debug.html`'s "generic grid detector" (detectGrids) is NOT the reader;
  nothing consumes it and its boxes land on unrelated UI. It is collapsed at the
  bottom for that reason. The reader's boxes are the ones in the label step.
- Browser ≠ Node. In a classic script a top-level `const` is not on
  `globalThis`; cross-file access goes through the `SCAN_CORE` object, never
  `globalThis`. `test/scan-classic-scripts.test.js` loads the files the way the
  page and the worker do — keep it passing.
- Template fractions (`ARAM_TEMPLATE` in `src/scan-aram.js`) were measured
  with `scripts/measure-layout.js`; re-measure there, don't hand-edit.
