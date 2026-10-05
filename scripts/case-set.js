// Shared loader for labelled scan cases (Node only).
//
// A CASE is a screenshot plus the roster a human read off it. Cases are the
// evidence this scanner is tuned against: scripts/scan-report.js measures with
// them, test/scan-cases.test.js regresses against them, and scan-debug.html
// exports new ones straight out of a failing live scan.
//
// test/cases/<name>.json
//   {
//     "image":   "../fixtures/aram-bench.png",  // relative to the .json
//     "surface": "window" | "monitor" | "browser",
//     "bench":   [10 entries],   // champion id | null (empty slot) | "?" (filled,
//     "allies":  [5 entries],    //   identity deliberately not asserted)
//     "client":  {x,y,w,h},      // optional: the client rect the boxes were
//                                //   placed from (informational)
//     "boxes":   [15 x {kind, cx, cy, size}]  // optional: where the 15 icons
//                                //   really are, frame px (size = square side /
//                                //   ring diameter). The ground truth for
//                                //   geometry — independent of the template.
//     "expect":  "read" | "decline",            // optional, default "read"
//     "note":    "free text",                   // optional
//     "labelled": false          // optional: a recorded frame nobody has
//   }                            //   labelled yet — listed by nothing here
//
// Recorded sessions (scan-debug.html "Record samples", unpacked by
// scripts/import-recording.js) use the same format, one folder per session;
// listCases(dir) walks subfolders so a whole dataset is one argument.
//
// A case ships its PNG next to it, so cases are self-contained and offline.
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const ROOT = path.join(__dirname, "..");
const CASE_DIR = path.join(ROOT, "test", "cases");
const FIX_DIR = path.join(ROOT, "test", "fixtures");

/** The committed reference hash set — one entry per champion, patch-stamped. */
function loadIconHashes() {
  const fx = JSON.parse(
    fs.readFileSync(path.join(FIX_DIR, "icon-hashes.json"), "utf8"),
  );
  return new Map(
    fx.items.map((it) => [
      it.id,
      {
        h: BigInt("0x" + it.h),
        sig: it.sig,
        hC: BigInt("0x" + it.hC),
        sigC: it.sigC,
      },
    ]),
  );
}

/** Decode a PNG into the {buf,W,H} frame shape the pipeline consumes. */
function loadFrame(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { buf: png.data, W: png.width, H: png.height };
}

/** Every .json under dir (recursively), as paths sorted for a stable order. */
function caseFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...caseFiles(p));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out.sort();
}

/**
 * Every labelled case under `dir` (default test/cases/), sorted by path. A case
 * in a subfolder is named "<folder>/<file>". Reading the PNG is deferred to
 * `c.frame()` so a report can pick a subset without decoding megabytes.
 */
function listCases(dir = CASE_DIR) {
  return caseFiles(dir)
    .map((file) => ({ file, c: JSON.parse(fs.readFileSync(file, "utf8")) }))
    .filter(({ c }) => c.labelled !== false)
    .map(({ file, c }) => {
      const image = path.resolve(path.dirname(file), c.image);
      return {
        name: path
          .relative(dir, file)
          .replace(/\.json$/, "")
          .split(path.sep)
          .join("/"),
        file,
        image,
        surface: c.surface || "monitor",
        // A window or tab share IS the client: the window hunt is skipped.
        frameIsClient: c.surface === "window" || c.surface === "browser",
        bench: c.bench || [],
        allies: c.allies || [],
        client: c.client || null,
        boxes: c.boxes || null,
        expect: c.expect || "read",
        note: c.note || "",
        frame: () => loadFrame(image),
      };
    });
}

/** The 15 labels in pipeline order: 10 bench squares, then 5 ally circles. */
function expectedSpots(c) {
  return [
    ...c.bench.map((id, i) => ({
      kind: "bench",
      index: i,
      label: "b" + i,
      id,
    })),
    ...c.allies.map((id, i) => ({
      kind: "circle",
      index: i,
      label: "a" + i,
      id,
    })),
  ];
}

/**
 * How far the boxes a read put down are from where they belong, in BENCH CELLS:
 * the worst centre offset over all 15 spots, divided by the true bench cell
 * size. Under ~0.15 the matcher's own local search absorbs it; over ~0.3 the
 * crop is no longer on the icon and no name can be trusted. This is the number
 * that says "the boxes are in the wrong place" — check it before any name.
 *
 * `truth` is a case's labelled boxes (preferred — they don't depend on the
 * template) or, for older labels, its client rect.
 */
function geometryError(truth, got) {
  const { aramTemplateSpots } = require("../src/scan-aram.js");
  const want = Array.isArray(truth) ? truth : aramTemplateSpots(truth);
  const cell = Array.isArray(truth)
    ? truth[0].size
    : aramTemplateSpots(truth)[0].size;
  const b = aramTemplateSpots(got);
  let worst = 0;
  want.forEach((s, i) => {
    worst = Math.max(worst, Math.hypot(s.cx - b[i].cx, s.cy - b[i].cy) / cell);
  });
  return worst;
}

/**
 * Freeze a rect-only label into absolute boxes with the CURRENT template —
 * the same thing scan-debug.html saves. Do it as soon as a label arrives, so a
 * later template change can't move the boxes the human verified.
 */
function boxesFromClient(client) {
  const { aramTemplateSpots, ARAM_TEMPLATE } = require("../src/scan-aram.js");
  const r1 = (v) => Math.round(v * 10) / 10;
  const ringD = 2 * ARAM_TEMPLATE.allies.ring * client.w;
  return aramTemplateSpots(client).map((s) => ({
    kind: s.kind,
    cx: r1(s.cx),
    cy: r1(s.cy),
    size: r1(s.kind === "circle" ? ringD : s.size),
  }));
}

module.exports = {
  boxesFromClient,
  geometryError,
  ROOT,
  CASE_DIR,
  FIX_DIR,
  loadIconHashes,
  loadFrame,
  listCases,
  expectedSpots,
};
