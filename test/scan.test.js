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

// The augmentation sweeps re-run the locate stage on many variants and are slow;
// gate them so the pre-commit run stays quick. Enable with SCAN_FULL=1 (or
// `npm run test:full`) for the complete robustness suite.
const SLOW =
  process.env.SCAN_FULL === "1"
    ? {}
    : {
        skip: "slow; run `npm run test:full` (SCAN_FULL=1) for the full sweep",
      };

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
const bench = core.findBenchBar(buf, W, H, iconHashById);
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
const circles = core.detectTeamCircles(buf, W, H, iconHashById);
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
  const bench = core.findBenchBar(b, w, h, iconHashById);
  if (!bench) return null;
  const benchIds = [];
  for (const slot of bench.slots) {
    const m = core.matchSlot(b, w, h, slot, iconHashById);
    if (core.classifyMatch(m) !== "reject" && !benchIds.includes(m.id))
      benchIds.push(m.id);
  }
  const circ = core.detectTeamCircles(b, w, h, iconHashById) || [];
  const circleIds2 = [];
  for (const c of circ) {
    const m = core.matchCircle(b, w, h, c, iconHashById);
    if (core.classifyCircleMatch(m) !== "reject" && !circleIds2.includes(m.id))
      circleIds2.push(m.id);
  }
  return { bench, benchIds, circleIds: circleIds2 };
}

// ---- augmentation helpers (realistic screenshot variations) ----
const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function addNoise(b, amp, seed) {
  const rnd = lcg(seed),
    o = Buffer.from(b);
  for (let i = 0; i < o.length; i += 4) {
    const n = (rnd() - 0.5) * 2 * amp;
    o[i] = clampByte(o[i] + n);
    o[i + 1] = clampByte(o[i + 1] + n);
    o[i + 2] = clampByte(o[i + 2] + n);
  }
  return o;
}
function blur3(b, W, H) {
  const o = Buffer.from(b);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            s += b[((y + dy) * W + (x + dx)) * 4 + c];
        o[(y * W + x) * 4 + c] = Math.round(s / 9);
      }
  return o;
}
// A cheap stand-in for JPEG recompression: soften, then quantize each channel.
function jpegish(b, W, H) {
  const o = blur3(b, W, H);
  for (let i = 0; i < o.length; i += 4) {
    o[i] = clampByte(Math.round(o[i] / 8) * 8);
    o[i + 1] = clampByte(Math.round(o[i + 1] / 8) * 8);
    o[i + 2] = clampByte(Math.round(o[i + 2] / 8) * 8);
  }
  return o;
}
// The realistic variations a pasted screenshot may have undergone. (Global
// brightness/contrast shifts are intentionally excluded: a screen capture is
// pixel-exact, and the absolute color signature is what separates filled bench
// slots from empty ones.)
function augmentations(buf, W, H) {
  const scaled = (f) => {
    const CW = Math.round(W * f) + 60,
      CH = Math.round(H * f) + 60;
    return { b: embed(buf, W, H, CW, CH, 30, 30, f), w: CW, h: CH };
  };
  return [
    { name: "scale 0.90", ...scaled(0.9) },
    { name: "scale 0.95", ...scaled(0.95) },
    { name: "scale 1.05", ...scaled(1.05) },
    { name: "blur 3x3", b: blur3(buf, W, H), w: W, h: H },
    { name: "noise +-10", b: addNoise(buf, 10, 7), w: W, h: H },
    {
      name: "offset",
      b: embed(buf, W, H, W + 240, H + 160, 140, 90, 1.0),
      w: W + 240,
      h: H + 160,
    },
    { name: "jpeg-ish", b: jpegish(buf, W, H), w: W, h: H },
  ];
}
function assertRobust(label, buf, W, H, expBench, expCircles) {
  for (const v of augmentations(buf, W, H)) {
    const r = detectAll(v.b, v.w, v.h);
    assert.ok(r, `${label} / ${v.name}: layout not found`);
    assert.deepEqual(r.benchIds, expBench, `${label} / ${v.name}: bench`);
    const ok = r.circleIds.filter((id) => expCircles.includes(id)).length;
    assert.ok(
      ok >= 4,
      `${label} / ${v.name}: only ${ok}/5 circles (${r.circleIds})`,
    );
  }
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

// ---- a second, independent ARAM screenshot (different champs, 6-slot bench) ----
// Guards against overfitting the geometry/thresholds to the first screenshot.
const png2 = PNG.sync.read(fs.readFileSync(path.join(FIX, "aram-bench-2.png")));
const r2 = detectAll(png2.data, png2.width, png2.height);
const EXPECTED_2 = ["RekSai", "Corki", "Kled", "Jayce", "Sejuani", "Renata"];
const EXPECTED_2_CIRCLES = [
  "Malzahar",
  "AurelionSol",
  "Fiddlesticks",
  "MissFortune",
  "Mel",
];

test("fixture 2: locates the bench and its six filled champions", () => {
  assert.ok(r2, "layout should be located in the second screenshot");
  assert.deepEqual(r2.benchIds, EXPECTED_2);
});

test("fixture 2: identifies all five team-pick champions", () => {
  assert.deepEqual(r2.circleIds, EXPECTED_2_CIRCLES);
});

// ---- a REAL windowed client on a busy desktop (the hardest real case) ----
// A full-screen capture where the League client is a window over the browser
// (high-edge tab/URL chrome) AND this app's own champion grid — champion icons in
// the background that could be mistaken for the bench. PII (tabs, summoner names,
// chat, taskbar) is pixelated; the window + champion grid are pristine.
const png3 = PNG.sync.read(fs.readFileSync(path.join(FIX, "aram-desktop.png")));
const r3 = detectAll(png3.data, png3.width, png3.height);
const EXPECTED_3 = [
  "Graves",
  "Nilah",
  "Braum",
  "Talon",
  "Blitzcrank",
  "Thresh",
  "Nautilus",
  "Elise",
];
const EXPECTED_3_CIRCLES = [
  "Nidalee",
  "Tristana",
  "Pantheon",
  "MissFortune",
  "Ashe",
];

test("desktop: locates the windowed client amid browser chrome + champion grid", () => {
  assert.ok(r3, "layout should be located in the busy full-screen capture");
  assert.deepEqual(r3.benchIds, EXPECTED_3);
});

test("desktop: identifies all five team-pick champions", () => {
  assert.deepEqual(r3.circleIds, EXPECTED_3_CIRCLES);
});

// ---- swap-cooldown shadow + centered client (real screenshot) ----
// A real capture where one bench champion is under the swap-cooldown shadow (a dark
// radial sweep) and the client is a centered window. PII (summoner names) pixelated.
// Two things this pins: (1) the shadowed champion is still surfaced (occupancy
// rescue) instead of read as an empty slot, and (2) all five team circles resolve,
// including the one a brightness/edge profile would have displaced onto a distractor.
const png4 = PNG.sync.read(
  fs.readFileSync(path.join(FIX, "aram-cooldown.png")),
);
const W4 = png4.width,
  H4 = png4.height;
const bench4 = core.findBenchBar(png4.data, W4, H4, iconHashById);
const slotVerdicts = bench4.slots.map((s) =>
  core.classifyMatch(core.matchSlot(png4.data, W4, H4, s, iconHashById)),
);
const r4 = detectAll(png4.data, W4, H4);
const EXPECTED_4_CLEAR = [
  "Zeri",
  "Anivia",
  "Gwen",
  "Yunara",
  "Taliyah",
  "Karma",
  "Akshan",
  "JarvanIV",
];
const EXPECTED_4_CIRCLES = ["Nautilus", "Sion", "Thresh", "Varus", "Seraphine"];

test("cooldown: the swap-cooldown champion is surfaced, not dropped as empty", () => {
  // Slot 4 carries the cooldown shadow; its identity is at the noise floor under
  // the shadow, but it must not be rejected as an empty slot (issue #1).
  assert.equal(slotVerdicts[4], "maybe");
  // The one genuinely empty slot (last) is still rejected.
  assert.equal(slotVerdicts[9], "reject");
});

test("cooldown: the eight clearly-visible bench champions are all recognized", () => {
  for (const id of EXPECTED_4_CLEAR)
    assert.ok(r4.benchIds.includes(id), `bench should include ${id}`);
});

test("cooldown: all five team-pick champions resolve on a centered client", () => {
  assert.deepEqual(r4.circleIds, EXPECTED_4_CIRCLES);
});

// ---- windowed client on a busy desktop (browser chrome + high-contrast UI) ----
// Reproduces the real failure: a full-screen print where the League client is a
// window and other UI has FAR higher edge energy than the bench. The old locator
// gated candidate bands on the global-max edge energy, so the bench was hidden and
// nothing was found. Paint a high-contrast distractor band stronger than the bench
// and assert the bench is still located (by periodicity + champion content).
test("locates the bench under a higher-contrast distractor (browser chrome)", () => {
  const CW = 1900,
    CH = 1200,
    ox = 340,
    oy = 520;
  const b = embed(buf, W, H, CW, CH, ox, oy, 1.0);
  // a dense vertical-stripe band (like tab/URL text) with much higher edge energy
  for (let y = 60; y < 96; y++)
    for (let x = 0; x < CW; x++) {
      const i = (y * CW + x) * 4;
      const v = x % 4 < 2 ? 15 : 240;
      b[i] = b[i + 1] = b[i + 2] = v;
      b[i + 3] = 255;
    }
  const r = detectAll(b, CW, CH);
  assert.ok(
    r,
    "bench should still be located under a high-contrast distractor",
  );
  assert.deepEqual(r.benchIds, EXPECTED);
  assert.deepEqual(r.circleIds, EXPECTED_CIRCLES);
});

// ---- temporal consensus across live frames (identity, recent window) ----
// The live loop keeps only the last few frames and votes by champion IDENTITY,
// not position (champ select fills in over time and bench champions get swapped
// around). Readiness is driven by the five team circles: once all five show a
// champion for a couple of frames the read is stable. These synthetic tests pin
// the vote logic; the video-chain test below exercises it on real pixels.
const mk = (id, score, alts) => ({
  id,
  score: score == null ? 5 : score,
  ham: 8,
  color: 10,
  alts: (alts || []).map((a) => ({ id: a })),
});
// A frame = { bench:[{m,verdict}], picks:[{m,verdict}] }. Helper to build picks
// where the first `n` circles show a champion and the rest are grey placeholders.
const picksFilled = (n, verdict) =>
  ["Ashe", "Vex", "Sion", "Thresh", "Varus"].map((id, i) =>
    i < n
      ? { m: mk(id), verdict: verdict || "accept" }
      : { m: null, verdict: "reject" },
  );
function feed(frames, opts) {
  const agg = core.createScanAggregator(opts);
  for (const f of frames)
    core.aggregateFrame(agg, f.bench || [], f.picks || []);
  return core.aggregateResult(agg);
}

test("consensus: a transient misread (gone in the latest frame) is dropped", () => {
  // Gragas is on the bench throughout; one middle frame misreads it as Garen.
  const frames = [
    {
      bench: [{ m: mk("Gragas", 4, ["Garen"]), verdict: "accept" }],
      picks: picksFilled(5),
    },
    {
      bench: [{ m: mk("Garen", 9, ["Gragas"]), verdict: "maybe" }],
      picks: picksFilled(5),
    },
    {
      bench: [{ m: mk("Gragas", 4), verdict: "accept" }],
      picks: picksFilled(5),
    },
    {
      bench: [{ m: mk("Gragas", 4), verdict: "accept" }],
      picks: picksFilled(5),
    },
  ];
  const r = feed(frames);
  assert.ok(r.ids.includes("Gragas"), "the recurring champion is kept");
  assert.ok(
    !r.ids.includes("Garen"),
    "a one-frame misread now gone is dropped",
  );
  assert.ok(!r.uncertain.has("Gragas"), "a recurring accept is confident");
});

test("consensus: identity voting survives a bench swap (position-independent)", () => {
  // Same two champions, different bench positions each frame (a swap): both are
  // recognized regardless of where they sit.
  const frames = [
    {
      bench: [
        { m: mk("Gragas", 4), verdict: "accept" },
        { m: mk("Elise", 4), verdict: "accept" },
      ],
      picks: picksFilled(5),
    },
    {
      bench: [
        { m: mk("Elise", 4), verdict: "accept" },
        { m: mk("Gragas", 4), verdict: "accept" },
      ],
      picks: picksFilled(5),
    },
  ];
  const r = feed(frames);
  assert.ok(r.ids.includes("Gragas") && r.ids.includes("Elise"));
  assert.ok(!r.uncertain.has("Gragas") && !r.uncertain.has("Elise"));
});

test("consensus: a genuinely flipping read stays maybe and names alternatives", () => {
  const frames = [
    {
      bench: [{ m: mk("Zeri", 6, ["Zyra"]), verdict: "maybe" }],
      picks: picksFilled(5),
    },
    {
      bench: [{ m: mk("Zyra", 6, ["Zeri"]), verdict: "maybe" }],
      picks: picksFilled(5),
    },
    {
      bench: [{ m: mk("Zeri", 6, ["Ziggs"]), verdict: "maybe" }],
      picks: picksFilled(5),
    },
    {
      bench: [{ m: mk("Zyra", 6, ["Zeri"]), verdict: "maybe" }],
      picks: picksFilled(5),
    },
  ];
  const r = feed(frames);
  const winner = r.ids.find((id) => ["Zeri", "Zyra"].includes(id));
  assert.ok(winner, "a champion is still surfaced");
  assert.ok(r.uncertain.has(winner), "a never-accepted read stays uncertain");
  assert.ok(
    (r.alternatives.get(winner) || []).length >= 1,
    "alternatives shown",
  );
});

test("readiness: not stable until all five circles are filled for `confirm` frames", () => {
  // Four circles filled, over several frames — never ready.
  assert.equal(
    feed([{ picks: picksFilled(4) }, { picks: picksFilled(4) }]).stable,
    false,
  );
  // Fifth circle appears: one frame is not enough (a mid-animation flicker).
  const justFilled = feed([
    { picks: picksFilled(4) },
    { picks: picksFilled(5) },
  ]);
  assert.equal(
    justFilled.stable,
    false,
    "one frame at 5 picks is not yet stable",
  );
  assert.equal(justFilled.picksFilled, 5);
  // Held for `confirm` (2) frames → stable.
  assert.equal(
    feed([{ picks: picksFilled(5) }, { picks: picksFilled(5) }]).stable,
    true,
  );
});

// ---- video chain: a synthetic "video" of champ select filling in over time ----
// The bench is present from the moment champ select opens; the five TEAM PICKS
// lock in one at a time. Simulate that by starting from the real fixture and
// BLACKING OUT the pick circles, then revealing them one per frame (a couple of
// steady frames after). This is the augmentation the live loop must survive: it
// must NOT finalize early, then finalize promptly (`confirm` frames) once the
// fifth pick is in, with the right roster — position-independent, cheap per frame.
function blackRegion(out, w, h, cx, cy, size) {
  const half = Math.round((size * 1.4) / 2); // cover the matcher's local search
  for (let y = cy - half; y <= cy + half; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || x >= w) continue;
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = 0; // an unlocked (blacked-out) pick slot
      out[i + 3] = 255;
    }
  }
}
// Frames 0..circles.length reveal one more circle each; then +2 steady frames.
function videoChain(src, w, h, circles) {
  const frames = [];
  for (let k = 0; k <= circles.length + 2; k++) {
    const revealed = Math.min(circles.length, k);
    const o = Buffer.from(src);
    for (let i = revealed; i < circles.length; i++)
      blackRegion(o, w, h, circles[i].cx, circles[i].cy, circles[i].size);
    frames.push(o);
  }
  return frames;
}

test(
  "video chain: reads once all five circles fill, at the right moment",
  SLOW,
  () => {
    // Exact circle + bench geometry from the clean fixture (the cached live layout).
    const layoutCircles = core.detectTeamCircles(buf, W, H, iconHashById);
    const frames = videoChain(buf, W, H, layoutCircles);
    const agg = core.createScanAggregator();
    let stableAt = -1;
    const readAt = []; // ids known at each frame, for the running-prediction check
    frames.forEach((fb, k) => {
      const benchPos = bench.slots.map((s) => {
        const m = core.matchSlot(fb, W, H, s, iconHashById, { tight: true });
        return { m, verdict: core.classifyMatch(m) };
      });
      const circPos = layoutCircles.map((c) => {
        const m = core.matchCircle(fb, W, H, c, iconHashById, { tight: true });
        return { m, verdict: core.classifyCircleMatch(m) };
      });
      core.aggregateFrame(agg, benchPos, circPos);
      const r = core.aggregateResult(agg);
      readAt.push(r);
      if (r.stable && stableAt < 0) stableAt = k;
    });

    // The fifth circle is revealed at frame index 5; with confirm=2 it must not be
    // stable before then, and must go stable exactly one frame later (5 held twice).
    assert.equal(readAt[4].stable, false, "4 circles filled → never stable");
    assert.equal(
      readAt[5].stable,
      false,
      "just-filled (1 frame) → not yet stable",
    );
    assert.equal(
      stableAt,
      6,
      "stable exactly when 5 picks have held for `confirm`",
    );

    // The finalized roster is the full board, and the bench was already being read
    // (running predictions) well before finalize — the picks just gated the finish.
    const finalIds = readAt[stableAt].ids;
    for (const id of EXPECTED)
      assert.ok(finalIds.includes(id), `bench should include ${id}`);
    for (const id of EXPECTED_CIRCLES)
      assert.ok(finalIds.includes(id), `picks should include ${id}`);
    assert.ok(
      readAt[0].ids.length >= EXPECTED.length,
      "the bench is predicted live from the very first frame, before picks lock",
    );
  },
);

// ---- augmentation robustness: each fixture through realistic variations ----
// The fit (locate + bench) must survive rescaling, resampling softness, mild
// noise, translation, and JPEG-style recompression — the things a real pasted
// screenshot has been through. Bench is asserted exactly; circles (the borderline
// dark portraits) must keep at least 4 of 5.
test("fixture 1 detection is robust to realistic augmentations", SLOW, () => {
  assertRobust("fixture1", buf, W, H, EXPECTED, EXPECTED_CIRCLES);
});

test("fixture 2 detection is robust to realistic augmentations", SLOW, () => {
  assertRobust(
    "fixture2",
    png2.data,
    png2.width,
    png2.height,
    EXPECTED_2,
    EXPECTED_2_CIRCLES,
  );
});
