// Regression tests for the HARDCODED ARAM: Mayhem reader (src/scan-aram.js).
//
// This is the default pipeline, so what is pinned here is the promise it makes:
// given the champ-select client rectangle, the 15 icon positions are exact
// arithmetic, and the rectangle itself is recovered from a frame without
// looking at a single champion icon.
//
// Fixtures (all committed, everything runs offline):
//   aram-bench.png    a window-share capture — the frame IS the client
//   aram-desktop.png  a windowed client on a busy desktop, 0.6x scale
//   aram-bench-2.png  a screenshot cropped INTO the client (its own borders are
//                     off-frame) — the case the template cannot pin down, kept
//                     here to pin the honest "I don't know" instead
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");
const core = require("../src/scan-core.js");
const aram = require("../src/scan-aram.js");

const FIX = path.join(__dirname, "fixtures");
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
function loadFrame(name) {
  const png = PNG.sync.read(fs.readFileSync(path.join(FIX, name)));
  return { buf: png.data, W: png.width, H: png.height };
}

const windowShare = loadFrame("aram-bench.png"); // 1274x706, frame == client
const desktop = loadFrame("aram-desktop.png"); // 1152x648, client is a window
const cropped = loadFrame("aram-bench-2.png"); // 1063x696, cropped into client

// Ground truth, from the app's own expectations for these fixtures.
const SHARE_BENCH = [
  "Gragas",
  "XinZhao",
  "Zeri",
  "Yasuo",
  "AurelionSol",
  "Elise",
  "Lissandra",
];
const SHARE_CIRCLES = ["Velkoz", "Malphite", "Vex", "Xerath", "Aphelios"];
const DESKTOP_BENCH = [
  "Graves",
  "Nilah",
  "Braum",
  "Talon",
  "Blitzcrank",
  "Thresh",
  "Nautilus",
  "Elise",
];
const DESKTOP_CIRCLES = [
  "Nidalee",
  "Tristana",
  "Pantheon",
  "MissFortune",
  "Ashe",
];

function read(frame, ctx) {
  return core.runFrameRead(core.pipelineForMode("aram"), frame, {
    iconHashById,
    ...ctx,
  });
}
const kept = (positions) =>
  positions.filter((p) => p.verdict !== "reject").map((p) => p.m.id);

// ---- the template itself: pure arithmetic, no pixels ----------------------

test("registers itself as the default scan mode", () => {
  assert.equal(core.SCAN_DEFAULT_MODE, "aram");
  assert.ok(core.SCAN_MODES.aram, "scan-aram.js should register mode 'aram'");
  assert.ok(
    core.SCAN_MODES["aram-adaptive"],
    "the searching pipeline stays available as the fallback",
  );
});

test("places 10 bench squares and 5 ally circles from the client rect alone", () => {
  const spots = aram.aramTemplateSpots({ x: 0, y: 0, w: 1280, h: 720 });
  const bench = spots.filter((s) => s.kind === "bench");
  const circles = spots.filter((s) => s.kind === "circle");
  assert.equal(bench.length, 10);
  assert.equal(circles.length, 5);
  // Measured on the 1280x720 reference (see scripts/measure-layout.js).
  assert.equal(Math.round(bench[0].cx), 377);
  assert.equal(Math.round(bench[0].cy), 35);
  assert.equal(bench[0].size, 48);
  assert.equal(Math.round(bench[9].cx - bench[0].cx), 527); // 9 x 58.6 pitch
  assert.ok(
    bench.every((s) => s.cy === bench[0].cy),
    "the bench is one row",
  );
  assert.equal(Math.round(circles[0].cx), 85);
  assert.equal(Math.round(circles[0].cy), 135);
  assert.equal(Math.round(circles[4].cy - circles[0].cy), 319); // 4 x 79.75
});

test("the template scales and translates with the client rect", () => {
  const a = aram.aramTemplateSpots({ x: 0, y: 0, w: 1280, h: 720 });
  const b = aram.aramTemplateSpots({ x: 100, y: 50, w: 640, h: 360 });
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(b[i].cx - (100 + a[i].cx / 2)) < 0.001, `spot ${i} x`);
    assert.ok(Math.abs(b[i].cy - (50 + a[i].cy / 2)) < 0.001, `spot ${i} y`);
  }
});

// ---- the alignment score: identity-free, sharp, local ----------------------

test("the alignment score peaks at the true client rect", () => {
  // aram-bench.png is a window capture, so the client is the frame (give or
  // take the 3px the capture trims off the window border).
  const truth = { x: 0, y: 0, w: windowShare.W, h: windowShare.H };
  const best = aram.aramTemplateScore(windowShare, truth);
  assert.ok(best > aram.ARAM_MIN_TEMPLATE_SCORE, `truth scored only ${best}`);
  // A slip of 8px in any direction must cost most of the score — that sharpness
  // is what makes the refinement able to find the right answer at all.
  for (const off of [
    { x: 8 },
    { x: -8 },
    { y: 8 },
    { y: -8 },
    { w: truth.w * 1.03, h: truth.h * 1.03 },
  ]) {
    const s = aram.aramTemplateScore(windowShare, { ...truth, ...off });
    assert.ok(
      s < best * 0.75,
      `offset ${JSON.stringify(off)} scored ${s.toFixed(1)} vs ${best.toFixed(
        1,
      )}`,
    );
  }
});

test("locating needs no champion hashes at all", () => {
  // The whole locate stage is identity-free: hand it no hash map and it must
  // still find the client. (The hashes only ever break ties between candidates.)
  const c = aram.locateAramClient(desktop, {});
  assert.ok(c, "should locate without a champion database");
  assert.ok(Math.abs(c.x - 191) <= 8, `client x ${c.x}`);
  assert.ok(Number.isFinite(aram.aramTemplateScore(desktop, c)));
});

// ---- finding the window rectangle -----------------------------------------

test("finds the League window in a full desktop capture", () => {
  const wins = aram.findClientWindows(desktop);
  assert.ok(wins.length, "should find at least one 16:9 rectangle");
  const top = wins[0];
  // The client sits at (191, 94) and is 768x432 in this 0.6x-scaled capture.
  assert.ok(Math.abs(top.x - 191) <= 6, `x ${top.x}`);
  assert.ok(Math.abs(top.y - 94) <= 6, `y ${top.y}`);
  assert.ok(Math.abs(top.w - 768) <= 12, `w ${top.w}`);
});

test("finds no inner window when the frame IS the client", () => {
  // A window share has no client borders inside it, and reporting none is the
  // correct answer — the whole-frame seed takes over from there.
  assert.deepEqual(aram.findClientWindows(windowShare), []);
});

// ---- locating + reading ----------------------------------------------------

test("window share: reads the full roster with no window search at all", () => {
  const r = read(windowShare, { frameIsClient: true });
  assert.ok(r.client, "should locate the client");
  assert.deepEqual(kept(r.benchSlots), SHARE_BENCH);
  assert.deepEqual(kept(r.pickCircles), SHARE_CIRCLES);
  assert.ok(r.verify.ok, `layout should verify — ${r.verify.reason}`);
});

test("desktop capture: locates the windowed client and reads the roster", () => {
  const r = read(desktop, {});
  assert.ok(r.client, "should locate the client");
  assert.ok(Math.abs(r.client.x - 191) <= 8, `client x ${r.client.x}`);
  assert.ok(Math.abs(r.client.y - 94) <= 8, `client y ${r.client.y}`);
  assert.deepEqual(kept(r.benchSlots), DESKTOP_BENCH);
  assert.deepEqual(kept(r.pickCircles), DESKTOP_CIRCLES);
});

test("says it cannot find champion select rather than guessing", () => {
  // aram-bench-2.png is cropped INTO the client, so neither the frame nor any
  // rectangle in it is the client. The adaptive reader handles this one; the
  // template must decline instead of returning a confident wrong rectangle.
  const r = read(cropped, {});
  assert.equal(r.client, null);
  // ...and the fallback the UI offers does read it.
  const alt = core.runFrameRead(
    core.pipelineForMode("aram-adaptive"),
    cropped,
    {
      iconHashById,
    },
  );
  assert.ok(alt.client, "the adaptive reader should still cope");
});

test("blank frame: no client, no throw", () => {
  const blank = { buf: new Uint8ClampedArray(200 * 150 * 4), W: 200, H: 150 };
  const r = read(blank, {});
  assert.equal(r.client, null);
  assert.equal(aram.locateAramClient(blank, {}), null);
});

// ---- the exactness claim ---------------------------------------------------

test("exact positions make the wide per-slot search unnecessary", () => {
  // The whole point of the hardcoded layout: the crop already lands on the
  // icon, so the cheap tight search must agree with the expensive wide one.
  const tight = read(windowShare, { frameIsClient: true });
  const wide = read(windowShare, { frameIsClient: true, wideSearch: true });
  assert.deepEqual(kept(tight.benchSlots), kept(wide.benchSlots));
  assert.deepEqual(kept(tight.pickCircles), kept(wide.pickCircles));
});

test("a cached client rect skips the locate stage entirely", () => {
  const first = read(windowShare, { frameIsClient: true });
  const cached = read(windowShare, {
    frameIsClient: true,
    client: first.client,
  });
  assert.deepEqual(kept(cached.benchSlots), kept(first.benchSlots));
  assert.ok(cached.timings.locateMs <= first.timings.locateMs);
});
