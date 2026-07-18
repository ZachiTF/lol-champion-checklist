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
const bench = core.findBenchBar(buf, W, H);
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

test("findBenchBar finds a plausible 10-slot bench", () => {
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

// ---- locate-stage robustness: a "full desktop" print screen ----
// The pipeline must find the client anywhere in the frame and at any scale, not
// just when the screenshot is cropped exactly to the client. Synthesize those
// cases in-memory from the committed fixture (translate / bilinear-scale it onto
// a larger canvas) so no extra binary fixtures are needed.
function embed(src, sw, sh, CW, CH, ox, oy, scale) {
  const out = Buffer.alloc(CW * CH * 4); // zeroed = black "desktop"
  const bil = (ch, fx, fy) => {
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy),
      x1 = Math.min(sw - 1, x0 + 1),
      y1 = Math.min(sh - 1, y0 + 1);
    const tx = fx - x0,
      ty = fy - y0;
    const p = (xx, yy) => src[(yy * sw + xx) * 4 + ch];
    return (
      (p(x0, y0) * (1 - tx) + p(x1, y0) * tx) * (1 - ty) +
      (p(x0, y1) * (1 - tx) + p(x1, y1) * tx) * ty
    );
  };
  const dw = Math.round(sw * scale),
    dh = Math.round(sh * scale);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const dx = ox + x,
        dy = oy + y;
      if (dx < 0 || dx >= CW || dy < 0 || dy >= CH) continue;
      const fx = Math.min(sw - 1, x / scale),
        fy = Math.min(sh - 1, y / scale);
      const di = (dy * CW + dx) * 4;
      out[di] = bil(0, fx, fy);
      out[di + 1] = bil(1, fx, fy);
      out[di + 2] = bil(2, fx, fy);
      out[di + 3] = 255;
    }
  }
  return out;
}

function detectAll(b, w, h) {
  const bench = core.findBenchBar(b, w, h);
  if (!bench) return null;
  const benchIds = [];
  for (const slot of bench.slots) {
    const m = core.matchSlot(b, w, h, slot, iconHashById);
    if (core.classifyMatch(m) !== "reject" && !benchIds.includes(m.id))
      benchIds.push(m.id);
  }
  const circ = core.detectTeamCircles(b, w, h) || [];
  const circleIds2 = [];
  for (const c of circ) {
    const m = core.matchCircle(b, w, h, c, iconHashById);
    if (core.classifyCircleMatch(m) !== "reject" && !circleIds2.includes(m.id))
      circleIds2.push(m.id);
  }
  return { bench, benchIds, circleIds: circleIds2 };
}

test("locates the bench when the client is offset in a larger frame", () => {
  const CW = 1900,
    CH = 1100,
    ox = 360,
    oy = 240;
  const b = embed(buf, W, H, CW, CH, ox, oy, 1.0);
  const r = detectAll(b, CW, CH);
  assert.ok(r, "bench should be located in the offset frame");
  // bench center should track the translation (within a slot pitch)
  assert.ok(
    Math.abs(r.bench.center - (ox + W / 2)) <= r.bench.pitch,
    `bench center ${Math.round(r.bench.center)} not near ${ox + W / 2}`,
  );
  assert.deepEqual(r.benchIds, EXPECTED);
  assert.deepEqual(r.circleIds, EXPECTED_CIRCLES);
});

test("detects champions when the client is scaled up (higher-res capture)", () => {
  const scale = 1.25;
  const CW = Math.round(W * scale) + 400,
    CH = Math.round(H * scale) + 300;
  const b = embed(buf, W, H, CW, CH, 180, 120, scale);
  const r = detectAll(b, CW, CH);
  assert.ok(r, "bench should be located in the scaled frame");
  assert.ok(
    Math.abs(r.bench.pitch - 59 * scale) <= 6,
    `scaled pitch ${r.bench.pitch} not near ${Math.round(59 * scale)}`,
  );
  assert.deepEqual(r.benchIds, EXPECTED);
  assert.deepEqual(r.circleIds, EXPECTED_CIRCLES);
});
