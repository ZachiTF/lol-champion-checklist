// Scan diagnostic: run every labelled case through the reader and say WHICH
// stage failed, per slot. This is the tool that replaces guessing.
//
//   node scripts/scan-report.js                 # every case, native resolution
//   node scripts/scan-report.js --scale         # + a 0.6x..1.5x resample sweep
//   node scripts/scan-report.js --reader=aram-adaptive
//   node scripts/scan-report.js --case=cooldown # substring filter
//   node scripts/scan-report.js --slots         # per-slot detail, not just totals
//   node scripts/scan-report.js --dir=test_data/recordings   # a recorded dataset
//                                               #   (see scripts/import-recording.js)
//
// The column that matters is RANK: where the CORRECT champion sits in the full
// 173-way ranking, scored at the crop the matcher actually chose.
//
//   rank 1, rejected   -> a THRESHOLD problem: right answer, refused
//   rank 2-5           -> a MARGIN problem, or reference art that isn't on screen
//   rank > 50          -> a GEOMETRY problem: the crop isn't on the icon at all
//
// so a wrong name never has to be diagnosed by staring at a screenshot again.
const path = require("node:path");
const core = require("../src/scan-core.js");
require("../src/scan-aram.js"); // registers mode "aram"
const { listCases, loadIconHashes, geometryError } = require("./case-set.js");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n, d) => {
  const a = argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const READER = opt("reader", "aram");
const FILTER = opt("case", "");
const SHOW_SLOTS = flag("slots");
const DIR = opt("dir", "");
const SCALES = flag("scale")
  ? [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5]
  : [1.0];

const iconHashById = loadIconHashes();

// Box-filtered resample: what a compositor or a DPI-scaled window share does to
// the frame before the pipeline ever sees it. Native captures are the exception
// in real use, not the rule.
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

/**
 * Rank every champion against the crop the matcher actually chose, with the
 * same hashes and the same score the pipeline uses. Returns the full ordering,
 * so the caller can ask where the TRUTH landed rather than only who won.
 */
function rankAt(frame, pos, kind) {
  const { buf, W, H } = frame;
  const circle = kind === "circle";
  const inset = circle ? 0 : Math.round(pos.size * 0.04);
  const h = core.dHashRegion(buf, W, H, pos.x0, pos.y0, pos.size, pos.size);
  const sig = core.colorSigRegion(
    buf,
    W,
    H,
    pos.x0 + inset,
    pos.y0 + inset,
    pos.size - 2 * inset,
    pos.size - 2 * inset,
  );
  const out = [];
  for (const [id, t] of iconHashById) {
    const ham = core.hamming64(h, circle ? t.hC : t.h);
    const color = core.colorDist(sig, circle ? t.sigC : t.sig);
    out.push({ id, ham, color, score: ham + 0.35 * color });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

const pad = (v, n) => String(v).padEnd(n);
const num = (v, n, d = 1) =>
  String(v == null ? "-" : typeof v === "number" ? v.toFixed(d) : v).padStart(
    n,
  );

// Worst box-centre offset (in bench cells) still counted as "on the icon".
const GEOM_TOLERANCE = 0.25;
let totals = {
  slots: 0,
  right: 0,
  wrong: 0,
  missed: 0,
  declines: 0,
  cases: 0,
  geomCases: 0,
  geomBad: 0,
};
const failures = [];

for (const c of DIR ? listCases(path.resolve(DIR)) : listCases()) {
  if (FILTER && !c.name.includes(FILTER)) continue;
  const base = c.frame();
  for (const s of SCALES) {
    const frame = rescale(base, s);
    const tag = `${c.name}${SCALES.length > 1 ? "@" + s.toFixed(2) : ""}`;
    const res = core.runFrameRead(core.pipelineForMode(READER), frame, {
      iconHashById,
      frameIsClient: c.frameIsClient,
    });
    totals.cases++;
    const client = res && res.client;
    if (!client) {
      const ok = c.expect === "decline";
      if (!ok) {
        totals.declines++;
        failures.push(`${tag}: DECLINED (expected a read)`);
      }
      console.log(
        `\n=== ${pad(tag, 28)} ${c.surface.padEnd(8)} DECLINED  ${
          ok ? "(expected)" : "<-- UNEXPECTED"
        }`,
      );
      continue;
    }
    if (c.expect === "decline")
      failures.push(
        `${tag}: read a rect (expected a decline) w=${client.w.toFixed(
          0,
        )} score=${(client.score || 0).toFixed(1)}`,
      );
    console.log(
      `\n=== ${pad(tag, 28)} ${c.surface.padEnd(8)} client ${num(
        client.x,
        6,
      )},${num(client.y, 6)} ${num(client.w, 7)}x${num(
        client.h,
        6,
      )}  score ${num(client.score, 6)}  margin ${num(
        client.margin,
        6,
      )}  verify ${
        res.verify && res.verify.ok
          ? "ok"
          : "FAIL(" + ((res.verify && res.verify.reason) || "?") + ")"
      }${c.expect === "decline" ? "  <-- expected a DECLINE" : ""}`,
    );
    if (c.note && s === SCALES[0]) console.log(`    ${c.note}`);
    // Geometry before names: a misplaced box makes every name below noise.
    if (c.boxes || c.client) {
      const truth = c.boxes
        ? c.boxes.map((b) => ({
            ...b,
            cx: b.cx * s,
            cy: b.cy * s,
            size: b.size * s,
          }))
        : {
            x: c.client.x * s,
            y: c.client.y * s,
            w: c.client.w * s,
            h: c.client.h * s,
          };
      const err = geometryError(truth, client);
      totals.geomCases++;
      if (err > GEOM_TOLERANCE) {
        totals.geomBad++;
        failures.push(`${tag}: BOXES OFF by ${err.toFixed(2)} cells`);
      }
      console.log(
        `    boxes vs labelled: off by ${err.toFixed(2)} cells${
          err > GEOM_TOLERANCE ? "  <-- WRONG PLACE" : ""
        }`,
      );
    }

    const expected = [...c.bench, ...c.allies];
    // runFrameRead splits the 15 results; put them back in template order.
    const positions = [...res.benchSlots, ...res.pickCircles];
    const rows = [];
    let right = 0,
      wrong = 0,
      missed = 0;
    positions.forEach((p, i) => {
      const want = expected[i];
      if (want === undefined) return;
      const kind = p.spot.kind;
      const label = (kind === "bench" ? "b" : "a") + p.spot.index;
      const got = p.verdict === "reject" || !p.m ? null : p.m.id;
      const m = p.m;
      let rank = null,
        margin = null;
      if (m && m.pos) {
        const r = rankAt(frame, m.pos, kind);
        margin = r[1].score - r[0].score;
        if (want && want !== "?")
          rank = r.findIndex((x) => x.id === want) + 1 || null;
      }
      let status;
      if (want === null) status = got === null ? "ok" : "PHANTOM";
      else if (want === "?") status = got === null ? "MISSED" : "ok";
      else if (got === want) status = "ok";
      else if (got === null) status = "MISSED";
      else status = "WRONG";
      if (status === "ok") right++;
      else if (status === "WRONG" || status === "PHANTOM") wrong++;
      else missed++;
      rows.push({ label, want, got, status, p, m, rank, margin });
    });
    totals.slots += rows.length;
    totals.right += right;
    totals.wrong += wrong;
    totals.missed += missed;

    const bad = rows.filter((r) => r.status !== "ok");
    for (const r of bad)
      failures.push(
        `${tag} ${r.label}: ${r.status} expected ${r.want} got ${r.got} (rank ${
          r.rank ?? "-"
        }, margin ${r.margin == null ? "-" : r.margin.toFixed(1)})`,
      );

    const show = SHOW_SLOTS ? rows : bad;
    if (show.length) {
      console.log(
        `    slot  ${pad("expected", 14)}${pad("got", 14)}${pad(
          "verdict",
          9,
        )}${num("ham", 5)}${num("color", 7)}${num("score", 7)}${num(
          "rank",
          6,
        )}${num("margin", 8)}  status`,
      );
      for (const r of show)
        console.log(
          `    ${pad(r.label, 6)}${pad(
            r.want === null ? "(empty)" : r.want,
            14,
          )}${pad(r.got ?? "-", 14)}${pad(r.p.verdict, 9)}${num(
            r.m && r.m.ham,
            5,
            0,
          )}${num(r.m && r.m.color, 7)}${num(r.m && r.m.score, 7)}${num(
            r.rank,
            6,
            0,
          )}${num(r.margin, 8)}  ${r.status}`,
        );
    }
    console.log(
      `    SUMMARY  ${right}/${rows.length} correct   ${wrong} wrong   ${missed} missed`,
    );
  }
}

console.log(
  `\n${"=".repeat(72)}\nTOTAL  ${totals.right}/${
    totals.slots
  } slots correct   ${totals.wrong} wrong   ${totals.missed} missed   ${
    totals.declines
  } unexpected declines   (reader: ${READER})` +
    (totals.geomCases
      ? `\nBOXES  ${totals.geomCases - totals.geomBad}/${
          totals.geomCases
        } frames with the boxes on the icons (labelled geometry, tolerance ${GEOM_TOLERANCE} cells)`
      : ""),
);
if (failures.length) {
  console.log(`\n${failures.length} failing slot(s)/case(s):`);
  for (const f of failures) console.log("  " + f);
}
process.exitCode = failures.length ? 1 : 0;
