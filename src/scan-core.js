// Screenshot scan — pure pipeline math (no DOM): perceptual hashing, color
// signatures, bench-row detection, per-slot matching, and match classification.
// Runs in both the browser and Node (see the module.exports tail) so it is unit-
// tested directly. Tuning constants validated on a real ARAM screenshot.

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
// dHash: downscale region to 9x8 grayscale, compare adjacent columns → 64 bits.
function dHashRegion(buf, W, H, x0, y0, w, h) {
  const gw = 9, gh = 8;
  const g = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const sx0 = x0 + Math.floor((gx * w) / gw), sx1 = x0 + Math.floor(((gx + 1) * w) / gw);
      const sy0 = y0 + Math.floor((gy * h) / gh), sy1 = y0 + Math.floor(((gy + 1) * h) / gh);
      let s = 0, n = 0;
      for (let y = sy0; y < Math.max(sy1, sy0 + 1); y++) {
        if (y < 0 || y >= H) continue;
        for (let x = sx0; x < Math.max(sx1, sx0 + 1); x++) {
          if (x < 0 || x >= W) continue;
          s += pxLum(buf, W, x, y); n++;
        }
      }
      g[gy * gw + gx] = n ? s / n : 0;
    }
  }
  let bits = 0n, k = 0n;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) { if (g[y * 9 + x] < g[y * 9 + x + 1]) bits |= 1n << k; k++; }
  return bits;
}
// 3x3 grid of average RGB → 27-dim color signature.
function colorSigRegion(buf, W, H, x0, y0, w, h) {
  const sig = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const sx0 = x0 + Math.floor((gx * w) / 3), sx1 = x0 + Math.floor(((gx + 1) * w) / 3);
      const sy0 = y0 + Math.floor((gy * h) / 3), sy1 = y0 + Math.floor(((gy + 1) * h) / 3);
      let r = 0, gg = 0, b = 0, n = 0;
      for (let y = sy0; y < sy1; y++) {
        if (y < 0 || y >= H) continue;
        for (let x = sx0; x < sx1; x++) {
          if (x < 0 || x >= W) continue;
          const i = (y * W + x) * 4;
          r += buf[i]; gg += buf[i + 1]; b += buf[i + 2]; n++;
        }
      }
      n = n || 1;
      sig.push(r / n, gg / n, b / n);
    }
  }
  return sig;
}
function hamming64(a, b) {
  let x = a ^ b, c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}
function colorDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / a.length);
}
// Locate the top "Available Champions" square row. Returns nominal slot boxes
// (10 evenly spaced, horizontally centered) plus the band center for search.
function detectBenchRow(buf, W, H) {
  const topN = Math.round(H * 0.2);
  const xa = Math.round(W * 0.24), xb = Math.round(W * 0.75);
  const rowScore = new Float64Array(topN);
  let maxR = 0;
  for (let y = 0; y < topN; y++) {
    let s = 0;
    for (let x = xa + 1; x < xb; x++) s += Math.abs(pxLum(buf, W, x, y) - pxLum(buf, W, x - 1, y));
    rowScore[y] = s / (xb - xa);
    if (rowScore[y] > maxR) maxR = rowScore[y];
  }
  const thr = maxR * 0.35;
  let yt = -1, yb = -1;
  for (let y = 0; y < topN; y++) if (rowScore[y] > thr) { if (yt < 0) yt = y; yb = y; }
  if (yt < 0 || yb - yt < 8) return null;
  const bandH = yb - yt + 1;
  const pitch = bandH * 1.28;
  const nSlots = 10;
  const left = (W - pitch * nSlots) / 2;
  if (left < 0) return null;
  const cy = (yt + yb) / 2;
  const slots = [];
  for (let i = 0; i < nSlots; i++) slots.push({ cx: left + pitch * (i + 0.5), cy });
  return { slots, bandH };
}

// For one slot, search small offsets/sizes and return the best champion match.
// `iconHashById` is a Map(champId -> { h: BigInt dHash, sig: number[27] }).
function matchSlot(buf, W, H, slot, iconHashById) {
  let best = null;
  for (const size of [48, 52, 56]) {
    for (let dx = -10; dx <= 10; dx += 5) {
      for (let dy = -10; dy <= 10; dy += 5) {
        const x0 = Math.round(slot.cx - size / 2 + dx);
        const y0 = Math.round(slot.cy - size / 2 + dy);
        const h = dHashRegion(buf, W, H, x0, y0, size, size);
        // top candidates by Hamming, then re-rank by color signature
        const cands = [];
        iconHashById.forEach((v, id) => cands.push({ id, d: hamming64(h, v.h) }));
        cands.sort((a, b) => a.d - b.d);
        const t = Math.round(size * 0.04);
        const sig = colorSigRegion(buf, W, H, x0 + t, y0 + t, size - 2 * t, size - 2 * t);
        for (let i = 0; i < 8 && i < cands.length; i++) {
          const id = cands[i].id;
          const c = colorDist(sig, iconHashById.get(id).sig);
          const score = cands[i].d + c * 0.35;
          if (!best || score < best.score) best = { id, ham: cands[i].d, color: c, score };
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

// Locate the vertical column of 5 team-pick circles on the left. Returns
// [{ cx, cy, size }] (size = the inscribed-square side to sample), or null.
function detectTeamCircles(buf, W, H) {
  const xa = Math.round(W * 0.035), xb = Math.round(W * 0.095);
  const y0 = Math.round(H * 0.12), y1 = Math.round(H * 0.7);
  const raw = [];
  for (let y = y0; y < y1; y++) {
    let s = 0;
    for (let x = xa; x < xb; x++) {
      const i = (y * W + x) * 4;
      const sat = Math.max(buf[i], buf[i + 1], buf[i + 2]) - Math.min(buf[i], buf[i + 1], buf[i + 2]);
      s += sat + 0.3 * Math.abs(pxLum(buf, W, x, y) - pxLum(buf, W, x - 1, y));
    }
    raw.push(s / (xb - xa));
  }
  // smooth (±4) then find local maxima
  const sm = raw.map((_, i) => {
    let a = 0, n = 0;
    for (let k = -4; k <= 4; k++) { const j = i + k; if (j >= 0 && j < raw.length) { a += raw[j]; n++; } }
    return a / n;
  });
  const peaks = [];
  for (let i = 1; i < sm.length - 1; i++) if (sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) peaks.push({ y: y0 + i, s: sm[i] });
  // greedy: strongest first, keep 5 that are >= minSep apart
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
  // median spacing → circle size; centroid of saturation → column center
  let spacing = H * 0.115;
  if (chosen.length >= 2) {
    const d = [];
    for (let i = 1; i < chosen.length; i++) d.push(chosen[i].y - chosen[i - 1].y);
    d.sort((a, b) => a - b);
    spacing = d[Math.floor(d.length / 2)];
  }
  const size = Math.round(spacing * 0.56);
  let cxNum = 0, cxDen = 0;
  const cxa = Math.round(W * 0.03), cxb = Math.round(W * 0.1);
  for (const c of chosen) {
    for (let x = cxa; x < cxb; x++) {
      const i = (c.y * W + x) * 4;
      const sat = Math.max(buf[i], buf[i + 1], buf[i + 2]) - Math.min(buf[i], buf[i + 1], buf[i + 2]);
      cxNum += x * sat; cxDen += sat;
    }
  }
  const cx = cxDen ? Math.round(cxNum / cxDen) : Math.round(W * 0.064);
  return chosen.map((c) => ({ cx, cy: c.y, size }));
}

// Match one team circle: search offsets/sizes around its inscribed square and
// rank against the icons' center-crop hashes (iconHashById entries carry hC/sigC).
function matchCircle(buf, W, H, circle, iconHashById) {
  let best = null;
  const s = circle.size;
  for (const size of [s - 8, s - 4, s, s + 4, s + 8]) {
    if (size < 20) continue;
    for (let dx = -9; dx <= 9; dx += 3) {
      for (let dy = -9; dy <= 9; dy += 3) {
        const x0 = Math.round(circle.cx - size / 2 + dx);
        const y0 = Math.round(circle.cy - size / 2 + dy);
        const h = dHashRegion(buf, W, H, x0, y0, size, size);
        const cands = [];
        iconHashById.forEach((v, id) => cands.push({ id, d: hamming64(h, v.hC) }));
        cands.sort((a, b) => a.d - b.d);
        const sig = colorSigRegion(buf, W, H, x0, y0, size, size);
        for (let i = 0; i < 8 && i < cands.length; i++) {
          const id = cands[i].id;
          const c = colorDist(sig, iconHashById.get(id).sigC);
          const score = cands[i].d + c * 0.35;
          if (!best || score < best.score) best = { id, ham: cands[i].d, color: c, score };
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
  if (m.color <= CIRCLE_ACCEPT_COLOR && m.ham <= CIRCLE_ACCEPT_HAM) return "accept";
  if (m.color <= CIRCLE_MAYBE_COLOR && m.ham <= CIRCLE_MAYBE_HAM) return "maybe";
  return "reject";
}

// Dual-use: expose the pure API to Node (tests) without disturbing the browser,
// where these top-level declarations are already globals shared across scripts.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pxLum, dHashRegion, colorSigRegion, hamming64, colorDist,
    detectBenchRow, matchSlot, classifyMatch,
    detectTeamCircles, matchCircle, classifyCircleMatch, circleIconRect,
    SCAN_ACCEPT_COLOR, SCAN_ACCEPT_HAM, SCAN_MAYBE_COLOR, SCAN_MAYBE_HAM,
    CIRCLE_ICON_FRAC, CIRCLE_ACCEPT_COLOR, CIRCLE_ACCEPT_HAM,
    CIRCLE_MAYBE_COLOR, CIRCLE_MAYBE_HAM,
  };
}

