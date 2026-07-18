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

// Dual-use: expose the pure API to Node (tests) without disturbing the browser,
// where these top-level declarations are already globals shared across scripts.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pxLum, dHashRegion, colorSigRegion, hamming64, colorDist,
    detectBenchRow, matchSlot, classifyMatch,
    SCAN_ACCEPT_COLOR, SCAN_ACCEPT_HAM, SCAN_MAYBE_COLOR, SCAN_MAYBE_HAM,
  };
}

