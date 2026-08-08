// ARAM: Mayhem — the HARDCODED champion-select layout.
//
// This is the default reader. The premise is simple: 99% of scans are ARAM
// Mayhem champion select, and that screen's geometry is FIXED. Every bench
// square and every team portrait sits at a known fraction of the champ-select
// client rectangle, so there is nothing to "detect" — once you know where the
// client is, you know where all 15 icons are, exactly.
//
// That leaves ONE unknown instead of a whole detection problem:
//
//     client rectangle  =  (x, y, scale)
//
// and three ways to pin it down, cheapest first:
//
//   1. The caller already knows it — a window/tab share IS the client, and a
//      live loop caches the rect it read last frame.  (zero pixels touched)
//   2. The client is a distinct 16:9 window inside a bigger frame (a desktop
//      screenshot, a monitor share): findClientWindows locates that rectangle
//      from its four straight borders — no champion art involved.
//   3. Whatever seed we have is a few pixels off: refineAramClient nudges
//      (dx, dy, scale) to maximise how well the KNOWN bench comb lines up with
//      the frame's edges — again with no champion art involved.
//
// Only after the rectangle is settled does champion matching run, on 15 exact
// positions. Contrast with the adaptive pipeline in scan-core.js (mode
// "aram-adaptive"), which searches for the bench BY CHAMPION CONTENT at every
// scale and phase: strictly more powerful, much slower, and much easier to
// fool. That one is still available as a manual fallback in the UI.

// Dual-use: under Node the core primitives come from require(); in the browser
// and in the Web Worker scan-core.js has already declared them as globals.
const ARAM_CORE =
  typeof module !== "undefined" && module.exports
    ? require("./scan-core.js")
    : globalThis;

// ---------------------------------------------------------------------------
// The template. Every number is a fraction of the champ-select client rect,
// measured off real 1280x720 captures (test_data/image-0.png, image-1.png and
// the committed fixtures) with scripts/measure-layout.js, which brute-forces
// the true pixel position of champions whose identity is already known.
//
// Pixel values at the 1280x720 reference, for reading the fractions below:
//   bench      slot 0 centre x=377, pitch 58.6, centre y=35, cell 48x48
//   allies     centre x=84.5, first centre y=135.3, pitch 79.75, circle d=49
// ---------------------------------------------------------------------------
const ARAM_TEMPLATE = {
  reference: { w: 1280, h: 720 },
  aspect: 1280 / 720,
  bench: {
    count: 10,
    slot0Cx: 377 / 1280,
    pitch: 58.6 / 1280,
    cy: 35 / 720,
    cell: 48 / 1280, // the drawn cell; also the crop we hand the matcher
  },
  allies: {
    count: 5,
    cx: 84.5 / 1280,
    cy0: 135.3 / 720,
    pitch: 79.75 / 720,
    size: 49 / 1280,
  },
};
// Below this alignment score the rectangle is not an ARAM bench at all, and the
// finder says so instead of handing back a confident-looking wrong answer.
// Correctly-placed fixtures score 77-130; the same frames misaligned score <55.
// The score is in luminance units, so a very washed-out capture could in
// principle fall short of a correct fit — that shows up as "couldn't find
// champion select", which the UI answers by offering the adaptive reader.
const ARAM_MIN_TEMPLATE_SCORE = 60;

/**
 * Every icon position for a champ-select client rect — pure arithmetic, no
 * pixels read. 10 bench squares (left to right) then 5 ally portraits (top to
 * bottom), in the Spot shape the scan-core matcher consumes.
 * @param {{x:number,y:number,w:number,h:number}} c client rectangle
 * @returns {Array<{kind:string,index:number,cx:number,cy:number,size:number}>}
 */
function aramTemplateSpots(c) {
  const T = ARAM_TEMPLATE;
  const spots = [];
  const benchSize = Math.max(8, Math.round(T.bench.cell * c.w));
  const benchCy = c.y + T.bench.cy * c.h;
  for (let i = 0; i < T.bench.count; i++)
    spots.push({
      kind: "bench",
      index: i,
      cx: c.x + (T.bench.slot0Cx + i * T.bench.pitch) * c.w,
      cy: benchCy,
      size: benchSize,
    });
  const allySize = Math.max(8, Math.round(T.allies.size * c.w));
  const allyCx = c.x + T.allies.cx * c.w;
  for (let i = 0; i < T.allies.count; i++)
    spots.push({
      kind: "circle",
      index: i,
      cx: allyCx,
      cy: c.y + (T.allies.cy0 + i * T.allies.pitch) * c.h,
      size: allySize,
    });
  return spots;
}

/** SlotProvider for the modular pipeline. @see aramTemplateSpots */
function aramFixedSlots(frame, client) {
  return aramTemplateSpots(client);
}

// ---------------------------------------------------------------------------
// Identity-free alignment score
// ---------------------------------------------------------------------------
// How well does the template's BENCH COMB line up with this frame's edges?
//
// The bench is ten 48px cells separated by 10.6px gaps. Two things follow, and
// together they are what make the score sharp rather than merely periodic:
//
//   • the 20 cell borders are crisp vertical lines — high |dL/dx|;
//   • the 9 GAPS between cells are quiet — they are flat background, and on a
//     correctly-placed template they measure almost exactly zero.
//
// Scoring borders MINUS gap energy is the whole trick. Raw border energy alone
// slides happily onto the "AVAILABLE CHAMPIONS" caption or onto champion art,
// both of which are full of strong edges; neither has ten evenly-spaced quiet
// 10px lanes. The two long horizontal cell borders, sampled across the whole
// bench span, then pin the vertical placement, which the columns cannot see.
//
// This is a LOCAL objective, deliberately. It is sharp (a 5px slip costs most
// of the score) but it is not globally unique — small misplaced rectangles can
// score well — so it is only ever used to polish a seed that already came from
// somewhere trustworthy, never to hunt across a whole frame.

// Mean |dL/dx| down a column segment, sampled every `stepY` rows.
function colEdgeAt(buf, W, H, x, yt, yb, stepY) {
  const xi = Math.round(x);
  if (xi < 1 || xi >= W) return 0;
  const y0 = Math.max(1, Math.round(yt)),
    y1 = Math.min(H - 1, Math.round(yb));
  let s = 0,
    n = 0;
  for (let y = y0; y <= y1; y += stepY) {
    s += Math.abs(
      ARAM_CORE.pxLum(buf, W, xi, y) - ARAM_CORE.pxLum(buf, W, xi - 1, y),
    );
    n++;
  }
  return n ? s / n : 0;
}
// Mean |dL/dy| along a row segment, sampled every `stepX` columns.
function rowEdgeAt(buf, W, H, y, xa, xb, stepX) {
  const yi = Math.round(y);
  if (yi < 1 || yi >= H) return 0;
  const x0 = Math.max(1, Math.round(xa)),
    x1 = Math.min(W - 1, Math.round(xb));
  let s = 0,
    n = 0;
  for (let x = x0; x <= x1; x += stepX) {
    s += Math.abs(
      ARAM_CORE.pxLum(buf, W, x, yi) - ARAM_CORE.pxLum(buf, W, x, yi - 1),
    );
    n++;
  }
  return n ? s / n : 0;
}
// Best of three adjacent offsets — absorbs the ±1px rounding of a fractional
// template position without widening the comb's real tolerance.
function bestOf3(f, at) {
  return Math.max(f(at - 1), f(at), f(at + 1));
}

/**
 * Identity-free goodness-of-fit for a candidate client rect. Higher is better:
 * a correctly-placed ARAM client scores ~75-130 on the fixtures, and the same
 * frame misaligned by as little as 5px drops to ~25-55.
 * @param {{buf:Uint8ClampedArray,W:number,H:number}} frame
 * @param {{x:number,y:number,w:number,h:number}} c
 * @returns {number}
 */
function aramTemplateScore(frame, c) {
  const { buf, W, H } = frame;
  const T = ARAM_TEMPLATE;
  const pitch = T.bench.pitch * c.w;
  const cell = T.bench.cell * c.w;
  if (!(pitch >= 10) || !(cell >= 8)) return -Infinity;
  const gap = pitch - cell;
  const cy = c.y + T.bench.cy * c.h;
  const yt = cy - cell / 2,
    yb = cy + cell / 2;
  // Sample sparsely down each border — they are long lines, we only need to
  // know they are there, and this keeps hundreds of candidates affordable.
  const stepY = Math.max(1, Math.round(cell / 16));
  const stepX = Math.max(1, Math.round(pitch / 8));
  const cx0 = c.x + T.bench.slot0Cx * c.w; // centre of bench cell 0
  // Columns are read over the cell's INTERIOR rows, so a vertically misplaced
  // template reads background instead of borders and scores badly.
  const col = (x) => colEdgeAt(buf, W, H, x, yt + 2, yb - 2, stepY);

  let border = 0,
    nBorder = 0,
    gapE = 0,
    nGap = 0;
  for (let k = 0; k < T.bench.count; k++) {
    const centre = cx0 + k * pitch;
    const left = centre - cell / 2,
      right = centre + cell / 2;
    border += bestOf3(col, left) + bestOf3(col, right);
    nBorder += 2;
    if (k === T.bench.count - 1) continue;
    // Gap interior, skipping the 2px either side that the borders bleed into.
    for (let x = Math.round(right + 2); x <= Math.round(right + gap - 2); x++) {
      gapE += col(x);
      nGap++;
    }
  }
  border /= nBorder || 1;
  gapE = nGap ? gapE / nGap : 0;

  // The two long horizontal cell borders, across the whole bench span, versus
  // the rows just outside them and the row through the middle of the cells.
  const spanA = cx0 - cell / 2,
    spanB = cx0 + (T.bench.count - 1) * pitch + cell / 2;
  const row = (y) => rowEdgeAt(buf, W, H, y, spanA, spanB, stepX);
  const rows = (bestOf3(row, yt) + bestOf3(row, yb)) / 2;
  const rowsOff =
    (bestOf3(row, yt - gap / 2 - 1) +
      bestOf3(row, yb + gap / 2 + 1) +
      bestOf3(row, cy)) /
    3;

  return border - 2 * gapE + 1.5 * (rows - rowsOff);
}

// Coarse-to-fine passes for refineAramClient: how far to look (px) and how much
// scale latitude to allow. Each pass is dense at 1px in x and y, because the
// score's peak is only a few pixels wide — a coarse grid would step over it.
const ARAM_REFINE_PASSES = [
  { reach: 18, scaleSteps: 4, scaleStep: 0.01 },
  { reach: 6, scaleSteps: 4, scaleStep: 0.003 },
  { reach: 3, scaleSteps: 4, scaleStep: 0.001 },
];

/**
 * Nudge a seed client rect onto the frame: coordinate descent over (scale, x)
 * jointly — they interact, a 1% scale error walks the far end of the bench by
 * ~6px — then over y, repeated at shrinking reach. Bounded and deterministic:
 * ~1100 score evaluations (~25ms on a 1080p frame), never a global hunt.
 * @param {{buf:Uint8ClampedArray,W:number,H:number}} frame
 * @param {{x:number,y:number,w:number,h:number}} seed
 * @param {{passes?:Array}} [opts]
 * @returns {{client:{x:number,y:number,w:number,h:number}, score:number}}
 */
function refineAramClient(frame, seed, opts) {
  const passes = (opts && opts.passes) || ARAM_REFINE_PASSES;
  let best = { x: seed.x, y: seed.y, w: seed.w, h: seed.h };
  let bestScore = aramTemplateScore(frame, best);
  for (const pass of passes) {
    let pick = best;
    for (let sk = -pass.scaleSteps; sk <= pass.scaleSteps; sk++) {
      const w = best.w * (1 + sk * pass.scaleStep);
      const h = w / ARAM_TEMPLATE.aspect;
      for (let dx = -pass.reach; dx <= pass.reach; dx++) {
        const cand = { x: best.x + dx, y: best.y, w, h };
        const s = aramTemplateScore(frame, cand);
        if (s > bestScore) {
          bestScore = s;
          pick = cand;
        }
      }
    }
    best = pick;
    pick = best;
    for (let dy = -pass.reach; dy <= pass.reach; dy++) {
      const cand = { x: best.x, y: best.y + dy, w: best.w, h: best.h };
      const s = aramTemplateScore(frame, cand);
      if (s > bestScore) {
        bestScore = s;
        pick = cand;
      }
    }
    best = pick;
  }
  return { client: best, score: bestScore };
}

// ---------------------------------------------------------------------------
// Finding the client WINDOW in a larger frame (desktop screenshot / monitor
// share). Identity-free: the League client is a 16:9 rectangle with four
// straight borders, so take the strongest vertical and horizontal lines in the
// frame, pair them into 16:9 rectangles, and verify each rectangle's four sides.
// ---------------------------------------------------------------------------
const WINDOW_EDGE_STEP = 22; // luminance jump that counts as an edge pixel
const WINDOW_MIN_WIDTH_FRAC = 0.25; // a client smaller than this is unreadable anyway
const WINDOW_MIN_SIDE_SCORE = 2.2; // of 4.0 — how much of the border must be real
const WINDOW_ASPECT_TOL = 0.03; // how far the height may stray from 16:9

// The strongest `count` indices of `scores`, no two closer than `minSep`.
function pickPeaks(scores, count, minSep) {
  const order = [];
  for (let i = 0; i < scores.length; i++) order.push(i);
  order.sort((a, b) => scores[b] - scores[a]);
  const out = [];
  for (const i of order) {
    if (out.length >= count) break;
    if (scores[i] <= 0) break;
    if (out.every((j) => Math.abs(i - j) >= minSep)) out.push(i);
  }
  return out;
}

/**
 * Candidate champ-select window rectangles inside a frame, strongest first.
 * Empty when the frame has no such rectangle — which is the normal, correct
 * answer for a window share (the client fills the frame, so it has no borders
 * inside it).
 * @param {{buf:Uint8ClampedArray,W:number,H:number}} frame
 * @param {{minWidthFrac?:number, limit?:number}} [opts]
 * @returns {Array<{x:number,y:number,w:number,h:number,score:number}>}
 */
function findClientWindows(frame, opts) {
  const { buf, W, H } = frame;
  const o = opts || {};
  const V = new Float64Array(W); // per column: how much of it is a vertical line
  const R = new Float64Array(H); // per row: how much of it is a horizontal line
  for (let y = 1; y < H; y++)
    for (let x = 1; x < W; x++) {
      if (
        Math.abs(
          ARAM_CORE.pxLum(buf, W, x, y) - ARAM_CORE.pxLum(buf, W, x - 1, y),
        ) > WINDOW_EDGE_STEP
      )
        V[x]++;
      if (
        Math.abs(
          ARAM_CORE.pxLum(buf, W, x, y) - ARAM_CORE.pxLum(buf, W, x, y - 1),
        ) > WINDOW_EDGE_STEP
      )
        R[y]++;
    }
  const cols = pickPeaks(V, 14, 8);
  const rows = pickPeaks(R, 14, 8);
  const vFrac = (x, t, b) => {
    if (x < 1 || x >= W) return 0;
    let n = 0,
      c = 0;
    for (let y = Math.max(1, t); y <= Math.min(H - 1, b); y += 2) {
      n++;
      if (
        Math.abs(
          ARAM_CORE.pxLum(buf, W, x, y) - ARAM_CORE.pxLum(buf, W, x - 1, y),
        ) > WINDOW_EDGE_STEP
      )
        c++;
    }
    return n ? c / n : 0;
  };
  const hFrac = (y, l, r) => {
    if (y < 1 || y >= H) return 0;
    let n = 0,
      c = 0;
    for (let x = Math.max(1, l); x <= Math.min(W - 1, r); x += 2) {
      n++;
      if (
        Math.abs(
          ARAM_CORE.pxLum(buf, W, x, y) - ARAM_CORE.pxLum(buf, W, x, y - 1),
        ) > WINDOW_EDGE_STEP
      )
        c++;
    }
    return n ? c / n : 0;
  };

  const minW = Math.max(200, W * (o.minWidthFrac ?? WINDOW_MIN_WIDTH_FRAC));
  const found = [];
  for (const l of cols)
    for (const r of cols) {
      const w = r - l;
      if (w < minW) continue;
      const hExp = w / ARAM_TEMPLATE.aspect;
      for (const t of rows) {
        // The bottom border has to be one of the detected lines too, at the
        // distance 16:9 demands — that single constraint throws out almost
        // every accidental pairing.
        let b = null,
          bd = Infinity;
        for (const cand of rows) {
          const d = Math.abs(cand - (t + hExp));
          if (d < bd) {
            bd = d;
            b = cand;
          }
        }
        if (b == null || bd > Math.max(6, hExp * WINDOW_ASPECT_TOL)) continue;
        const score =
          vFrac(l, t, b) + vFrac(r, t, b) + hFrac(t, l, r) + hFrac(b, l, r);
        if (score < WINDOW_MIN_SIDE_SCORE) continue;
        found.push({ x: l, y: t, w, h: b - t, score });
      }
    }
  found.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of found) {
    if (
      keep.some(
        (k) =>
          Math.abs(k.x - c.x) < 12 &&
          Math.abs(k.y - c.y) < 12 &&
          Math.abs(k.w - c.w) < 24,
      )
    )
      continue;
    keep.push(c);
    if (keep.length >= (o.limit || 4)) break;
  }
  return keep;
}

// ---------------------------------------------------------------------------
// The ClientFinder
// ---------------------------------------------------------------------------
/**
 * Locate the champ-select client for the fixed ARAM template, and say how well
 * it fits. Returns null when nothing in the frame looks like an ARAM bench —
 * better than a confident-looking wrong rectangle, and the signal the UI uses
 * to offer the adaptive pipeline instead.
 *
 * ctx.frameIsClient  the captured surface IS the client (a window or tab
 *                    share, or a screenshot of just the client): skip the
 *                    window hunt and refine the frame itself.
 * ctx.iconHashById   when present, a close shortlist is settled by a cheap
 *                    champion check rather than by edge score alone.
 * ctx.minTemplateScore  override the confidence floor.
 *
 * @returns {{x:number,y:number,w:number,h:number,score:number}|null}
 */
function locateAramClient(frame, ctx) {
  const c = ctx || {};
  // Seeds, best guess first. A window share is exactly the client. Anything
  // else may still be a maximised or fullscreen client, so the whole frame
  // stays on the list as a last resort either way.
  const seeds = [];
  if (!c.frameIsClient)
    for (const win of findClientWindows(frame, { limit: 3 }))
      seeds.push({ x: win.x, y: win.y, w: win.w, h: win.h });
  seeds.push({ x: 0, y: 0, w: frame.W, h: frame.H });

  const refined = seeds
    .map((seed) => refineAramClient(frame, seed))
    .sort((a, b) => b.score - a.score);
  const floor = c.minTemplateScore ?? ARAM_MIN_TEMPLATE_SCORE;
  const viable = refined.filter((r) => r.score >= floor);
  if (!viable.length) return null;

  let best = viable[0];
  // Several plausible rectangles: let the champions break the tie. Only the
  // first few bench cells are probed — the bench fills left to right, so those
  // are the likeliest to hold one — and only with the tight per-slot search,
  // because the position is supposed to be exact already.
  if (viable.length > 1 && c.iconHashById) {
    let bestHits = -1;
    for (const r of viable.slice(0, 3)) {
      const hits = aramBenchHits(frame, r.client, c.iconHashById, 4);
      if (hits > bestHits) {
        bestHits = hits;
        best = r;
      }
      if (hits === 4) break; // cannot do better; stop paying for matches
    }
  }
  return { ...best.client, score: best.score };
}

/** ClientFinder wrapper for the modular pipeline. @see locateAramClient */
function aramFixedClient(frame, ctx) {
  return locateAramClient(frame, ctx);
}

/**
 * How many of the first `n` bench cells hold a recognised champion at this
 * client rect. A confidence probe, not a read — the pipeline does the real one.
 * @returns {number} 0..n
 */
function aramBenchHits(frame, client, iconHashById, n) {
  const spots = aramTemplateSpots(client).filter((s) => s.kind === "bench");
  let hits = 0;
  for (const spot of spots.slice(0, n)) {
    const m = ARAM_CORE.matchSlot(
      frame.buf,
      frame.W,
      frame.H,
      spot,
      iconHashById,
      { tight: true },
    );
    if (m && ARAM_CORE.classifyMatch(m) === "accept") hits++;
  }
  return hits;
}

/**
 * IconMatcher for the fixed mode: the same perceptual matcher, but with the
 * TIGHT per-slot search on by default. The template already puts each crop
 * within a pixel or two of the icon, so the wide search the adaptive pipeline
 * needs is 3x the work for identical answers on every fixture. Pass
 * ctx.wideSearch to opt back in (the pipeline debugger does).
 * @type {(frame:object, spots:Array, ctx:object) => Array}
 */
function aramFixedMatcher(frame, spots, ctx) {
  const c = ctx || {};
  return ARAM_CORE.perceptualMatcher(frame, spots, {
    ...c,
    tight: !c.wideSearch,
  });
}

// The fixed ARAM mode, registered as the pipeline default. The searching
// pipeline stays available under "aram-adaptive" (see scan-core.js) and the UI
// offers it as a manual fallback.
const ARAM_FIXED_MODE = {
  findClient: aramFixedClient,
  provideSlots: aramFixedSlots,
  matchIcons: aramFixedMatcher,
};
ARAM_CORE.registerScanMode("aram", ARAM_FIXED_MODE);

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ARAM_TEMPLATE,
    ARAM_MIN_TEMPLATE_SCORE,
    ARAM_FIXED_MODE,
    aramTemplateSpots,
    aramFixedSlots,
    aramFixedMatcher,
    aramTemplateScore,
    refineAramClient,
    findClientWindows,
    locateAramClient,
    aramFixedClient,
    aramBenchHits,
  };
}
