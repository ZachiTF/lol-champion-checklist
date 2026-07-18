// Regression tests for the screenshot scan pipeline (src/scan-core.js).
//
// These pin the tuned behaviour so future changes to the geometry, perceptual
// hash, color signature, or thresholds can't silently break champion detection.
// Everything runs offline against committed fixtures:
//   - test/fixtures/aram-bench.png   a real ARAM bench bar (names blacked out)
//   - test/fixtures/icon-hashes.json champion hashes (patch 16.14.1, this algo)
//
// Run: npm test   (needs the pngjs devDependency to decode the fixture PNG)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");
const core = require("../src/scan-core.js");

const FIX = path.join(__dirname, "fixtures");

// Rebuild the icon-hash Map the pipeline uses: bench squares match the full icon
// (h/sig); team circles match a center-crop (hC/sigC).
const iconFixture = JSON.parse(
  fs.readFileSync(path.join(FIX, "icon-hashes.json"), "utf8"),
);
const iconHashById = new Map(
  iconFixture.items.map((it) => [
    it.id,
    {
      h: BigInt("0x" + it.h),
      sig: it.sig,
      hC: BigInt("0x" + it.hC),
      sigC: it.sigC,
    },
  ]),
);

// Decode the screenshot fixture into the same RGBA layout as a canvas ImageData.
const png = PNG.sync.read(fs.readFileSync(path.join(FIX, "aram-bench.png")));
const { width: W, height: H, data: buf } = png;

// Run the pipeline once; reuse across tests.
const bench = core.detectBenchRow(buf, W, H);
const results = bench.slots.map((slot) => {
  const m = core.matchSlot(buf, W, H, slot, iconHashById);
  return { m, verdict: core.classifyMatch(m) };
});
const detected = results
  .filter((r) => r.verdict !== "reject")
  .map((r) => r.m.id);

const EXPECTED = [
  "Gragas",
  "XinZhao",
  "Zeri",
  "Yasuo",
  "AurelionSol",
  "Elise",
  "Lissandra",
];

test("detectBenchRow finds a plausible 10-slot bench", () => {
  assert.ok(bench, "bench row should be detected");
  assert.equal(bench.slots.length, 10);
  assert.ok(
    bench.bandH > 20 && bench.bandH < 120,
    `bandH ${bench.bandH} out of range`,
  );
});

test("detects exactly the seven filled champions, in bench order", () => {
  assert.deepEqual(detected, EXPECTED);
});

test("rejects the three empty bench slots", () => {
  const rejected = results.filter((r) => r.verdict === "reject").length;
  assert.equal(rejected, 3);
});

test("every accepted match is confident (color distance is the discriminator)", () => {
  for (const { m, verdict } of results) {
    if (verdict === "reject") continue;
    assert.ok(
      m.color <= core.SCAN_MAYBE_COLOR,
      `${m.id} color ${m.color} exceeds MAYBE threshold`,
    );
  }
  // With the current tuning all seven are firmly "accept", none "maybe".
  const accepted = results.filter((r) => r.verdict === "accept").length;
  assert.equal(accepted, EXPECTED.length);
});

test("empty slots sit far from any champion in color space", () => {
  // The empties may fluke a low Hamming distance, so color must carry the
  // separation. Every rejected slot's best match should be clearly far.
  const rejects = results.filter((r) => r.verdict === "reject");
  for (const { m } of rejects) {
    assert.ok(
      m.color > core.SCAN_MAYBE_COLOR,
      `reject color ${m.color} too close`,
    );
  }
});

// ---- team-pick circles (the 5 locked champions down the left) ----
const circles = core.detectTeamCircles(buf, W, H);
const circleResults = (circles || []).map((c) => {
  const m = core.matchCircle(buf, W, H, c, iconHashById);
  return { m, verdict: core.classifyCircleMatch(m) };
});
const circleIds = circleResults
  .filter((r) => r.verdict !== "reject")
  .map((r) => r.m.id);
const EXPECTED_CIRCLES = ["Velkoz", "Malphite", "Vex", "Xerath", "Aphelios"];

test("detectTeamCircles finds the five team portraits", () => {
  assert.ok(circles, "circle column should be detected");
  assert.equal(circles.length, 5);
});

test("identifies all five team-pick champions, top to bottom", () => {
  assert.deepEqual(circleIds, EXPECTED_CIRCLES);
});

test("bench and circles together produce the full visible roster", () => {
  const all = [...new Set([...detected, ...circleIds])];
  assert.equal(all.length, EXPECTED.length + EXPECTED_CIRCLES.length);
});
