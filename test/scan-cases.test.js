// Case-driven regression: every labelled screenshot in test/cases must read the
// roster a human wrote down for it.
//
// This is the file that would have caught the bugs the older suite missed. The
// old fixtures are all pixel-exact captures, but a real window share arrives
// resampled by the compositor and by display scaling — so the sweep re-reads
// each case at 0.6x-1.5x and demands the same answer.
//
// Add a case by dropping <name>.png + <name>.json into test/cases; nothing here
// needs to change. See scripts/case-set.js for the format, and
// `node scripts/scan-report.js` for the per-slot diagnostic when one fails.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/scan-core.js");
require("../src/scan-aram.js"); // registers mode "aram"
const {
  listCases,
  loadIconHashes,
  geometryError,
} = require("../scripts/case-set.js");

const SLOW = process.env.SCAN_FULL
  ? false
  : "slow; run `npm run test:full` (SCAN_FULL=1) for the resample sweep";
const iconHashById = loadIconHashes();
const cases = listCases();

test("there are labelled cases to regress against", () => {
  assert.ok(cases.length >= 5, `expected several cases, found ${cases.length}`);
});

// Box-filtered resample — what a compositor or a DPI-scaled window share does to
// the frame before the pipeline ever sees it.
function rescale(f, s) {
  if (Math.abs(s - 1) < 1e-9) return f;
  const W = Math.round(f.W * s),
    H = Math.round(f.H * s);
  const buf = new Uint8ClampedArray(W * H * 4);
  const k = s < 1 ? Math.max(1, Math.round(1 / s)) : 1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = Math.min(f.W - 1, (x + 0.5) / s - 0.5);
      const sy = Math.min(f.H - 1, (y + 0.5) / s - 0.5);
      const x0 = Math.max(0, Math.floor(sx)),
        y0 = Math.max(0, Math.floor(sy));
      for (let c = 0; c < 4; c++) {
        let acc = 0,
          n = 0;
        for (let dy = 0; dy < k; dy++)
          for (let dx = 0; dx < k; dx++) {
            const u = Math.min(f.W - 1, x0 + dx),
              v = Math.min(f.H - 1, y0 + dy);
            acc += f.buf[(v * f.W + u) * 4 + c];
            n++;
          }
        buf[(y * W + x) * 4 + c] = acc / n;
      }
    }
  return { buf, W, H };
}

/** Read one case at one scale and return the 15 ids in template order. */
function readCase(c, scale) {
  const frame = rescale(c.frame(), scale);
  const r = core.runFrameRead(core.pipelineForMode("aram"), frame, {
    iconHashById,
    frameIsClient: c.frameIsClient,
  });
  if (!r.client) return null;
  const ids = [...r.benchSlots, ...r.pickCircles].map((p) =>
    p.verdict === "reject" || !p.m ? null : p.m.id,
  );
  ids.client = r.client;
  return ids;
}

/** Compare a read against the labels. "?" means "filled, identity not asserted". */
function diff(got, want) {
  const bad = [];
  want.forEach((w, i) => {
    const g = got[i];
    const label = (i < 10 ? "b" : "a") + (i < 10 ? i : i - 10);
    if (w === "?") {
      if (g == null) bad.push(`${label}: expected something, got nothing`);
    } else if (g !== w) {
      bad.push(`${label}: expected ${w === null ? "(empty)" : w}, got ${g}`);
    }
  });
  return bad;
}

for (const c of cases) {
  const want = [...c.bench, ...c.allies];

  test(`case ${c.name}: ${
    c.expect === "decline" ? "declines" : "reads its roster"
  }`, () => {
    const got = readCase(c, 1);
    if (c.expect === "decline") {
      assert.equal(got, null, `${c.name} should decline — ${c.note}`);
      return;
    }
    assert.ok(got, `${c.name} should locate champion select`);
    // Boxes first: with a labelled rect, the geometry must hold on its own,
    // not just happen to produce the right names.
    if (c.boxes || c.client) {
      const err = geometryError(c.boxes || c.client, got.client);
      assert.ok(err <= 0.25, `${c.name} boxes off by ${err.toFixed(2)} cells`);
    }
    assert.deepEqual(diff(got, want), [], `${c.name} misread`);
  });

  // A shared window is almost never delivered at its true pixel size, so the
  // roster has to survive resampling. Two different promises, because they are
  // worth different things:
  //
  //   0.9x and up   read it exactly. This is the range real captures live in.
  //   below that    you may say "I can't", but you may not make something up.
  //                 At 0.6x a 1274px capture is 764px wide and an ally portrait
  //                 is 29 pixels across; the honest answer there is a decline or
  //                 an uncertain read, never a confident wrong roster.
  test(
    `case ${c.name}: reads the same roster from 0.9x to 1.5x`,
    { skip: SLOW },
    () => {
      const failures = [];
      for (const s of [0.9, 1.0, 1.1, 1.25, 1.5]) {
        const got = readCase(c, s);
        if (c.expect === "decline") {
          if (got) failures.push(`@${s}: read a roster, expected a decline`);
          continue;
        }
        if (!got) {
          failures.push(`@${s}: declined`);
          continue;
        }
        for (const d of diff(got, want)) failures.push(`@${s} ${d}`);
      }
      assert.deepEqual(failures, [], `${c.name} degraded under resampling`);
    },
  );

  test(
    `case ${c.name}: declines rather than guessing below 0.9x`,
    { skip: SLOW },
    () => {
      const failures = [];
      for (const s of [0.6, 0.7, 0.8]) {
        const got = readCase(c, s);
        if (!got) continue; // an honest "I can't" is always allowed down here
        if (c.expect === "decline") {
          failures.push(`@${s}: read a roster, expected a decline`);
          continue;
        }
        const wrong = diff(got, want).length;
        if (wrong > 2)
          failures.push(`@${s}: ${wrong} of 15 slots wrong — that is a guess`);
      }
      assert.deepEqual(failures, [], `${c.name} guessed at a small scale`);
    },
  );
}
