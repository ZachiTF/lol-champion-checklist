// Tests for the debug-only generic grid detector (src/scan-grids.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");
const gridLib = require("../src/scan-grids.js");

const png = PNG.sync.read(
  fs.readFileSync(path.join(__dirname, "fixtures", "aram-bench.png")),
);
const { width: W, height: H, data: buf } = png;

// ---- generic grid-structure detection (identity-free) ----
// The structure-first layer: find a periodic square-cell grid WITHOUT the champion
// database, so a scenario matcher can decide what the grid is by shape/position.
test("autocorrPitch recovers the period of a synthetic comb", () => {
  const P = new Float64Array(600);
  for (let i = 0; i < 600; i += 40) P[i] = 1;
  const r = gridLib.autocorrPitch(P, 24, 220);
  assert.equal(r.pitch, 40, "dominant period is the comb spacing");
  assert.ok(r.strength > 0.5, `should be a strong period, got ${r.strength}`);
});

test("combPhaseCount counts cells between strong borders", () => {
  const P = new Float64Array(600);
  for (const b of [50, 110, 170, 230, 290]) P[b] = 10; // 5 borders → 4 cells
  const r = gridLib.combPhaseCount(P, 60);
  assert.equal(r.count, 4);
  assert.ok(Math.abs(r.origin - 50) <= 2, `origin near 50, got ${r.origin}`);
});

test("detectGrids finds the bench as a single row of ~59px cells", () => {
  // The bench sits in the top strip; restricting the band is the localization job
  // a position-prior detector will own — here we verify the geometry it recovers.
  const { grids } = gridLib.detectGrids(
    { buf, W, H },
    { region: { x: 300, y: 0, w: 700, h: 90 } },
  );
  assert.ok(grids.length, "a grid should be found in the bench band");
  const g = grids[0];
  assert.ok(g.pitchX >= 54 && g.pitchX <= 64, `pitchX ~59, got ${g.pitchX}`);
  assert.equal(g.rows, 1, "the bench is a single row");
  assert.ok(g.cols >= 3, `several columns, got ${g.cols}`);
  assert.equal(g.source, "projection");
});
