// Web Worker: runs the pure pixel pipeline (locate + read) off the main thread so
// the UI — live preview, "Checking…" countdown, spinner — stays smooth while a
// scan runs. scan-core.js is self-contained pure math (no DOM), so importScripts
// pulls it in here just as a <script> tag does on the page. The main thread falls
// back to running the same functions inline when workers aren't available (e.g. a
// page opened directly from a file:// path, where workers are blocked).
importScripts("scan-core.js");

// Champion hash map, rebuilt once from the serialized items the page sends.
let byId = null;

self.onmessage = (e) => {
  const m = e.data;

  if (m.type === "hashes") {
    byId = new Map(
      m.items.map((it) => [
        it.id,
        {
          h: BigInt("0x" + it.h),
          sig: it.sig,
          hC: BigInt("0x" + it.hC),
          sigC: it.sigC,
        },
      ]),
    );
    self.postMessage({ type: "ready" });
    return;
  }

  if (m.type === "scan") {
    if (!byId) {
      self.postMessage({ type: "result", id: m.id, layout: null });
      return;
    }
    const data = new Uint8ClampedArray(m.buf);
    // Reuse a cached layout if the page passed one; else locate from scratch.
    const layout = m.layout || locateLayout(data, m.w, m.h, byId);
    if (!layout) {
      self.postMessage({ type: "result", id: m.id, layout: null });
      return;
    }
    const opts = m.tight ? { tight: true } : undefined;
    const bench = readBench(data, m.w, m.h, layout, byId, opts);
    const picks = readPicks(data, m.w, m.h, layout, byId, opts);
    const { ids, uncertain } = combineReads(bench, picks);
    self.postMessage({
      type: "result",
      id: m.id,
      layout,
      ids,
      uncertainIds: [...uncertain],
      benchCount: bench.ids.length,
      picks: picks.picks,
      filledSlots: bench.filledSlots,
      // Per-position matches so the main thread can vote across frames.
      benchSlots: bench.slots,
      pickCircles: picks.circles,
    });
  }
};
