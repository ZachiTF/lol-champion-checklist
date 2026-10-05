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

// Dual-use: under Node the core comes from require(); in the browser and in the
// Web Worker scan-core.js has already declared SCAN_CORE (the same object). Not
// globalThis — see the note on SCAN_CORE for why that silently breaks constants.
const ARAM_CORE =
  typeof module !== "undefined" && module.exports
    ? require("./scan-core.js")
    : SCAN_CORE;

// ---------------------------------------------------------------------------
// The template. Every number is a fraction of the champ-select client rect,
// measured off real 1280x720 captures (test_data/image-0.png, image-1.png and
// the committed fixtures) with scripts/measure-layout.js, which brute-forces
// the true pixel position of champions whose identity is already known.
//
// Pixel values at the 1280x720 reference, for reading the fractions below:
//   bench      slot 0 centre x=377, pitch 58.6, centre y=35, cell 48x48
//   allies     centre x=85.5, first centre y=134.3, pitch 80.0, circle d=49 (ring r=29)
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
    // Re-fit 2026-10-04 to the gold portrait ring (scan-aram ringFit) on a
    // native 1280x720 recording: the first measurement sat ~1px left and low.
    cx: 85.5 / 1280,
    cy0: 134.3 / 720,
    pitch: 80.0 / 720,
    size: 49 / 1280, // the matcher's crop (inside the ring, on the art)
    ring: 29 / 1280, // radius of the gold ring around the portrait
  },
};
// The edge score is a LOCAL objective. It polishes a rect beautifully and it is
// sharp against small slips, but it is NOT comparable across candidates that sit
// at different scales, and it is not an acceptance test. Measured on the cases in
// test/cases: a correct rect scores 50-130, while a wrong rect on a cropped
// capture scores 129.5 — higher than any true positive. So the score is used for
// what it is good at (ranking nearby candidates, coordinate descent) and never
// as the thing that decides "is this really champion select?".
//
// This floor is only a cheap PRE-FILTER: below it a rect is not worth paying for
// champion matching. Acceptance is ARAM_MIN_BENCH_MARGIN below.
const ARAM_MIN_TEMPLATE_SCORE = 20;

// What actually decides acceptance: how far each bench cell's best champion beats
// its runner-up, median over the cells that hold something. This separates a
// correctly aligned rect from a misaligned one cleanly, because an aligned crop
// sits on ONE champion's art (one candidate pulls away) while a misaligned crop
// straddles two icons (everything scores alike). Measured over test/cases across
// a 0.6x-1.5x resample sweep:
//
//     correctly aligned rect     median margin  7.2 - 21.1
//     misaligned by half a cell  median margin  0.4 -  4.4
//
// STRONG short-circuits the scale ladder: the cheap path already found it.
const ARAM_MIN_BENCH_MARGIN = 6;
const ARAM_STRONG_BENCH_MARGIN = 9;
const ARAM_EVIDENCE_MIN_CELLS = 3; // too few filled cells to judge by margin

// A client can be LARGER than the frame that shows it — a capture cropped into
// the client, or a share that cuts off its edges. refineAramClient only reaches
// +/-4% in scale, so those rects are unreachable from a whole-frame seed; the
// ladder re-seeds at these multiples of the seed width before refining. Paid
// only when the cheap path came back without strong evidence.
const ARAM_SCALE_LADDER = [
  0.55, 0.65, 0.75, 0.85, 0.92, 1.0, 1.1, 1.22, 1.35, 1.5, 1.7, 1.9,
];
// Ranking a rung does not need the full per-slot search: the rung was just
// refined, so one centred crop tells us whether champions line up there. The
// winner is re-measured properly afterwards. This is what keeps the rescue path
// affordable — a full-search evidence call costs ~173 hash comparisons per crop
// per slot, and the ladder would otherwise pay it dozens of times.
const ARAM_PROBE_SLOT = { off: 0, step: 1, ds: [0], dsFactor: 1 };
// And measuring one does not need the full 27-crop tight search either: the
// question is "do champions line up here", not "what is the best possible read".
// Nine crops answer it, and the pipeline re-matches properly afterwards anyway.
const ARAM_EVIDENCE_SLOT = { off: 3, step: 3, ds: [0], dsFactor: 1.5 };
// How many rungs are worth paying champion evidence for. Geometry cannot pick
// the winner (it is not comparable across scales) but it is a fine filter: on
// aram-cooldown.png the two correct rungs score 127.2 and 124.7 while the best
// wrong one scores 48.6.
const ARAM_LADDER_CANDIDATES = 6;
// How much full measuring each phase may do. Counting calls is the wrong unit:
// one costs roughly client.w^2 (the crops it hashes scale with the icons), so a
// fixed count either starves a small capture or lets a 4K one run for seconds.
// The budget is spent in w^2, which makes it proportional to real work and,
// unlike a time budget, identical on every machine.
//
// For scale: a 1280-wide client costs 1.6M, so the rescue affords a dozen looks
// at a normal capture and about three at a 2700-wide one.
const ARAM_FAST_EVIDENCE_COST = 10e6;
const ARAM_RESCUE_EVIDENCE_COST = 20e6;

// One cheap pass per rung: it only has to get close enough to judge by champion
// evidence, and the winning rung is re-refined properly afterwards. The reach
// matters more than it looks — a cropped capture's client origin sits tens of
// pixels off the seed, and at reach 16 the rung lands short and reads as noise
// (measured on aram-cooldown.png: reach 16 -> margin 1.0, reach 28 -> 19.1).
const ARAM_LADDER_PASSES = [{ reach: 28, scaleSteps: 3, scaleStep: 0.02 }];

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
    // Sampled, not swept: this is a mean over a flat lane, and on a large frame
    // sweeping every column here is most of the whole score's cost.
    const gx0 = Math.round(right + 2),
      gx1 = Math.round(right + gap - 2);
    const gStep = Math.max(1, Math.round((gx1 - gx0) / 6));
    for (let x = gx0; x <= gx1; x += gStep) {
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
 * Are all 15 template positions actually inside the frame? We can only read what
 * the capture shows, and without this the scale ladder is free to propose a
 * client so large that most of its bench falls off-frame — which is how a
 * screenful of this app's own champion grid gets accepted at 1.9x, every visible
 * "bench cell" being a real champion icon and the margin therefore excellent.
 */
function spotsInFrame(frame, client) {
  for (const s of aramTemplateSpots(client)) {
    const half = s.size / 2;
    if (
      s.cx - half < 0 ||
      s.cy - half < 0 ||
      s.cx + half > frame.W ||
      s.cy + half > frame.H
    )
      return false;
  }
  return true;
}

/** Median margin between best and runner-up over the spots that hold art. */
function spotMargins(frame, spots, iconHashById, circle, quick) {
  const margins = [];
  const opts = {
    tight: true,
    tightConfig: quick ? ARAM_PROBE_SLOT : ARAM_EVIDENCE_SLOT,
  };
  for (const spot of spots) {
    const m = circle
      ? ARAM_CORE.matchCircle(
          frame.buf,
          frame.W,
          frame.H,
          spot,
          iconHashById,
          opts,
        )
      : ARAM_CORE.matchSlot(
          frame.buf,
          frame.W,
          frame.H,
          spot,
          iconHashById,
          opts,
        );
    // An empty panel — or a circle whose player is still picking — is
    // near-uniform and carries no identity evidence either way, so it neither
    // helps nor hurts.
    const empty = circle
      ? ARAM_CORE.CIRCLE_EMPTY_FILL
      : ARAM_CORE.VERIFY_EMPTY_FILL;
    if (!m || !(m.fill >= empty)) continue;
    const alt = (m.alts || []).find((a) => a.id !== m.id);
    margins.push(alt ? alt.score - m.score : 0);
  }
  if (margins.length < ARAM_EVIDENCE_MIN_CELLS) return null;
  margins.sort((a, b) => a - b);
  return margins[Math.floor(margins.length / 2)];
}

/**
 * How strongly does this rectangle look like champion select, judged by champion
 * content rather than by edges? The measure is the MARGIN between each spot's
 * best champion and its runner-up, not the match distance.
 *
 * Why the margin: a dim or washed-out capture pushes every distance up, so
 * absolute distance measures the capture, not the alignment. The margin measures
 * whether ONE champion pulled away from the field — exactly what being centred
 * on an icon causes, and what straddling two icons prevents.
 *
 * Why BOTH the bench and the ally circles: a rect slipped by a whole bench cell
 * still puts every bench crop squarely on *a* champion, so bench margins stay
 * high and cannot see the error (measured on aram-cooldown.png at 0.6x: bench
 * median 21, every name off by one slot). The ally column sits elsewhere in the
 * template entirely, so the same slip lands it on nothing — circle median 5.4.
 * Taking the WORSE of the two makes that failure visible.
 *
 * Circles are only consulted when they hold art: before the picks resolve there
 * is nothing there to judge, and their absence must not veto a good rect.
 *
 * @param {{buf:Uint8ClampedArray,W:number,H:number}} frame
 * @param {{x:number,y:number,w:number,h:number}} client
 * @param {Map} iconHashById
 * @returns {{margin:number, bench:number, circles:number|null}} margin 0 when unjudgeable
 */
function aramBenchEvidence(frame, client, iconHashById, opts) {
  const quick = !!(opts && opts.quick);
  const spots = aramTemplateSpots(client);
  const bench = spotMargins(
    frame,
    spots.filter((s) => s.kind === "bench"),
    iconHashById,
    false,
    quick,
  );
  if (bench == null) return { margin: 0, bench: 0, circles: null };
  const circles = spotMargins(
    frame,
    spots.filter((s) => s.kind === "circle"),
    iconHashById,
    true,
    quick,
  );
  return {
    margin: circles == null ? bench : Math.min(bench, circles),
    bench,
    circles,
  };
}

/**
 * Locate the champ-select client for the fixed ARAM template. Returns null when
 * nothing in the frame is an ARAM bench — better than a confident-looking wrong
 * rectangle, and the signal the UI uses to offer the adaptive pipeline instead.
 *
 * Three stages, and only the first runs in the common case:
 *
 *   1. Seed + refine at the frame's own scale, ranked by edge score. This is the
 *      whole of the old finder and it handles an ordinary window or monitor
 *      share outright.
 *   2. Champion evidence on the best few rects. Strong evidence accepts here.
 *   3. Only if that came back weak: re-seed across ARAM_SCALE_LADDER, because a
 *      client LARGER than the frame is outside coordinate descent's +/-4% reach.
 *      Rungs are ranked by evidence, never by edge score — the edge score is not
 *      comparable across scales and picks the wrong rung when asked.
 *
 * ctx.frameIsClient  the captured surface IS the client (a window or tab share):
 *                    skip the window hunt and refine the frame itself.
 * ctx.iconHashById   without it the whole stage is identity-free and falls back
 *                    to the edge score alone.
 * ctx.minTemplateScore  override the pre-filter floor.
 * ctx.rescue         false skips the scale ladder (the expensive half).
 *
 * @returns {{x:number,y:number,w:number,h:number,score:number,margin:number}|null}
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

  const floor = c.minTemplateScore ?? ARAM_MIN_TEMPLATE_SCORE;
  const asRect = (r) => ({
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.w / ARAM_TEMPLATE.aspect,
  });

  // Candidates: every seed BOTH as given and after refinement. Coordinate
  // descent maximises edge score, which is usually right but can walk a good
  // rect into a nearby local optimum — on a 1.1x window share it lands 34px
  // short and the ally column falls off the portraits. The raw seed costs one
  // evidence probe and covers that, because for a window share the frame really
  // is the client.
  const candidates = [];
  for (const seed of seeds) {
    candidates.push(asRect(seed));
    candidates.push(refineAramClient(frame, seed).client);
  }

  // No champion database: the edge score is the only thing there is. Keep the
  // old, stricter floor here — without identity evidence there is nothing else
  // standing between a weak fit and a confident wrong answer.
  if (!c.iconHashById) {
    let best = null;
    for (const client of candidates) {
      const score = aramTemplateScore(frame, client);
      if (score >= Math.max(floor, 60) && (!best || score > best.score))
        best = { client, score };
    }
    return best ? { ...best.client, score: best.score, margin: 0 } : null;
  }

  // The only hard requirement is that the icons are actually in the picture.
  // Deliberately NOT gated on the edge score: a rect can be a few percent wide,
  // smearing the bench comb down to an edge score of 7, and still put every
  // champion dead centre (measured on a 1.1x window share: edge 7.2, evidence
  // 12.2 — the edge score would have thrown away the best candidate there was).
  const viable = (client) => spotsInFrame(frame, client);
  // Rank on the cheap probe, decide on the full measurement. Never the other
  // way round: the probe is one crop per spot and is meant to order candidates,
  // not to accept one.
  const rank = (list) => {
    const scored = [];
    for (const client of list) {
      if (!viable(client)) continue;
      const ev = aramBenchEvidence(frame, client, c.iconHashById, {
        quick: true,
      });
      scored.push({ client, ev });
    }
    return scored.sort((a, b) => b.ev.margin - a.ev.margin);
  };
  // Measure the shortlist properly, and measure each one BOTH as ranked and
  // after a full polish. A coarsely-placed candidate can sit a few pixels off
  // every icon (weak evidence) and be excellent once refined, while a refined
  // one can have been walked off a good spot by the edge score — so neither
  // version can be trusted to stand for the other.
  // A full measurement is by far the most expensive thing here (~165ms on a
  // 1080p frame), so each phase gets a ration. The probe ordering is what makes
  // a small one enough.
  const settleBest = (scored, budget) => {
    let spent = 0;
    let best = null;
    const take = (client) => {
      if (!client || spent >= budget || !viable(client)) return;
      spent += client.w * client.w;
      const ev = aramBenchEvidence(frame, client, c.iconHashById);
      if (!best || ev.margin > best.ev.margin) best = { client, ev };
    };
    const done = () =>
      (best && best.ev.margin >= ARAM_STRONG_BENCH_MARGIN) || spent >= budget;
    for (const cand of scored.slice(0, ARAM_LADDER_CANDIDATES)) {
      take(cand.client);
      if (done()) break;
      take(refineAramClient(frame, cand.client).client);
      if (done()) break;
    }
    return best;
  };
  const accept = (best) =>
    best && best.ev.margin >= ARAM_MIN_BENCH_MARGIN
      ? {
          ...best.client,
          score: aramTemplateScore(frame, best.client),
          margin: best.ev.margin,
        }
      : null;

  const first = settleBest(rank(candidates), ARAM_FAST_EVIDENCE_COST);
  if (first && first.ev.margin >= ARAM_STRONG_BENCH_MARGIN)
    return accept(first);
  // The rescue below re-seeds the whole scale range, which costs ~10x the cheap
  // path. A live loop polling for champion select several times a second asks
  // for it only occasionally (see LIVE_RESCUE_EVERY in scan-ui.js); a one-off
  // scan of a still image always wants it.
  if (c.rescue === false) return accept(first);

  // Rescue: the client is probably not at the frame's own scale. Only the
  // whole-frame seed gets the ladder — a rectangle found by findClientWindows
  // already carries its own scale, so re-seeding it would only add noise.
  const wide = seeds[seeds.length - 1];
  const rungs = [];
  for (const k of ARAM_SCALE_LADDER) {
    const w = wide.w * k;
    if (ARAM_TEMPLATE.bench.pitch * w < 12) continue;
    const seed = { x: wide.x, y: wide.y, w, h: w / ARAM_TEMPLATE.aspect };
    rungs.push(seed);
    rungs.push(
      refineAramClient(frame, seed, { passes: ARAM_LADDER_PASSES }).client,
    );
  }
  const rescued = settleBest(rank(rungs), ARAM_RESCUE_EVIDENCE_COST);
  const best =
    rescued && (!first || rescued.ev.margin > first.ev.margin)
      ? rescued
      : first;
  return accept(best);
}

// ---------------------------------------------------------------------------
// Ring fit — an identity-free, sub-pixel check of the ally column. Every ally
// portrait sits inside a bright gold ring of a fixed radius, so the client rect
// that best centres those five rings is pinned to within half a pixel without
// knowing who is on screen. Used to label geometry (scan-debug.html "Snap") and
// to re-measure the template; it does not decide reads.
// ---------------------------------------------------------------------------

function lumBilinear(frame, x, y) {
  const { buf, W, H } = frame;
  if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) return 0;
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    fx = x - x0,
    fy = y - y0;
  const L = (u, v) => ARAM_CORE.pxLum(buf, W, u, v);
  return (
    (L(x0, y0) * (1 - fx) + L(x0 + 1, y0) * fx) * (1 - fy) +
    (L(x0, y0 + 1) * (1 - fx) + L(x0 + 1, y0 + 1) * fx) * fy
  );
}

/**
 * How ring-like the template's ally circles are at this rect: brightness on
 * the ring radius minus brightness just inside and outside it, summed over the
 * five allies. The lower-right arc is skipped — the swap badge sits there.
 */
function aramRingScore(frame, client) {
  const r = ARAM_TEMPLATE.allies.ring * client.w;
  let score = 0;
  for (const s of aramTemplateSpots(client))
    if (s.kind === "circle") score += ringScoreAt(frame, s.cx, s.cy, r);
  return score;
}

/** Ring-likeness of ONE circle of radius r at (cx, cy). @see aramRingScore */
function ringScoreAt(frame, cx, cy, r) {
  const d = Math.max(2, r * 0.1);
  let score = 0;
  for (let a = 0; a < 64; a++) {
    const t = (a / 64) * 2 * Math.PI;
    if (t > 0.2 && t < 1.4) continue; // the swap badge
    const c = Math.cos(t),
      si = Math.sin(t);
    const at = (rr) => lumBilinear(frame, cx + c * rr, cy + si * rr);
    score += at(r) - 0.5 * (at(r - d) + at(r + d));
  }
  return score;
}

/**
 * Centre ONE ally ring independently of the template: the best ring centre
 * within ±reach px of (cx, cy). For labelling a single box, and for checking
 * the template against the screen circle by circle.
 * @returns {{cx:number, cy:number}}
 */
function fitRingCenter(frame, cx, cy, r, reach = 4) {
  let best = { cx, cy, v: ringScoreAt(frame, cx, cy, r) };
  for (const step of [1, 0.25]) {
    const c0 = best,
      R = step === 1 ? reach : 1;
    for (let dy = -R; dy <= R; dy += step)
      for (let dx = -R; dx <= R; dx += step) {
        const v = ringScoreAt(frame, c0.cx + dx, c0.cy + dy, r);
        if (v > best.v) best = { cx: c0.cx + dx, cy: c0.cy + dy, v };
      }
  }
  return { cx: best.cx, cy: best.cy };
}

/**
 * Nudge a roughly-right client rect (within ~12 px) until the ally rings are
 * centred: a coarse grid over offset and scale, then a quarter-pixel polish. Keeps the 16:9 aspect.
 * @returns {{x,y,w,h}} the snapped rect (the input if nothing scores better)
 */
function snapAramClient(frame, client) {
  const unit = client.w / ARAM_TEMPLATE.reference.w; // one reference pixel
  let best = { c: client, v: aramRingScore(frame, client) };
  const tryRect = (c) => {
    const v = aramRingScore(frame, c);
    if (v > best.v) best = { c, v };
  };
  const around = (base, reach, step, scales) => {
    for (const k of scales)
      for (let dy = -reach; dy <= reach; dy += step)
        for (let dx = -reach; dx <= reach; dx += step)
          tryRect({
            x: base.x + dx * unit,
            y: base.y + dy * unit,
            w: base.w * k,
            h: base.h * k,
          });
  };
  // Coarse to fine. The coarse pass reaches ±12 px — a two-click placement or
  // a hand nudge lands well inside that — but not the 80 px ring pitch, so it
  // can't lock onto the neighbouring portrait.
  around(client, 12, 2, [0.985, 0.99, 0.995, 1, 1.005, 1.01, 1.015]);
  around(best.c, 2, 1, [0.995, 1, 1.005]);
  around(best.c, 1, 0.5, [0.9975, 1, 1.0025]);
  around(best.c, 0.5, 0.25, [1]);
  // The five rings stack in one column, so they pin offset well and scale
  // poorly — a 0.2% scale error is 2 px at the far end of the bench. Settle the
  // scale on the bench comb instead, pivoting on the ring column's middle so
  // the rings stay where they were fitted.
  const c0 = best.c;
  const T = ARAM_TEMPLATE;
  const px = c0.x + T.allies.cx * c0.w;
  const py =
    c0.y + (T.allies.cy0 + ((T.allies.count - 1) / 2) * T.allies.pitch) * c0.h;
  let bestK = { c: c0, v: aramTemplateScore(frame, c0) };
  for (let k = 0.994; k <= 1.0061; k += 0.0005) {
    const c = {
      x: px - (px - c0.x) * k,
      y: py - (py - c0.y) * k,
      w: c0.w * k,
      h: c0.h * k,
    };
    const v = aramTemplateScore(frame, c);
    if (v > bestK.v) bestK = { c, v };
  }
  return bestK.c;
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
    ARAM_MIN_BENCH_MARGIN,
    ARAM_STRONG_BENCH_MARGIN,
    ARAM_SCALE_LADDER,
    aramBenchEvidence,
    spotsInFrame,
    ARAM_FIXED_MODE,
    aramTemplateSpots,
    aramRingScore,
    snapAramClient,
    fitRingCenter,
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
