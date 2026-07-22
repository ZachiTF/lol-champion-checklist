// Screenshot scan — pure pipeline math (no DOM): perceptual hashing, color
// signatures, layout location (find the client/bench/circles in ANY screenshot),
// per-slot matching, and match classification. Runs in both the browser and Node
// (see the module.exports tail) so it is unit-tested directly.
//
// The locate stage (findBenchBar / locateLayout) makes the scanner robust to a
// full-desktop print screen: it finds the ARAM bench anywhere and at any scale,
// then reconstructs the client rectangle and the team-circle column from it. All
// downstream matching is size-aware, so a client captured at any resolution works.

// Tuning (validated on a real ARAM screenshot — see memory): the color-signature
// distance cleanly separates filled icons (≤16) from empty slots (≥27); the
// Hamming distance overlaps between the two, so it's only a loose sanity cap.
const SCAN_ACCEPT_COLOR = 16; // color distance below this = confident match
const SCAN_ACCEPT_HAM = 20; // loose dHash sanity cap for a confident match
const SCAN_MAYBE_COLOR = 22; // up to here = uncertain (flagged, still shown)
const SCAN_MAYBE_HAM = 24;
// A swap-cooldown shadow (a dark radial sweep over a bench champion) darkens part
// of the icon, pushing its color signature into the "empty" band so a real,
// still-available champion gets rejected. Occupancy rescue: an actually-filled
// slot has champion-level internal contrast (luminance std ~30-75) while an empty
// slot is near-uniform (std ~4-13, even under noise). So when a slot would be
// color-rejected but is clearly filled AND the dHash still names a plausible
// champion, surface it as "maybe" instead of dropping it. This only ever upgrades
// reject→maybe, so the color-based empty rejection is untouched.
const SCAN_FILL_STD = 20; // luminance std above this = a filled (not empty) slot
const SCAN_FILL_HAM = 22; // dHash must still roughly name a champion to rescue

// "Tight" per-slot search window for fast live reads (geometry cached from a prior
// full read). `off`/`step` bound the position search; `ds` are the icon-size
// deltas tried. A pure ±2px position search with no size search (the old value)
// compared a MISALIGNED crop against the clean icon hashes — unfair icon-vs-icon —
// inflating distances 2-5x and occasionally flipping the winner on live frames.
// A little size + position latitude restores alignment while staying far cheaper
// than the full search. (Tunable per call via opts.tightConfig.)
const TIGHT_SLOT = { off: 3, step: 3, ds: [-3, 0, 3] };
// Same idea for team circles (size expressed as a fraction of the full-search
// step). Circles are only 5 per frame and lock in (they don't swap like the
// bench), so a slightly wider window here is cheap and eliminates pick flips.
const TIGHT_CIRCLE = { off: 6, step: 3, dsFactor: 1.5 };

// ---- shared JSDoc shapes for the scan pipeline ----
/**
 * @typedef {{
 *   h: bigint,      // 64-bit dHash of the full square icon (bench match)
 *   sig: number[],  // 27-dim color signature of the full icon
 *   hC: bigint,     // dHash of the center-crop (team-circle match)
 *   sigC: number[]  // color signature of the center-crop
 * }} IconHash
 * @typedef {Map<string, IconHash>} IconHashById champion id → its hashes
 * @typedef {{ id: string, ham: number, color: number, score: number,
 *   alts?: SlotMatch[], fill?: number }} SlotMatch A ranked champion match at
 *   one slot: `ham` = dHash Hamming distance, `color` = color-signature distance,
 *   `score` = combined rank, `fill` = slot luminance std (occupancy).
 */

// ---- pixel helpers over a flat RGBA buffer (area-averaged downscaling) ----
function pxLum(buf, W, x, y) {
  const i = (y * W + x) * 4;
  return 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
}
function pxSat(buf, W, x, y) {
  const i = (y * W + x) * 4;
  return (
    Math.max(buf[i], buf[i + 1], buf[i + 2]) -
    Math.min(buf[i], buf[i + 1], buf[i + 2])
  );
}
// Occupancy: standard deviation of luminance over a square region. High for a
// champion portrait (lots of internal contrast, even when a cooldown shadow dims
// part of it), low for an empty bench panel. Robust to blur/noise/downscale
// because it's a global contrast measure, not a per-pixel edge count.
function fillStd(buf, W, H, cx, cy, size) {
  const x0 = Math.round(cx - size / 2),
    y0 = Math.round(cy - size / 2);
  let n = 0,
    s = 0,
    s2 = 0;
  for (let y = y0; y < y0 + size; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = x0; x < x0 + size; x++) {
      if (x < 0 || x >= W) continue;
      const L = pxLum(buf, W, x, y);
      s += L;
      s2 += L * L;
      n++;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}
// dHash: downscale region to 9x8 grayscale, compare adjacent columns → 64 bits.
function dHashRegion(buf, W, H, x0, y0, w, h) {
  const gw = 9,
    gh = 8;
  const g = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const sx0 = x0 + Math.floor((gx * w) / gw),
        sx1 = x0 + Math.floor(((gx + 1) * w) / gw);
      const sy0 = y0 + Math.floor((gy * h) / gh),
        sy1 = y0 + Math.floor(((gy + 1) * h) / gh);
      let s = 0,
        n = 0;
      for (let y = sy0; y < Math.max(sy1, sy0 + 1); y++) {
        if (y < 0 || y >= H) continue;
        for (let x = sx0; x < Math.max(sx1, sx0 + 1); x++) {
          if (x < 0 || x >= W) continue;
          s += pxLum(buf, W, x, y);
          n++;
        }
      }
      g[gy * gw + gx] = n ? s / n : 0;
    }
  }
  let bits = 0n,
    k = 0n;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      if (g[y * 9 + x] < g[y * 9 + x + 1]) bits |= 1n << k;
      k++;
    }
  return bits;
}
// 3x3 grid of average RGB → 27-dim color signature.
function colorSigRegion(buf, W, H, x0, y0, w, h) {
  const sig = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const sx0 = x0 + Math.floor((gx * w) / 3),
        sx1 = x0 + Math.floor(((gx + 1) * w) / 3);
      const sy0 = y0 + Math.floor((gy * h) / 3),
        sy1 = y0 + Math.floor(((gy + 1) * h) / 3);
      let r = 0,
        gg = 0,
        b = 0,
        n = 0;
      for (let y = sy0; y < sy1; y++) {
        if (y < 0 || y >= H) continue;
        for (let x = sx0; x < sx1; x++) {
          if (x < 0 || x >= W) continue;
          const i = (y * W + x) * 4;
          r += buf[i];
          gg += buf[i + 1];
          b += buf[i + 2];
          n++;
        }
      }
      n = n || 1;
      sig.push(r / n, gg / n, b / n);
    }
  }
  return sig;
}
function hamming64(a, b) {
  let x = a ^ b,
    c = 0;
  while (x) {
    c += Number(x & 1n);
    x >>= 1n;
  }
  return c;
}
function colorDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

// ---- 1-D profile helpers used by the locate stage ----
function smooth1d(A, r) {
  const out = new Float64Array(A.length);
  for (let i = 0; i < A.length; i++) {
    let s = 0,
      n = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j >= 0 && j < A.length) {
        s += A[j];
        n++;
      }
    }
    out[i] = s / n;
  }
  return out;
}
// Column vertical-edge energy summed over rows [yt,yb].
function colEdgeProfile(buf, W, yt, yb) {
  const C = new Float64Array(W);
  for (let x = 1; x < W; x++) {
    let s = 0;
    for (let y = yt; y <= yb; y++)
      s += Math.abs(pxLum(buf, W, x, y) - pxLum(buf, W, x - 1, y));
    C[x] = s;
  }
  return C;
}
// ---- layout calibration (measured on a native 1274x706 ARAM client) ----
const BENCH_SPAN_FRAC = 0.463; // (10*pitch) / clientWidth
const BENCH_CY_FRAC = 0.0439; // bench center y / clientHeight
const CLIENT_ASPECT = 1274 / 706; // champ-select viewport aspect (~16:9)
const CIRCLE_CX_FRAC = 0.0651; // team-circle column center x / clientWidth
const CIRCLE_SIZE_FRAC = 0.81; // circle inscribed square / bench pitch
const ICON_TO_PITCH = 0.78; // bench icon side / pitch (icons are ~square)

const BENCH_PITCH_MIN = 30; // plausible bench-icon pitch in px (rules out thin
const BENCH_PITCH_MAX = 100; // texture and tall low-frequency structure)
const BENCH_FILL_COLOR = 18; // color distance below this = a real champion icon
const BENCH_TEETH = 11; // a 10-slot bench has 11 icon-border columns

// A small, reliable champion match at one position (a couple of sizes + a tiny
// offset), returning the best color distance — low means a real champion icon
// sits here. Used to locate the bench by champion CONTENT, not brightness.
function benchProbeColor(buf, W, H, cx, cy, size, iconHashById, off) {
  let best = Infinity;
  for (const s of [size, size - 4, size + 4]) {
    if (s < 16) continue;
    for (let dx = -off; dx <= off; dx += off) {
      const x0 = Math.round(cx - s / 2 + dx),
        y0 = Math.round(cy - s / 2);
      const h = dHashRegion(buf, W, H, x0, y0, s, s);
      const cands = [];
      iconHashById.forEach((v, id) => cands.push({ id, d: hamming64(h, v.h) }));
      cands.sort((a, b) => a.d - b.d);
      const t = Math.round(s * 0.04);
      const sig = colorSigRegion(
        buf,
        W,
        H,
        x0 + t,
        y0 + t,
        s - 2 * t,
        s - 2 * t,
      );
      for (let i = 0; i < 5 && i < cands.length; i++) {
        const c = colorDist(sig, iconHashById.get(cands[i].id).sig);
        if (c < best) best = c;
      }
    }
  }
  return best;
}

// Resolve the bench's horizontal phase within a band by CHAMPION content. Grid-
// sample champion-match confidence across the band, then pick the 10-slot
// alignment (spacing = pitch) that lands the most champions in a left-packed run
// (champions fill the bench left-to-right). Robust to a bright central splash and
// to empty trailing slots, which brightness/edge phase cues get wrong. Returns
// the left border x0 of slot 0, plus the champion count, or null.
function benchPhaseByContent(buf, W, H, yt, yb, pitch, size, iconHashById) {
  const cy = (yt + yb) / 2;
  const g = Math.max(2, Math.round(pitch / 6));
  const off = Math.max(2, Math.round(g / 2));
  const xs0 = Math.round(size / 2);
  const champ = [];
  for (let x = xs0; x < W - size / 2; x += g)
    champ.push(benchProbeColor(buf, W, H, x, cy, size, iconHashById, off));
  const champAt = (cx) => {
    const idx = Math.round((cx - xs0) / g);
    return idx >= 0 && idx < champ.length ? champ[idx] : Infinity;
  };
  let x0 = null,
    bestScore = -1,
    bestN = 0;
  const maxC0 = W - 1 - 9 * pitch;
  for (let c0 = xs0; c0 <= maxC0; c0 += g) {
    let first = -1,
      n = 0,
      graded = 0;
    for (let i = 0; i < 10; i++) {
      const c = champAt(c0 + pitch * i);
      if (c <= BENCH_FILL_COLOR) {
        if (first < 0) first = i;
        n++;
        graded += 22 - c; // graded score centers the grid on the icons
      }
    }
    if (n < 3 || first !== 0) continue; // slot 0 must sit on a champion
    if (graded > bestScore) {
      bestScore = graded;
      x0 = Math.round(c0 - pitch / 2);
      bestN = n;
    }
  }
  return x0 == null ? null : { x0, n: bestN };
}

// Stage 0 — find the "Available Champions" bench bar ANYWHERE in the image, at
// any scale, even amid browser chrome or an adversarial champion-grid background.
// (1) Candidate bands = LOCAL maxima of the row edge profile (never gated by the
//     global max, so the bench survives when other content is far higher-contrast).
// (2) Select band + pitch by height-normalized periodicity (an 11-tooth comb over
//     icon borders), constrained to a plausible icon pitch — the bench is the most
//     periodic square-icon row.
// (3) Resolve the horizontal phase by champion CONTENT (benchPhaseByContent), not
//     brightness. Try candidate bands strongest-first until one yields a champion
//     run. Needs iconHashById (Map champId -> { h:BigInt, sig:number[27] }).
// Returns { pitch, size, slots:[{cx,cy,size}], bandH, cy, yt, yb, xLeft, xRight,
// center } in image coordinates, or null.
function findBenchBar(buf, W, H, iconHashById) {
  if (!iconHashById || !iconHashById.size) return null;
  const R = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 1; x < W; x++)
      s += Math.abs(pxLum(buf, W, x, y) - pxLum(buf, W, x - 1, y));
    R[y] = s / W;
  }
  const S = smooth1d(R, 2);
  let maxR = 0;
  for (const v of S) if (v > maxR) maxR = v;
  if (maxR <= 0) return null;
  // Inclusive candidate band centers: local maxima of the row edge profile. The
  // floor is deliberately low (not gated on the global max) so the bench survives
  // even when other UI — browser chrome, high-contrast panels — has far higher
  // edge energy; non-champion bands are rejected later by content verification.
  const peaks = [];
  for (let y = 2; y < H - 2; y++)
    if (
      S[y] > maxR * 0.02 &&
      S[y] >= S[y - 1] &&
      S[y] >= S[y - 2] &&
      S[y] > S[y + 1] &&
      S[y] > S[y + 2]
    )
      peaks.push(y);
  peaks.sort((a, b) => S[b] - S[a]);
  const seen = new Set();
  const cands = [];
  for (let pi = 0; pi < peaks.length && pi < 40; pi++) {
    const cy0 = peaks[pi],
      pv = S[cy0];
    let yt = cy0,
      yb = cy0;
    while (yt > 0 && S[yt - 1] > pv * 0.5 && cy0 - yt < H * 0.12) yt--;
    while (yb < H - 1 && S[yb + 1] > pv * 0.5 && yb - cy0 < H * 0.12) yb++;
    const bh = yb - yt + 1;
    if (bh < 22 || bh > H * 0.16) continue;
    const key = yt + "_" + yb;
    if (seen.has(key)) continue;
    seen.add(key);
    const C = smooth1d(colEdgeProfile(buf, W, yt, yb), 1);
    const pExp = bh * 1.28;
    const pmin = Math.max(BENCH_PITCH_MIN, Math.round(pExp * 0.72));
    const pmax = Math.min(BENCH_PITCH_MAX, Math.round(pExp * 1.4));
    if (pmax >= W || pmax < pmin) continue;
    let seedLag = pmin,
      seedA = 0;
    for (let L = pmin; L <= pmax; L++) {
      let a = 0;
      for (let x = 1; x < W - L; x++) a += C[x] * C[x + L];
      a /= W - L || 1;
      if (a > seedA) {
        seedA = a;
        seedLag = L;
      }
    }
    let bp = seedLag,
      be = -1;
    for (
      let p = Math.max(BENCH_PITCH_MIN, seedLag - 3);
      p <= Math.min(BENCH_PITCH_MAX, seedLag + 3);
      p++
    ) {
      const xmax = W - 1 - (BENCH_TEETH - 1) * p;
      let peakE = 0;
      for (let x0 = 0; x0 <= xmax; x0++) {
        let e = 0;
        for (let k = 0; k < BENCH_TEETH; k++) e += C[Math.round(x0 + k * p)];
        if (e > peakE) peakE = e;
      }
      if (peakE > be) {
        be = peakE;
        bp = p;
      }
    }
    cands.push({ yt, yb, pitch: bp, score: be / bh }); // per-row periodicity
  }
  cands.sort((a, b) => b.score - a.score);
  // Verify candidates strongest-first; the first with a champion run is the bench.
  for (let i = 0; i < cands.length && i < 6; i++) {
    const { yt, yb, pitch } = cands[i];
    const size = Math.round(pitch * ICON_TO_PITCH);
    const phase = benchPhaseByContent(
      buf,
      W,
      H,
      yt,
      yb,
      pitch,
      size,
      iconHashById,
    );
    if (!phase) continue;
    const x0 = phase.x0;
    const cy = (yt + yb) / 2;
    const slots = [];
    for (let k = 0; k < 10; k++)
      slots.push({ cx: x0 + pitch * (k + 0.5), cy, size });
    return {
      pitch,
      size,
      slots,
      bandH: yb - yt + 1,
      cy,
      yt,
      yb,
      xLeft: x0,
      xRight: x0 + 10 * pitch,
      center: x0 + 5 * pitch,
    };
  }
  return null;
}

// Reconstruct the champ-select client rectangle from the bench geometry.
function clientFromBench(bench) {
  const w = (10 * bench.pitch) / BENCH_SPAN_FRAC;
  const h = w / CLIENT_ASPECT;
  return { x: bench.center - w / 2, y: bench.cy - BENCH_CY_FRAC * h, w, h };
}
// The team-circle search region (column + vertical band) from a client rect and
// the bench pitch. Split out from circleRegionFromBench so the modular slot
// provider can build it from a trusted client rect (window-share path) too.
function circleRegionFromClientRect(c, pitch, W, H) {
  const cx = c.x + CIRCLE_CX_FRAC * c.w;
  const size = Math.round(pitch * CIRCLE_SIZE_FRAC);
  return {
    xa: Math.max(0, Math.round(cx - size * 0.9)),
    xb: Math.min(W - 1, Math.round(cx + size * 0.9)),
    y0: Math.max(0, Math.round(c.y + 0.14 * c.h)),
    y1: Math.min(H - 1, Math.round(c.y + 0.72 * c.h)),
    cx: Math.round(cx),
    size,
    client: c,
  };
}
// The team-circle search region, derived from the bench (unchanged behavior).
function circleRegionFromBench(bench, W, H) {
  return circleRegionFromClientRect(clientFromBench(bench), bench.pitch, W, H);
}
// Calibrated bench geometry from a trusted client rect — the inverse of
// clientFromBench, using the same measured fractions. Used by the window-share
// path, where the shared surface IS the client so no content search is needed.
function benchFromClientRect(c) {
  const pitch = (c.w * BENCH_SPAN_FRAC) / 10;
  const size = Math.round(pitch * ICON_TO_PITCH);
  const x0 = c.x + c.w / 2 - 5 * pitch;
  const cy = c.y + BENCH_CY_FRAC * c.h;
  const slots = [];
  for (let k = 0; k < 10; k++)
    slots.push({ cx: x0 + pitch * (k + 0.5), cy, size });
  return { pitch, size, slots };
}

// One-shot locate: bench + circle region + client rect. Returns null if no bench.
function locateLayout(buf, W, H, iconHashById) {
  const bench = findBenchBar(buf, W, H, iconHashById);
  if (!bench) return null;
  const circleRegion = circleRegionFromBench(bench, W, H);
  return { bench, circleRegion, client: circleRegion.client };
}

// For one slot, search offsets/sizes around the detected slot size and return the
// best champion match. `opts.tight` collapses the search to a tiny window — for
// live capture, where the geometry is already locked from a prior read and the
// frame is pixel-stable, this is ~45x fewer candidate crops (dropping a poll from
// ~1.5s to tens of ms).
/**
 * @param {Uint8ClampedArray} buf flat RGBA pixel buffer
 * @param {number} W @param {number} H buffer dimensions
 * @param {{ cx: number, cy: number, size?: number }} slot slot center + icon size
 * @param {IconHashById} iconHashById
 * @param {{ tight?: boolean }} [opts]
 * @returns {SlotMatch|null} best match (with `.alts` runners-up), or null
 */
function matchSlot(buf, W, H, slot, iconHashById, opts) {
  // Keep the best score seen per champion id across the whole local search, so we
  // can return not just the winner but the runner-up champions (best.alts). The
  // live consensus uses those runners-up as the "alternatives" for an uncertain
  // slot, and voting across frames leans on them too.
  const per = new Map();
  const s = slot.size || 52;
  const tight = opts && opts.tight;
  const tc = (opts && opts.tightConfig) || TIGHT_SLOT;
  const off = tight ? tc.off : Math.max(6, Math.round(s * 0.22));
  const step = tight ? tc.step : Math.max(3, Math.round(off / 2));
  const sizes = tight
    ? tc.ds.map((d) => s + d)
    : [s - 6, s - 3, s, s + 3, s + 6];
  for (const size of sizes) {
    if (size < 16) continue;
    for (let dx = -off; dx <= off; dx += step) {
      for (let dy = -off; dy <= off; dy += step) {
        const x0 = Math.round(slot.cx - size / 2 + dx);
        const y0 = Math.round(slot.cy - size / 2 + dy);
        const h = dHashRegion(buf, W, H, x0, y0, size, size);
        // top candidates by Hamming, then re-rank by color signature
        const cands = [];
        iconHashById.forEach((v, id) =>
          cands.push({ id, d: hamming64(h, v.h) }),
        );
        cands.sort((a, b) => a.d - b.d);
        const t = Math.round(size * 0.04);
        const sig = colorSigRegion(
          buf,
          W,
          H,
          x0 + t,
          y0 + t,
          size - 2 * t,
          size - 2 * t,
        );
        for (let i = 0; i < 8 && i < cands.length; i++) {
          const id = cands[i].id;
          const c = colorDist(sig, iconHashById.get(id).sig);
          const score = cands[i].d + c * 0.35;
          const prev = per.get(id);
          if (!prev || score < prev.score)
            per.set(id, { id, ham: cands[i].d, color: c, score });
        }
      }
    }
  }
  if (!per.size) return null;
  const ranked = [...per.values()].sort((a, b) => a.score - b.score);
  const best = { ...ranked[0], alts: ranked.slice(0, 4) };
  // Occupancy of the slot itself (independent of which champion won) so
  // classifyMatch can tell a shadowed-but-filled slot from an empty one.
  best.fill = fillStd(buf, W, H, slot.cx, slot.cy, s);
  return best;
}

// Classify a matchSlot result: "accept" (confident champion), "maybe"
// (uncertain — flagged in the UI), or "reject" (an empty bench slot). The
// color-signature distance is the real filled-vs-empty discriminator.
function classifyMatch(m) {
  if (!m) return "reject";
  if (m.color <= SCAN_ACCEPT_COLOR && m.ham <= SCAN_ACCEPT_HAM) return "accept";
  if (m.color <= SCAN_MAYBE_COLOR && m.ham <= SCAN_MAYBE_HAM) return "maybe";
  // Occupancy rescue: a color-rejected slot that is clearly filled (champion-level
  // contrast) and still names a plausible champion is a real champion dimmed by a
  // swap-cooldown shadow — surface it as uncertain rather than dropping it.
  if (m.fill != null && m.fill >= SCAN_FILL_STD && m.ham <= SCAN_FILL_HAM)
    return "maybe";
  return "reject";
}

// ---- team-pick circles (the 5 circular portraits down the left) ----
// These are your team's locked-in champions. Circular art differs more from the
// square icon than the bench squares do, so: match a clean inscribed square (no
// mask — a circular mask's boundary would swamp the hash for dark portraits)
// against a center-crop of each icon (CIRCLE_ICON_FRAC), with looser thresholds.
const CIRCLE_ICON_FRAC = 0.72; // central fraction of the icon a circle maps to
const CIRCLE_ACCEPT_COLOR = 28; // circle matches run higher than bench squares
const CIRCLE_ACCEPT_HAM = 20;
const CIRCLE_MAYBE_COLOR = 46;
const CIRCLE_MAYBE_HAM = 26;

// The center-crop rect of a square icon that a team circle should be matched to.
function circleIconRect(size) {
  const t = Math.round((size * (1 - CIRCLE_ICON_FRAC)) / 2);
  return { x: t, y: t, w: size - 2 * t, h: size - 2 * t };
}

// Given 5 rough row centers (sorted), regularize them to the even spacing the UI
// actually uses. A brightness/edge profile occasionally puts one row on a strong
// distractor (a UI divider, a champion's glow) instead of the portrait center;
// that single outlier is enough to flip a match. RANSAC a 2-point comb (every
// index pair defines a start+pitch), keep the comb with the most inliers, then
// snap only the far outliers back onto it. Well-placed rows (all fixtures) are
// inliers and pass through unchanged; only a genuine outlier (image-1's Thresh,
// ~17px off) is corrected.
function regularizeRowCenters(c) {
  if (c.length < 5) return c;
  let best = null;
  for (let i = 0; i < c.length; i++)
    for (let j = i + 1; j < c.length; j++) {
      const pitch = (c[j] - c[i]) / (j - i);
      if (pitch <= 0) continue;
      const start = c[i] - i * pitch;
      const tol = Math.max(4, pitch * 0.15);
      let inliers = 0,
        err = 0;
      for (let k = 0; k < c.length; k++) {
        const d = Math.abs(c[k] - (start + k * pitch));
        if (d <= tol) inliers++;
        err += Math.min(d, tol);
      }
      if (
        !best ||
        inliers > best.inliers ||
        (inliers === best.inliers && err < best.err)
      )
        best = { inliers, err, start, pitch, tol };
    }
  if (!best) return c;
  return c.map((cy, k) => {
    const pred = best.start + k * best.pitch;
    return Math.abs(cy - pred) > best.tol ? Math.round(pred) : cy;
  });
}

// Locate the 5 team-pick circles within an explicit search region (from
// circleRegionFromBench). Returns [{ cx, cy, size }] or null.
function detectTeamCirclesIn(buf, W, H, region) {
  const { xa, xb, y0, y1 } = region;
  if (xb - xa < 4 || y1 - y0 < 20) return null;
  const raw = [];
  for (let y = y0; y < y1; y++) {
    let s = 0;
    for (let x = xa; x < xb; x++)
      s +=
        pxSat(buf, W, x, y) +
        0.3 * Math.abs(pxLum(buf, W, x, y) - pxLum(buf, W, x - 1, y));
    raw.push(s / (xb - xa));
  }
  const sm = smooth1d(Float64Array.from(raw), 4);
  const peaks = [];
  for (let i = 1; i < sm.length - 1; i++)
    if (sm[i] >= sm[i - 1] && sm[i] > sm[i + 1])
      peaks.push({ y: y0 + i, s: sm[i] });
  const minSep = Math.round((y1 - y0) / 8);
  peaks.sort((a, b) => b.s - a.s);
  const chosen = [];
  for (const p of peaks) {
    if (p.s < 8) break;
    if (chosen.every((c) => Math.abs(c.y - p.y) >= minSep)) chosen.push(p);
    if (chosen.length === 5) break;
  }
  if (chosen.length < 3) return null;
  chosen.sort((a, b) => a.y - b.y);
  // Regularize the row centers to even spacing so a single distractor peak can't
  // displace a row (only far outliers are snapped; see regularizeRowCenters).
  const cys = regularizeRowCenters(chosen.map((c) => c.y));
  // median row spacing → circle size; saturation centroid → column center (a few
  // px matter for the dark portraits, so refine cx rather than trusting the region).
  let spacing = region.size / CIRCLE_SIZE_FRAC;
  if (chosen.length >= 2) {
    const d = [];
    for (let i = 1; i < chosen.length; i++)
      d.push(chosen[i].y - chosen[i - 1].y);
    d.sort((a, b) => a - b);
    spacing = d[Math.floor(d.length / 2)];
  }
  const size = Math.round(spacing * 0.56);
  let cxNum = 0,
    cxDen = 0;
  for (const cy of cys)
    for (let x = xa; x < xb; x++) {
      const s = pxSat(buf, W, x, cy);
      cxNum += x * s;
      cxDen += s;
    }
  const cx = cxDen ? Math.round(cxNum / cxDen) : region.cx;
  return cys.map((cy) => ({ cx, cy, size }));
}

// Locate the team circles by first finding the bench, then the region below it.
function detectTeamCircles(buf, W, H, iconHashById) {
  const bench = findBenchBar(buf, W, H, iconHashById);
  if (!bench) return null;
  return detectTeamCirclesIn(buf, W, H, circleRegionFromBench(bench, W, H));
}

// Match one team circle: search offsets/sizes around its inscribed square and
// rank against the icons' center-crop hashes (iconHashById entries carry hC/sigC).
// Offsets scale with the detected size, reducing to the original ±9/step-3 grid
// when size≈48 so native-resolution results are unchanged.
function matchCircle(buf, W, H, circle, iconHashById, opts) {
  const per = new Map();
  const s = circle.size;
  const f = s / 48;
  const tight = opts && opts.tight;
  const ds = Math.max(4, Math.round(4 * f));
  // Tight (cached-geometry) search still needs SOME size latitude — a fixed size
  // compared a misaligned crop against the icons' center-crops, inflating circle
  // distances (~16→21) and flipping picks. `dsT` is a smaller size step than the
  // full search so it stays cheap. (Tunable via opts.tightConfig.)
  const tc = (opts && opts.tightConfig) || TIGHT_CIRCLE;
  const dsT = Math.max(3, Math.round(tc.dsFactor * ds));
  const off = tight ? tc.off : Math.max(9, Math.round(9 * f));
  const step = tight ? tc.step : Math.max(3, Math.round(3 * f));
  const sizes = tight
    ? [s - dsT, s, s + dsT]
    : [s - 2 * ds, s - ds, s, s + ds, s + 2 * ds];
  for (const size of sizes) {
    if (size < 16) continue;
    for (let dx = -off; dx <= off; dx += step) {
      for (let dy = -off; dy <= off; dy += step) {
        const x0 = Math.round(circle.cx - size / 2 + dx);
        const y0 = Math.round(circle.cy - size / 2 + dy);
        const h = dHashRegion(buf, W, H, x0, y0, size, size);
        const cands = [];
        iconHashById.forEach((v, id) =>
          cands.push({ id, d: hamming64(h, v.hC) }),
        );
        cands.sort((a, b) => a.d - b.d);
        const sig = colorSigRegion(buf, W, H, x0, y0, size, size);
        for (let i = 0; i < 8 && i < cands.length; i++) {
          const id = cands[i].id;
          const c = colorDist(sig, iconHashById.get(id).sigC);
          const score = cands[i].d + c * 0.35;
          const prev = per.get(id);
          if (!prev || score < prev.score)
            per.set(id, { id, ham: cands[i].d, color: c, score });
        }
      }
    }
  }
  if (!per.size) return null;
  const ranked = [...per.values()].sort((a, b) => a.score - b.score);
  return { ...ranked[0], alts: ranked.slice(0, 4) };
}

// Team circles are always real champions (a full ARAM team is 5), so there is no
// "empty" case — only accept vs uncertain (flagged) vs reject (detection junk).
function classifyCircleMatch(m) {
  if (!m) return "reject";
  if (m.color <= CIRCLE_ACCEPT_COLOR && m.ham <= CIRCLE_ACCEPT_HAM)
    return "accept";
  if (m.color <= CIRCLE_MAYBE_COLOR && m.ham <= CIRCLE_MAYBE_HAM)
    return "maybe";
  return "reject";
}

// Read the bench (the up-to-10 "available champions" squares) from a located
// frame. Returns the deduped ids, which are uncertain, and the slots that read as
// a champion (used later for a cheap "is champion select still here?" check).
// `iconHashById` is the champion hash map; `opts.tight` collapses the per-slot
// search (see matchSlot) for fast reads on pixel-stable live frames.
function readBench(buf, W, H, layout, iconHashById, opts) {
  const ids = [];
  const uncertain = new Set();
  const filledSlots = [];
  // Per-position result for EVERY slot (including empty ones), in bench order, so
  // the live consensus can vote position-by-position across frames.
  const slots = [];
  for (const slot of layout.bench.slots) {
    const m = matchSlot(buf, W, H, slot, iconHashById, opts);
    const verdict = classifyMatch(m);
    slots.push({ m, verdict });
    if (verdict === "reject" || !m) continue;
    filledSlots.push(slot);
    if (!ids.includes(m.id)) {
      ids.push(m.id);
      if (verdict === "maybe") uncertain.add(m.id);
    }
  }
  return { ids, uncertain, filledSlots, slots };
}
// Read the 5 team-pick circles down the left. Returns the deduped ids, which are
// uncertain, and how many picks resolved (used to detect a full read).
function readPicks(buf, W, H, layout, iconHashById, opts) {
  const ids = [];
  const uncertain = new Set();
  const circles = detectTeamCirclesIn(buf, W, H, layout.circleRegion) || [];
  // Per-position result for every detected circle (top-to-bottom), so the live
  // consensus can vote each pick slot across frames as picks lock in.
  const circleResults = [];
  let picks = 0;
  for (const circle of circles) {
    const m = matchCircle(buf, W, H, circle, iconHashById, opts);
    const verdict = classifyCircleMatch(m);
    circleResults.push({ m, verdict });
    if (verdict === "reject" || !m) continue;
    picks++;
    if (!ids.includes(m.id)) {
      ids.push(m.id);
      if (verdict === "maybe") uncertain.add(m.id);
    }
  }
  return { ids, uncertain, picks, circles: circleResults };
}
// Merge bench + picks reads into one deduped id list (bench first).
function combineReads(a, b) {
  const ids = a.ids.slice();
  const uncertain = new Set(a.uncertain);
  for (const id of b.ids) {
    if (!ids.includes(id)) ids.push(id);
    if (b.uncertain.has(id)) uncertain.add(id);
  }
  return { ids, uncertain };
}

// ---- temporal consensus across live frames --------------------------------
// Champ select FILLS IN over time (the five team picks lock one by one) and then
// people SWAP bench champions around in a chaotic way, so a champion does NOT
// stay in a fixed slot. Tracking per-position is therefore the wrong model: it
// mislabels a late-locking pick and can drop a late bench swap. Instead we keep
// only the last few frames and vote by champion IDENTITY (anywhere on screen):
//   • a champion recognized in most recent frames is confident;
//   • one seen in a single old frame (a transient misread — a frame grabbed mid-
//     animation, a cursor over an icon) is filtered out;
//   • one seen intermittently is surfaced as "maybe" with its alternatives.
// The readiness signal is dead simple and cheap: the five TEAM CIRCLES. While any
// circle is still a grey placeholder we keep watching; once all five show a
// champion (for a couple of frames, so a mid-animation flicker can't trigger it)
// the read is stable and we finalize. A short window also keeps latency low —
// finalize lands ~`confirm` polls after the fifth pick appears, not seconds later.
const AGG_WINDOW = 4; // recent frames kept for identity voting (older ones drop off)
const AGG_CONFIRM = 2; // frames an id / the 5-circles signal must hold to be trusted

function createScanAggregator(opts) {
  const o = opts || {};
  return {
    window: [],
    maxFrames: o.window || AGG_WINDOW,
    confirm: o.confirm || AGG_CONFIRM,
  };
}
// Reduce one frame's per-position matches to what identity voting needs: the set
// of recognized champions (with their best verdict + alternative ids) and how
// many of the five team circles currently show a champion.
function aggFrameRecord(benchSlots, pickCircles) {
  const info = new Map(); // id -> { accept:bool, alts:Set }
  const fold = (pos) => {
    const m = pos && pos.m;
    if (!m || pos.verdict === "reject") return false;
    let rec = info.get(m.id);
    if (!rec) {
      rec = { accept: false, alts: new Set() };
      info.set(m.id, rec);
    }
    if (pos.verdict === "accept") rec.accept = true;
    for (const a of m.alts || []) if (a.id !== m.id) rec.alts.add(a.id);
    return true;
  };
  for (const s of benchSlots || []) fold(s);
  let picksFilled = 0;
  for (const c of pickCircles || []) if (fold(c)) picksFilled++;
  return { info, picksFilled };
}
// Push a frame into the rolling window (dropping the oldest beyond maxFrames).
function aggregateFrame(agg, benchSlots, pickCircles) {
  agg.window.push(aggFrameRecord(benchSlots, pickCircles));
  while (agg.window.length > agg.maxFrames) agg.window.shift();
}
// Read the running consensus over the recent window: the deduped id list, which
// ids are uncertain, each uncertain id's alternative champions, per-id support,
// how many circles are filled right now, and whether the read is stable.
function aggregateResult(agg) {
  const frames = agg.window;
  const n = frames.length;
  const last = n ? frames[n - 1] : null;
  const confirm = Math.min(agg.confirm, n || 1);
  // Tally appearances + collect alternatives across the window; keep a stable
  // first-seen order so the pinned list doesn't reshuffle every poll.
  const seen = new Map(); // id -> { count, accept, alts:Set }
  const order = [];
  for (const f of frames) {
    f.info.forEach((rec, id) => {
      let s = seen.get(id);
      if (!s) {
        s = { count: 0, accept: false, alts: new Set() };
        seen.set(id, s);
        order.push(id);
      }
      s.count++;
      if (rec.accept) s.accept = true;
      rec.alts.forEach((a) => s.alts.add(a));
    });
  }
  const ids = [];
  const uncertain = new Set();
  const alternatives = new Map();
  const confidence = new Map();
  for (const id of order) {
    const s = seen.get(id);
    // Show an id if it's held across enough recent frames (real) OR it's in the
    // current frame (the honest live guess). An id seen only in an OLD frame and
    // gone now is a transient misread — dropped.
    if (s.count < confirm && !(last && last.info.has(id))) continue;
    // Confident only when it recurs AND at least one clean "accept" read backs it.
    const verdict = s.count >= confirm && s.accept ? "accept" : "maybe";
    ids.push(id);
    if (verdict === "maybe") uncertain.add(id);
    const alts = [...s.alts].filter((a) => a !== id).slice(0, 3);
    if (alts.length) alternatives.set(id, alts);
    confidence.set(id, { count: s.count, frames: n });
  }
  // Readiness: all five team circles filled for the last `confirm` frames.
  let picksStreak = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (frames[i].picksFilled >= 5) picksStreak++;
    else break;
  }
  return {
    ids,
    uncertain,
    alternatives,
    confidence,
    picksFilled: last ? last.picksFilled : 0,
    picksStreak,
    frames: n,
    stable: n >= confirm && picksStreak >= confirm,
  };
}

// ============================================================================
// MODULAR PIPELINE — Frame → ClientFinder → SlotProvider → IconMatcher
// ============================================================================
// A champ-select read is three swappable stages, each a plain function you can
// exchange and unit-test in isolation. The tuned primitives above (findBenchBar,
// matchSlot, matchCircle, classify*, detectTeamCirclesIn) are the sub-functions
// these stages compose — they stay individually exported and tested.
//
//   1. ClientFinder  (frame, ctx) -> ClientRect|null    WHERE is champ select?
//   2. SlotProvider  (frame, client, ctx) -> Spot[]     WHERE should icons be?
//   3. IconMatcher   (frame, spots, ctx) -> SpotMatch[] WHICH champion is there?
//
// The SlotProvider is where a game MODE lives (ARAM bench+circles, Arena grid,
// Summoner's Rift bans + two team columns). The ClientFinder is capture-dependent
// (whole-frame for a shared window; content-search for an arbitrary screenshot)
// and mostly mode-independent. `ctx` carries { iconHashById, tight?, client? }.
/**
 * @typedef {{ buf: Uint8ClampedArray, W: number, H: number }} Frame
 * @typedef {{ x:number, y:number, w:number, h:number, hints?:object }} ClientRect
 * @typedef {{ kind:string, index:number, cx:number, cy:number, size:number, group?:string }} Spot
 *   kind: "bench" | "circle" | "ban" | "grid"; `group` optionally tags a team/side.
 * @typedef {{ spot:Spot, id:(string|null), verdict:("accept"|"maybe"|"reject"),
 *   score:number, alts:string[], m:(SlotMatch|null) }} SpotMatch
 * @typedef {(frame:Frame, ctx:object) => (ClientRect|null)} ClientFinder
 * @typedef {(frame:Frame, client:ClientRect, ctx:object) => Spot[]} SlotProvider
 * @typedef {(frame:Frame, spots:Spot[], ctx:object) => SpotMatch[]} IconMatcher
 */

// ---- Stage 1: ClientFinders ------------------------------------------------
// Window/tab share: the shared surface IS the client, so it's the whole frame.
// Trivial and mode-agnostic — the fast path a live capture usually hits.
/** @type {ClientFinder} */
function wholeFrameClient(frame) {
  return { x: 0, y: 0, w: frame.W, h: frame.H };
}
// Arbitrary screenshot (ARAM): find the bench by content + periodicity and
// reconstruct the client from it, forwarding the found geometry as hints so the
// slot provider needn't re-search. Needs ctx.iconHashById.
/** @type {ClientFinder} */
function benchAnchoredClient(frame, ctx) {
  const bench = findBenchBar(frame.buf, frame.W, frame.H, ctx.iconHashById);
  if (!bench) return null;
  const c = clientFromBench(bench);
  const circleRegion = circleRegionFromBench(bench, frame.W, frame.H);
  return { x: c.x, y: c.y, w: c.w, h: c.h, hints: { bench, circleRegion } };
}

// ---- Stage 2: SlotProviders (one per game MODE) ----------------------------
// ARAM: up to 10 bench squares along the top + 5 team circles down the left.
/** @type {SlotProvider} */
function aramSlots(frame, client, ctx) {
  const spots = [];
  // Bench: exact slots from a searching client-finder's hints when present, else
  // calibrated from the (trusted) client rect on the window-share path.
  const bench =
    (client.hints && client.hints.bench) || benchFromClientRect(client);
  bench.slots.forEach((s, i) =>
    spots.push({ kind: "bench", index: i, cx: s.cx, cy: s.cy, size: s.size }),
  );
  // Circles: detect the 5 rows within the search region, then emit their spots.
  const region =
    (client.hints && client.hints.circleRegion) ||
    circleRegionFromClientRect(client, bench.pitch, frame.W, frame.H);
  const circles =
    detectTeamCirclesIn(frame.buf, frame.W, frame.H, region) || [];
  circles.forEach((c, i) =>
    spots.push({ kind: "circle", index: i, cx: c.cx, cy: c.cy, size: c.size }),
  );
  return spots;
}

// Arena (2v2v2v2): one central grid of every champion — no bench, no team
// circles. Placeholder geometry showing how the mode plugs in; the fractions are
// TODO(arena): measure them against a real Arena screenshot before wiring it up.
const ARENA_GRID = { cols: 12, rows: 8, x: 0.2, y: 0.2, w: 0.6, h: 0.6 }; // TODO
/** @type {SlotProvider} */
function arenaSlots(frame, client) {
  const g = ARENA_GRID;
  const x0 = client.x + g.x * client.w;
  const y0 = client.y + g.y * client.h;
  const cw = (g.w * client.w) / g.cols;
  const ch = (g.h * client.h) / g.rows;
  const size = Math.round(Math.min(cw, ch) * 0.8);
  const spots = [];
  let i = 0;
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++)
      spots.push({
        kind: "grid",
        index: i++,
        cx: Math.round(x0 + (c + 0.5) * cw),
        cy: Math.round(y0 + (r + 0.5) * ch),
        size,
      });
  return spots;
}

// Summoner's Rift draft: 5 bans top-left + 5 bans top-right, and 5 team circles
// down each side (blue left, red right), each tagged with a `group`. Placeholder
// geometry — TODO(rift): measure all fractions against a real draft screenshot.
const RIFT = {
  banY: 0.06,
  banPitch: 0.045,
  banSize: 0.035,
  banLeftX: 0.2,
  banRightX: 0.8,
  circleY0: 0.2,
  circlePitch: 0.14,
  circleSize: 0.05,
  leftX: 0.04,
  rightX: 0.96,
}; // TODO measure
/** @type {SlotProvider} */
function riftSlots(frame, client) {
  const px = (fx) => Math.round(client.x + fx * client.w);
  const py = (fy) => Math.round(client.y + fy * client.h);
  const spots = [];
  let i = 0;
  const banSize = Math.round(RIFT.banSize * client.w);
  for (let k = 0; k < 5; k++) {
    spots.push({
      kind: "ban",
      group: "blue",
      index: i++,
      cx: px(RIFT.banLeftX + k * RIFT.banPitch),
      cy: py(RIFT.banY),
      size: banSize,
    });
    spots.push({
      kind: "ban",
      group: "red",
      index: i++,
      cx: px(RIFT.banRightX - k * RIFT.banPitch),
      cy: py(RIFT.banY),
      size: banSize,
    });
  }
  const cSize = Math.round(RIFT.circleSize * client.w);
  for (let k = 0; k < 5; k++) {
    const cy = py(RIFT.circleY0 + k * RIFT.circlePitch);
    spots.push({
      kind: "circle",
      group: "blue",
      index: i++,
      cx: px(RIFT.leftX),
      cy,
      size: cSize,
    });
    spots.push({
      kind: "circle",
      group: "red",
      index: i++,
      cx: px(RIFT.rightX),
      cy,
      size: cSize,
    });
  }
  return spots;
}

// ---- Stage 3: IconMatcher --------------------------------------------------
// Reduce a raw SlotMatch + verdict into the stage's SpotMatch shape.
function toSpotMatch(spot, m, verdict) {
  return {
    spot,
    id: m ? m.id : null,
    verdict,
    score: m ? m.score : Infinity,
    alts: m ? (m.alts || []).map((a) => a.id).filter((id) => id !== m.id) : [],
    m,
  };
}
// Perceptual matcher: square icons (bench/grid/ban) use the full-icon hashes and
// classifyMatch; circular portraits use the center-crop hashes (matchCircle) and
// classifyCircleMatch. Same tuned primitives, dispatched by spot kind.
/** @type {IconMatcher} */
function perceptualMatcher(frame, spots, ctx) {
  const { buf, W, H } = frame;
  const opts = ctx.tight ? { tight: true } : undefined;
  return spots.map((spot) => {
    if (spot.kind === "circle") {
      const m = matchCircle(buf, W, H, spot, ctx.iconHashById, opts);
      return toSpotMatch(spot, m, classifyCircleMatch(m));
    }
    const m = matchSlot(buf, W, H, spot, ctx.iconHashById, opts);
    return toSpotMatch(spot, m, classifyMatch(m));
  });
}

// ---- Pipeline + mode registry ----------------------------------------------
/**
 * @param {{ findClient:ClientFinder, provideSlots:SlotProvider, matchIcons:IconMatcher }} stages
 */
function createPipeline({ findClient, provideSlots, matchIcons }) {
  return {
    findClient,
    provideSlots,
    matchIcons,
    // A cached ClientRect on ctx.client short-circuits the finder for fast live
    // reads on a pixel-stable frame; provideSlots still re-runs (picks fill in).
    run(frame, ctx) {
      const c = (ctx && ctx.client) || findClient(frame, ctx);
      if (!c) return { client: null, spots: [], matches: [] };
      const spots = provideSlots(frame, c, ctx);
      const matches = matchIcons(frame, spots, ctx);
      return { client: c, spots, matches };
    },
  };
}

// Ready-made modes. Swap `provideSlots` to change game mode, `findClient` to
// change how the client is located (e.g. wholeFrameClient for a shared window).
const SCAN_MODES = {
  aram: {
    findClient: benchAnchoredClient,
    provideSlots: aramSlots,
    matchIcons: perceptualMatcher,
  },
  arena: {
    findClient: wholeFrameClient,
    provideSlots: arenaSlots,
    matchIcons: perceptualMatcher,
  },
  rift: {
    findClient: wholeFrameClient,
    provideSlots: riftSlots,
    matchIcons: perceptualMatcher,
  },
};
function pipelineForMode(modeId, overrides) {
  const mode = SCAN_MODES[modeId] || SCAN_MODES.aram;
  return createPipeline({ ...mode, ...(overrides || {}) });
}

// Reduce a pipeline result into the app's read shape (deduped ids, uncertain set,
// per-position records for the temporal consensus). Mirrors the old
// readBench + readPicks + combineReads exactly: bench-first dedup, uncertain
// carries from either source, filledSlots covers every non-reject bench slot.
function runFrameRead(pipeline, frame, ctx) {
  const { client, matches } = pipeline.run(frame, ctx);
  if (!client) return { client: null };
  const benchM = matches.filter((x) => x.spot.kind !== "circle");
  const circleM = matches.filter((x) => x.spot.kind === "circle");
  const ids = [];
  const uncertain = new Set();
  const filledSlots = [];
  const take = (x) => {
    if (x.verdict === "reject" || !x.m) return false;
    if (!ids.includes(x.m.id)) ids.push(x.m.id);
    if (x.verdict === "maybe") uncertain.add(x.m.id);
    return true;
  };
  for (const x of benchM) if (take(x)) filledSlots.push(x.spot);
  const benchCount = ids.length;
  let picks = 0;
  for (const x of circleM) if (take(x)) picks++;
  return {
    client,
    ids,
    uncertain,
    benchCount,
    picks,
    filledSlots,
    // `spot` (box geometry) rides along for the live focus overlay; the temporal
    // consensus only reads `m`/`verdict` and ignores it.
    benchSlots: benchM.map((x) => ({
      spot: x.spot,
      m: x.m,
      verdict: x.verdict,
    })),
    pickCircles: circleM.map((x) => ({
      spot: x.spot,
      m: x.m,
      verdict: x.verdict,
    })),
  };
}

// Dual-use: expose the pure API to Node (tests) without disturbing the browser,
// where these top-level declarations are already globals shared across scripts.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pxLum,
    pxSat,
    fillStd,
    dHashRegion,
    colorSigRegion,
    hamming64,
    colorDist,
    findBenchBar,
    locateLayout,
    clientFromBench,
    circleRegionFromBench,
    circleRegionFromClientRect,
    benchFromClientRect,
    matchSlot,
    classifyMatch,
    detectTeamCircles,
    detectTeamCirclesIn,
    matchCircle,
    classifyCircleMatch,
    readBench,
    readPicks,
    combineReads,
    createScanAggregator,
    aggregateFrame,
    aggregateResult,
    circleIconRect,
    // Modular pipeline (Frame → ClientFinder → SlotProvider → IconMatcher)
    wholeFrameClient,
    benchAnchoredClient,
    aramSlots,
    arenaSlots,
    riftSlots,
    perceptualMatcher,
    toSpotMatch,
    createPipeline,
    SCAN_MODES,
    pipelineForMode,
    runFrameRead,
    AGG_WINDOW,
    AGG_CONFIRM,
    SCAN_ACCEPT_COLOR,
    SCAN_ACCEPT_HAM,
    SCAN_MAYBE_COLOR,
    SCAN_MAYBE_HAM,
    CIRCLE_ICON_FRAC,
    CIRCLE_ACCEPT_COLOR,
    CIRCLE_ACCEPT_HAM,
    CIRCLE_MAYBE_COLOR,
    CIRCLE_MAYBE_HAM,
  };
}
