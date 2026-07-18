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
// Contiguous runs of a profile above a threshold → [ [start,end], ... ].
function contiguousRuns(S, thr) {
  const out = [];
  let st = -1;
  for (let i = 0; i < S.length; i++) {
    if (S[i] > thr) {
      if (st < 0) st = i;
    } else if (st >= 0) {
      out.push([st, i - 1]);
      st = -1;
    }
  }
  if (st >= 0) out.push([st, S.length - 1]);
  return out;
}
// Moving sum over a centered window of width w.
function boxSum1d(A, w) {
  const n = A.length,
    out = new Float64Array(n),
    h = Math.floor(w / 2);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += A[i];
    if (i - w >= 0) acc -= A[i - w];
    if (i - h >= 0) out[i - h] = acc;
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
// Column saturation (colorfulness) summed over rows [yt,yb].
function colSatProfile(buf, W, yt, yb) {
  const V = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = yt; y <= yb; y++) s += pxSat(buf, W, x, y);
    V[x] = s;
  }
  return V;
}

// ---- layout calibration (measured on a native 1274x706 ARAM client) ----
const BENCH_SPAN_FRAC = 0.463; // (10*pitch) / clientWidth
const BENCH_CY_FRAC = 0.0439; // bench center y / clientHeight
const CLIENT_ASPECT = 1274 / 706; // champ-select viewport aspect (~16:9)
const CIRCLE_CX_FRAC = 0.0651; // team-circle column center x / clientWidth
const CIRCLE_SIZE_FRAC = 0.81; // circle inscribed square / bench pitch
const ICON_TO_PITCH = 0.78; // bench icon side / pitch (icons are ~square)

// Stage 0 — find the "Available Champions" bench bar ANYWHERE in the image, at
// any scale. The bench is a horizontal strip of ~square icons: two couplings
// make it unique vs. desktop clutter — (a) icons are square, so pitch ≈ 1.28*bandH;
// (b) the strip repeats ~10x. We pick the horizontal band whose column-edge
// profile is most periodic at a square-consistent pitch (an 11-tooth comb over
// icon borders), then anchor the grid's phase on the most colorful icon (a filled
// champion) and walk left to slot 0, since champions fill the bench left-to-right.
// Returns { pitch, size, slots:[{cx,cy,size}], bandH, cy, yt, yb, xLeft, xRight,
// center } in image coordinates, or null.
function findBenchBar(buf, W, H) {
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
  const bands = contiguousRuns(S, maxR * 0.45);
  const TEETH = 11; // a 10-slot bench has 11 icon-border columns
  let best = null;
  for (const [yt, yb] of bands) {
    const bh = yb - yt + 1;
    if (bh < 10 || bh > H * 0.22) continue;
    const C = smooth1d(colEdgeProfile(buf, W, yt, yb), 1);
    // icons are square: seed the pitch search near 1.28*bandH via autocorrelation.
    const pExp = bh * 1.28;
    const pmin = Math.max(20, Math.round(pExp * 0.72));
    const pmax = Math.round(pExp * 1.4);
    if (pmax >= W) continue;
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
    // Matched comb filter selects the band + pitch (rewards the 11-tooth bench
    // structure over any other periodic strip). Phase (x0) is refined below.
    for (let p = Math.max(20, seedLag - 3); p <= seedLag + 3; p++) {
      const xmax = W - 1 - (TEETH - 1) * p;
      for (let x0 = 0; x0 <= xmax; x0++) {
        let e = 0;
        for (let k = 0; k < TEETH; k++) e += C[Math.round(x0 + k * p)];
        if (!best || e > best.comb) best = { yt, yb, bh, pitch: p, comb: e };
      }
    }
  }
  if (!best) return null;
  const { yt, yb, pitch } = best;
  // Phase: anchor on the most colorful icon window, then walk left to slot 0.
  const V = smooth1d(colSatProfile(buf, W, yt, yb), 2);
  const win = Math.max(3, Math.round(pitch * 0.7));
  const Bx = boxSum1d(V, win);
  let Xc = win,
    bmax = 0;
  for (let x = 0; x < W; x++)
    if (Bx[x] > bmax) {
      bmax = Bx[x];
      Xc = x;
    }
  const fillThr = bmax * 0.45;
  let leftC = Xc;
  while (leftC - pitch >= win && Bx[Math.round(leftC - pitch)] > fillThr)
    leftC -= pitch;
  const x0 = Math.round(leftC - pitch / 2);
  const cy = (yt + yb) / 2;
  const size = Math.round(pitch * ICON_TO_PITCH);
  const slots = [];
  for (let i = 0; i < 10; i++)
    slots.push({ cx: x0 + pitch * (i + 0.5), cy, size });
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

// Reconstruct the champ-select client rectangle from the bench geometry.
function clientFromBench(bench) {
  const w = (10 * bench.pitch) / BENCH_SPAN_FRAC;
  const h = w / CLIENT_ASPECT;
  return { x: bench.center - w / 2, y: bench.cy - BENCH_CY_FRAC * h, w, h };
}
// The team-circle search region (column + vertical band), derived from the bench.
function circleRegionFromBench(bench, W, H) {
  const c = clientFromBench(bench);
  const cx = c.x + CIRCLE_CX_FRAC * c.w;
  const size = Math.round(bench.pitch * CIRCLE_SIZE_FRAC);
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

// One-shot locate: bench + circle region + client rect. Returns null if no bench.
function locateLayout(buf, W, H) {
  const bench = findBenchBar(buf, W, H);
  if (!bench) return null;
  const circleRegion = circleRegionFromBench(bench, W, H);
  return { bench, circleRegion, client: circleRegion.client };
}

// For one slot, search offsets/sizes around the detected slot size and return the
// best champion match. `iconHashById` is Map(champId -> { h:BigInt, sig:[27] }).
function matchSlot(buf, W, H, slot, iconHashById) {
  let best = null;
  const s = slot.size || 52;
  const off = Math.max(6, Math.round(s * 0.22));
  const step = Math.max(3, Math.round(off / 2));
  for (const size of [s - 6, s - 3, s, s + 3, s + 6]) {
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
          if (!best || score < best.score)
            best = { id, ham: cands[i].d, color: c, score };
        }
      }
    }
  }
  return best;
}

// Classify a matchSlot result: "accept" (confident champion), "maybe"
// (uncertain — flagged in the UI), or "reject" (an empty bench slot). The
// color-signature distance is the real filled-vs-empty discriminator.
function classifyMatch(m) {
  if (!m) return "reject";
  if (m.color <= SCAN_ACCEPT_COLOR && m.ham <= SCAN_ACCEPT_HAM) return "accept";
  if (m.color <= SCAN_MAYBE_COLOR && m.ham <= SCAN_MAYBE_HAM) return "maybe";
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
  for (const c of chosen)
    for (let x = xa; x < xb; x++) {
      const s = pxSat(buf, W, x, c.y);
      cxNum += x * s;
      cxDen += s;
    }
  const cx = cxDen ? Math.round(cxNum / cxDen) : region.cx;
  return chosen.map((c) => ({ cx, cy: c.y, size }));
}

// Locate the team circles by first finding the bench, then the region below it.
function detectTeamCircles(buf, W, H) {
  const bench = findBenchBar(buf, W, H);
  if (!bench) return null;
  return detectTeamCirclesIn(buf, W, H, circleRegionFromBench(bench, W, H));
}

// Match one team circle: search offsets/sizes around its inscribed square and
// rank against the icons' center-crop hashes (iconHashById entries carry hC/sigC).
// Offsets scale with the detected size, reducing to the original ±9/step-3 grid
// when size≈48 so native-resolution results are unchanged.
function matchCircle(buf, W, H, circle, iconHashById) {
  let best = null;
  const s = circle.size;
  const f = s / 48;
  const off = Math.max(9, Math.round(9 * f));
  const step = Math.max(3, Math.round(3 * f));
  const ds = Math.max(4, Math.round(4 * f));
  for (const size of [s - 2 * ds, s - ds, s, s + ds, s + 2 * ds]) {
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
          if (!best || score < best.score)
            best = { id, ham: cands[i].d, color: c, score };
        }
      }
    }
  }
  return best;
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

// Dual-use: expose the pure API to Node (tests) without disturbing the browser,
// where these top-level declarations are already globals shared across scripts.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pxLum,
    pxSat,
    dHashRegion,
    colorSigRegion,
    hamming64,
    colorDist,
    findBenchBar,
    locateLayout,
    clientFromBench,
    circleRegionFromBench,
    matchSlot,
    classifyMatch,
    detectTeamCircles,
    detectTeamCirclesIn,
    matchCircle,
    classifyCircleMatch,
    circleIconRect,
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
