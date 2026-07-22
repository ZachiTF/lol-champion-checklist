// Web Worker: runs the pure pixel pipeline (locate + read) off the main thread so
// the UI — live preview, "Checking…" countdown, spinner — stays smooth while a
// scan runs. scan-core.js is self-contained pure math (no DOM), so importScripts
// pulls it in here just as a <script> tag does on the page. The main thread falls
// back to running the same functions inline when workers aren't available (e.g. a
// page opened directly from a file:// path, where workers are blocked).
importScripts("scan-core.js");

// Champion hash map, rebuilt once from the serialized items the page sends, plus
// the ARAM pipeline that composes the pure stages (ClientFinder → SlotProvider →
// IconMatcher) from scan-core.js.
let byId = null;
let pipeline = null;

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
    pipeline = pipelineForMode("aram");
    self.postMessage({ type: "ready" });
    return;
  }

  if (m.type === "scan") {
    if (!byId) {
      self.postMessage({ type: "result", id: m.id, client: null });
      return;
    }
    const frame = { buf: new Uint8ClampedArray(m.buf), W: m.w, H: m.h };
    // A cached client (from a prior read) short-circuits the locate stage.
    const ctx = {
      iconHashById: byId,
      tight: !!m.tight,
      client: m.client || null,
    };
    const r = runFrameRead(pipeline, frame, ctx);
    if (!r.client) {
      self.postMessage({ type: "result", id: m.id, client: null });
      return;
    }
    self.postMessage({
      type: "result",
      id: m.id,
      client: r.client,
      ids: r.ids,
      uncertainIds: [...r.uncertain],
      benchCount: r.benchCount,
      picks: r.picks,
      filledSlots: r.filledSlots,
      // Per-position matches so the main thread can vote across frames.
      benchSlots: r.benchSlots,
      pickCircles: r.pickCircles,
    });
  }
};
