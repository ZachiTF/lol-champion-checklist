// Scratch calibration tool (dev only): brute-force the exact pixel position of a
// KNOWN champion's portrait in a screenshot, so the hardcoded ARAM layout
// fractions can be measured from ground truth instead of guessed.
//
//   node scripts/measure-layout.js
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");
const core = require("../src/scan-core.js");

const fx = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../test/fixtures/icon-hashes.json")),
);
const map = new Map(
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

function load(file) {
  const p = PNG.sync.read(fs.readFileSync(path.join(__dirname, "..", file)));
  return { buf: p.data, W: p.width, H: p.height };
}

// Best (cx, cy, size) for one champion in a search box, matched as a CIRCLE
// (center-crop hashes) or a SQUARE (full-icon hashes).
function locate(f, id, box, sizes, kind) {
  const t = map.get(id);
  if (!t) return null;
  const { buf, W, H } = f;
  const [hRef, sRef] = kind === "circle" ? [t.hC, t.sigC] : [t.h, t.sig];
  let bs = Infinity,
    bp = null;
  for (let size = sizes[0]; size <= sizes[1]; size++) {
    for (let cx = box.x0; cx <= box.x1; cx++) {
      for (let cy = box.y0; cy <= box.y1; cy++) {
        const x0 = Math.round(cx - size / 2),
          y0 = Math.round(cy - size / 2);
        const h = core.dHashRegion(buf, W, H, x0, y0, size, size);
        const ham = core.hamming64(h, hRef);
        if (ham > 28) continue;
        const inset = kind === "circle" ? 0 : Math.round(size * 0.04);
        const sig = core.colorSigRegion(
          buf,
          W,
          H,
          x0 + inset,
          y0 + inset,
          size - 2 * inset,
          size - 2 * inset,
        );
        const c = core.colorDist(sig, sRef);
        const s = ham + 0.35 * c;
        if (s < bs) {
          bs = s;
          bp = {
            cx,
            cy,
            size,
            ham,
            color: +c.toFixed(1),
            score: +s.toFixed(1),
          };
        }
      }
    }
  }
  return bp;
}

// --- known ground truth per screenshot -------------------------------------
const CASES = [
  {
    file: "test_data/image-0.png",
    client: { x: 318, y: 156, w: 1280, h: 720 },
    circles: [
      ["Nidalee", 270, 320],
      ["Tristana", 350, 400],
      ["Pantheon", 430, 480],
      ["MissFortune", 510, 560],
      ["Ashe", 590, 640],
    ],
    circleX: [390, 420],
    bench: [
      ["Graves", 660, 730],
      ["Elise", 1080, 1140],
    ],
    benchY: [175, 205],
  },
  {
    file: "test_data/image-1.png",
    client: { x: 320, y: 156, w: 1280, h: 720 },
    circles: [
      ["Nautilus", 265, 320],
      ["Sion", 345, 400],
      ["Thresh", 425, 480],
      ["Varus", 505, 560],
      ["Seraphine", 585, 640],
    ],
    circleX: [390, 420],
    bench: [
      ["Zeri", 660, 730],
      ["JarvanIV", 1130, 1190],
    ],
    benchY: [170, 200],
  },
];

// Window-share style captures where the frame IS the client (or nearly so): the
// circle/bench champions are known from the test expectations, so the same
// brute-force gives fractions to cross-check the 1920x1080 desktop measurements.
CASES.push(
  {
    file: "test/fixtures/aram-bench.png",
    client: { x: 0, y: 0, w: 1274, h: 706 },
    circles: [
      ["Velkoz", 100, 170],
      ["Malphite", 180, 250],
      ["Vex", 260, 330],
      ["Xerath", 340, 410],
      ["Aphelios", 420, 490],
    ],
    circleX: [70, 100],
    bench: [
      ["Gragas", 355, 400],
      ["Lissandra", 700, 745],
    ],
    benchY: [15, 50],
  },
  {
    file: "test/fixtures/aram-bench-2.png",
    client: { x: 0, y: 0, w: 1063, h: 696 },
    circles: [
      ["Malzahar", 100, 180],
      ["AurelionSol", 180, 260],
      ["Fiddlesticks", 260, 340],
      ["MissFortune", 340, 420],
      ["Mel", 420, 500],
    ],
    circleX: [55, 90],
    bench: [
      ["RekSai", 290, 340],
      ["Renata", 520, 570],
    ],
    benchY: [15, 50],
  },
);

for (const cse of CASES) {
  const f = load(cse.file);
  const c = cse.client;
  console.log(`\n=== ${cse.file}  client ${JSON.stringify(c)}`);
  const rows = [];
  for (const [id, y0, y1] of cse.circles) {
    const r = locate(
      f,
      id,
      { x0: cse.circleX[0], x1: cse.circleX[1], y0, y1 },
      [36, 56],
      "circle",
    );
    rows.push(r);
    console.log(
      `  circle ${id.padEnd(12)} ${JSON.stringify(r)}` +
        (r
          ? `  fx=${((r.cx - c.x) / c.w).toFixed(5)} fy=${(
              (r.cy - c.y) /
              c.h
            ).toFixed(5)} fsize=${(r.size / c.w).toFixed(5)}`
          : ""),
    );
  }
  const ys = rows.filter(Boolean).map((r) => r.cy);
  if (ys.length > 1) {
    const pitch = (ys[ys.length - 1] - ys[0]) / (ys.length - 1);
    console.log(
      `  circle pitch ${pitch.toFixed(2)}px  fpitch=${(pitch / c.h).toFixed(
        5,
      )}`,
    );
  }
  for (const [id, x0, x1] of cse.bench) {
    const r = locate(
      f,
      id,
      { x0, x1, y0: cse.benchY[0], y1: cse.benchY[1] },
      [40, 56],
      "square",
    );
    console.log(
      `  bench  ${id.padEnd(12)} ${JSON.stringify(r)}` +
        (r
          ? `  fx=${((r.cx - c.x) / c.w).toFixed(5)} fy=${(
              (r.cy - c.y) /
              c.h
            ).toFixed(5)} fsize=${(r.size / c.w).toFixed(5)}`
          : ""),
    );
  }
}
