// Generic grid-structure detection — a DEBUG-ONLY experiment, not the reader.
// Nothing in the app consumes it: only scan-debug.html loads this file (its
// collapsed "generic grid detector" panel) and test/scan-grids.test.js pins it.
// It used to live in scan-core.js, which made the page and the Web Worker load
// ~250 lines they never run.

// Dual-use, same pattern as scan-aram.js: require() under Node, the SCAN_CORE
// object scan-core.js already declared in the browser. Never globalThis.
const GRID_CORE =
  typeof module !== "undefined" && module.exports
    ? require("./scan-core.js")
    : SCAN_CORE;

// Find the dominant regular grid(s) of ~square cells in a frame WITHOUT the
// champion database. A scenario matcher (downstream) reads the returned geometry
// and decides what the grid IS (ARAM bench, champion-grid modal, …) purely from
// its shape/position, and only THEN matches champion identity per cell. This is
// the "don't jump straight to which-of-173-champions" layer.
//
// The detectors are a pluggable ensemble: each proposes candidate grids; the
// runner merges near-duplicates. This first cut ships one strong, position-
// agnostic detector (edge-projection + autocorrelation on both axes); a
// position-prior detector and others register alongside it.

const GRID_PITCH_MIN = 24; // smallest plausible cell pitch (px)
const GRID_PITCH_MAX = 220; // largest — covers a 2.5x maximized high-DPI client
const GRID_CELL_FILL = 0.8; // drawn cell side / pitch (icons nearly fill the cell)
const GRID_MIN_STRENGTH = 0.12; // min normalized autocorrelation to trust a pitch

/**
 * @typedef {{ r:number, c:number, cx:number, cy:number, size:number }} GridCell
 * @typedef {{
 *   source:string, rows:number, cols:number, pitchX:number, pitchY:number,
 *   size:number, x0:number, y0:number, cells:GridCell[],
 *   bbox:{x:number,y:number,w:number,h:number}, score:number,
 *   strengthX:number, strengthY:number
 * }} GridCandidate
 */

// Horizontal-edge energy per row, summed over columns [xa,xb] — the row analogue
// of colEdgeProfile. Peaks mark the top/bottom borders of a row of cells.
function rowEdgeProfile(buf, W, H, xa, xb) {
  const R = new Float64Array(H);
  const x1 = Math.max(1, xa | 0),
    x2 = Math.min(W - 1, xb | 0);
  for (let y = 1; y < H; y++) {
    let s = 0;
    for (let x = x1; x <= x2; x++)
      s += Math.abs(
        GRID_CORE.pxLum(buf, W, x, y) - GRID_CORE.pxLum(buf, W, x, y - 1),
      );
    R[y] = s;
  }
  return R;
}

// Dominant period of a 1-D profile by normalized autocorrelation over a pitch
// range. Returns { pitch, strength }, strength = peak covariance / variance.
function autocorrPitch(P, pmin, pmax) {
  const n = P.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += P[i];
  mean /= n || 1;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const v = P[i] - mean;
    variance += v * v;
  }
  if (variance <= 0) return { pitch: 0, strength: 0 };
  const lo = Math.max(2, pmin | 0),
    hi = Math.min(n - 2, pmax | 0);
  // BIASED estimator: divide every lag by the SAME n, not (n-L). The unbiased
  // /(n-L) form inflates large lags and locks onto harmonics (e.g. a 40px comb
  // reads as 200); the constant divisor tapers long lags and prefers the
  // fundamental period.
  let bestLag = 0,
    bestA = 0;
  for (let L = lo; L <= hi; L++) {
    let a = 0;
    for (let i = 0; i + L < n; i++) a += (P[i] - mean) * (P[i + L] - mean);
    a /= n;
    if (a > bestA) {
      bestA = a;
      bestLag = L;
    }
  }
  return { pitch: bestLag, strength: Math.max(0, bestA / (variance / n)) };
}

// Given a pitch, resolve the grid's phase and cell count along one axis: slide a
// border comb (every `pitch`) to the offset with peak summed border energy, then
// keep the longest contiguous run of borders that clear a fraction of the peak
// border — so trailing empty space doesn't inflate the count. Returns
// { origin, count }: `count` cells of width `pitch` starting at border `origin`.
function combPhaseCount(P, pitch) {
  const n = P.length;
  if (pitch < 2) return { origin: 0, count: 1 };
  const at = (x) => {
    const xi = Math.round(x);
    let m = 0;
    for (let d = -2; d <= 2; d++) {
      const j = xi + d;
      if (j >= 0 && j < n && P[j] > m) m = P[j];
    }
    return m;
  };
  let bestPhase = 0,
    bestSum = -1;
  for (let ph = 0; ph < pitch; ph++) {
    let s = 0;
    for (let x = ph; x < n; x += pitch) s += at(x);
    if (s > bestSum) {
      bestSum = s;
      bestPhase = ph;
    }
  }
  const borders = [];
  for (let x = bestPhase; x < n; x += pitch) borders.push(x);
  if (borders.length < 2) return { origin: bestPhase, count: 1 };
  let maxB = 0;
  for (const x of borders) maxB = Math.max(maxB, at(x));
  const thr = maxB * 0.4;
  let bi = 0,
    bl = 0,
    ci = -1,
    cl = 0;
  for (let i = 0; i < borders.length; i++) {
    if (at(borders[i]) >= thr) {
      if (ci < 0) ci = i;
      cl = i - ci + 1;
      if (cl > bl) {
        bl = cl;
        bi = ci;
      }
    } else ci = -1;
  }
  if (bl < 2) return { origin: borders[0], count: 1 };
  return { origin: borders[bi], count: bl - 1 };
}

// Build the cell list + bbox for a grid from its axis geometry.
function gridFromAxes(source, x0, y0, pitchX, pitchY, cols, rows, sx, sy) {
  const size = Math.round(Math.min(pitchX, pitchY) * GRID_CELL_FILL);
  const cells = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      cells.push({
        r,
        c,
        cx: Math.round(x0 + (c + 0.5) * pitchX),
        cy: Math.round(y0 + (r + 0.5) * pitchY),
        size,
      });
  return {
    source,
    rows,
    cols,
    pitchX,
    pitchY,
    size,
    x0,
    y0,
    cells,
    bbox: { x: x0, y: y0, w: cols * pitchX, h: rows * pitchY },
    score: sx * (rows > 1 ? sy : 1),
    strengthX: sx,
    strengthY: sy,
  };
}

// Strong, position-agnostic detector: recover column pitch from the vertical-edge
// projection and (if the cells tile vertically too) row pitch from the horizontal-
// edge projection, then phase/extent by comb. One candidate, or [] if no periodic
// square-cell structure stands out. `opts.region` limits the search band.
function detectGridByProjection(frame, opts) {
  const { buf, W, H } = frame;
  const o = opts || {};
  const rg = o.region || { x: 0, y: 0, w: W, h: H };
  const xa = Math.max(0, rg.x | 0),
    ya = Math.max(0, rg.y | 0),
    xb = Math.min(W - 1, (rg.x + rg.w) | 0),
    yb = Math.min(H - 1, (rg.y + rg.h) | 0);
  const pmin = o.pitchMin || GRID_PITCH_MIN,
    pmax = o.pitchMax || GRID_PITCH_MAX;
  const minS = o.minStrength || GRID_MIN_STRENGTH;

  const Cx = GRID_CORE.smooth1d(GRID_CORE.colEdgeProfile(buf, W, ya, yb), 1); // vertical borders → cols
  const Cy = GRID_CORE.smooth1d(rowEdgeProfile(buf, W, H, xa, xb), 1); // horizontal borders → rows
  // Confine each axis's pitch/phase search to the region band ON THAT AXIS (Cx is
  // indexed by x, Cy by y); origins are shifted back into full-frame coords below.
  const CxR = Cx.slice(xa, xb + 1);
  const CyR = Cy.slice(ya, yb + 1);
  const px = autocorrPitch(CxR, pmin, pmax);
  if (!px.pitch || px.strength < minS)
    return { grids: [], Cx, Cy, xa, ya, px, py: null };
  const py = autocorrPitch(CyR, pmin, pmax);

  const pitchX = px.pitch;
  // Square-cell prior for the row pitch: trust the vertical autocorrelation only
  // if it's near the column pitch, else fall back to square cells (pitchY=pitchX).
  const pitchYGuess =
    py.pitch && Math.abs(py.pitch - pitchX) <= pitchX * 0.5 ? py.pitch : pitchX;

  const cx = combPhaseCount(CxR, pitchX);
  const cy = combPhaseCount(CyR, pitchYGuess);
  const cols = Math.max(1, cx.count);
  // Rows come from the comb COUNT, not autocorrelation strength: a single bench
  // row yields one cell (2 borders); a modal yields several — even though its
  // caption text makes the vertical periodicity weak.
  const rows = Math.max(1, cy.count);
  const pitchY = rows > 1 ? pitchYGuess : pitchX;
  const x0 = cx.origin + xa;
  const y0 = cy.origin + ya;

  const grid = gridFromAxes(
    "projection",
    x0,
    y0,
    pitchX,
    pitchY,
    cols,
    rows,
    px.strength,
    rows > 1 ? py.strength : 0,
  );
  return { grids: [grid], Cx, Cy, xa, ya, px, py };
}

// Pluggable ensemble. Register more detectors (position prior, contour/morphology,
// Hough-like line voting) here; the runner collects and merges their candidates.
const GRID_DETECTORS = [detectGridByProjection];

// Run every enabled detector, merge near-duplicate grids (same pitch/origin), and
// return candidates strongest-first. `opts.debug` also returns each detector's raw
// diagnostics (projections, pitches) for the debugger to visualize.
function detectGrids(frame, opts) {
  const o = opts || {};
  const detectors = o.detectors || GRID_DETECTORS;
  const grids = [];
  const diags = [];
  for (const det of detectors) {
    const out = det(frame, o) || {};
    diags.push({ source: det.name, ...out });
    for (const g of out.grids || []) grids.push(g);
  }
  // Merge grids whose origin+pitch nearly coincide (keep the higher score).
  const merged = [];
  for (const g of grids.sort((a, b) => b.score - a.score)) {
    const dup = merged.find(
      (m) =>
        Math.abs(m.pitchX - g.pitchX) < 4 &&
        Math.abs(m.x0 - g.x0) < g.pitchX * 0.5 &&
        Math.abs(m.y0 - g.y0) < Math.max(g.pitchY, 8),
    );
    if (!dup) merged.push(g);
  }
  return o.debug ? { grids: merged, diags } : { grids: merged };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    rowEdgeProfile,
    autocorrPitch,
    combPhaseCount,
    detectGridByProjection,
    detectGrids,
    GRID_DETECTORS,
    GRID_PITCH_MIN,
    GRID_PITCH_MAX,
  };
}
