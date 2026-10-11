// Screenshot scan — running a frame through the reader: the Web Worker client
// (with its file:// Blob fallback) and the main-thread fallback when no worker
// can be created. One entry point, scanFrameAsync, shared by the one-shot
// (pasted image) path in scan-ui.js and the live loop in scan-live.js.

// ---- Web Worker: run locate + read off the main thread (live loop) ----
// Keeps the UI (preview, countdown, spinner) fluid while a scan runs. Falls back
// to running the same functions inline when a worker can't be created — notably a
// page opened from a file:// path, where workers are blocked.
let scanWorker = null;
let scanWorkerReady = false;
let scanWorkerDisabled = false;
let scanWorkerReadyPromise = null;
let scanWorkerBlobUrl = null; // set only on the file:// Blob-worker fallback
let scanReqId = 1;
const scanReqPending = new Map(); // id -> resolve

// Absolute URLs for the pipeline scripts. A Blob worker's base URL is the blob
// itself, so it can't resolve relative importScripts — it needs these spelled out.
function scanWorkerUrls() {
  const tag = document.querySelector('script[src*="scan-core.js"]');
  const core = tag ? tag.src : new URL("src/scan-core.js", location.href).href;
  const sibling = (name) => core.replace(/scan-core\.js(\?.*)?$/, name);
  return {
    core,
    aram: sibling("scan-aram.js"),
    worker: sibling("scan-worker.js"),
  };
}

function ensureScanWorker() {
  if (scanWorker || scanWorkerDisabled) return scanWorker;
  if (typeof Worker === "undefined" || !iconHashes || !iconHashes.items)
    return null;
  const urls = scanWorkerUrls();
  try {
    scanWorker = new Worker(urls.worker);
  } catch (_) {
    // Opening index.html straight off disk (the README's own instructions) makes
    // this throw SecurityError: a classic worker can't be loaded from a path on
    // an "origin 'null'" page. That used to drop EVERY locate onto the main
    // thread — a 1-2s freeze per poll, which is what made the panel unusable.
    // A Blob worker has no such restriction and can pull in the same two files
    // by absolute URL, so the pipeline stays off-thread on file:// too.
    try {
      const boot = `importScripts(${[urls.core, urls.aram, urls.worker]
        .map((u) => JSON.stringify(u))
        .join(", ")});`;
      scanWorkerBlobUrl = URL.createObjectURL(
        new Blob([boot], { type: "text/javascript" }),
      );
      scanWorker = new Worker(scanWorkerBlobUrl);
    } catch (_) {
      scanWorkerDisabled = true; // genuinely no worker here — main thread it is
      return null;
    }
  }
  scanWorkerReadyPromise = new Promise((res) => {
    scanWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") {
        scanWorkerReady = true;
        res();
      } else if (m.type === "result") {
        const resolve = scanReqPending.get(m.id);
        if (resolve) {
          scanReqPending.delete(m.id);
          resolve(m);
        }
      }
    };
  });
  scanWorker.onerror = () => teardownScanWorker(true);
  scanWorker.postMessage({ type: "hashes", items: iconHashes.items });
  return scanWorker;
}
function teardownScanWorker(disable) {
  if (scanWorker) {
    try {
      scanWorker.terminate();
    } catch (_) {}
    scanWorker = null;
  }
  scanWorkerReady = false;
  if (scanWorkerBlobUrl) {
    URL.revokeObjectURL(scanWorkerBlobUrl);
    scanWorkerBlobUrl = null;
  }
  if (disable) scanWorkerDisabled = true; // worker errored — stay on the main thread
  scanReqPending.forEach((resolve) => resolve(null));
  scanReqPending.clear();
}

// Run one frame through the worker; resolves the worker's message, or null if the
// worker died. A slow answer is NOT a failure — see the timeout note below.
//
// The pixel buffer is TRANSFERRED, not cloned: a full-screen share is 8-30 MB per
// frame and cloning that on every poll is main-thread time we're trying to save.
// Transferring detaches it, which is fine because grabLiveFrame hands us a fresh
// buffer each poll and nothing reads it afterwards.
const SCAN_WORKER_TIMEOUT_MS = 30000; // only a hung-worker backstop, not a deadline
function scanViaWorker(buf, w, h, opts) {
  return new Promise((resolve) => {
    const id = scanReqId++;
    let done = false;
    const finish = (m) => {
      if (done) return;
      done = true;
      resolve(m);
    };
    scanReqPending.set(id, (m) => finish(m));
    // A generous backstop for a genuinely wedged worker. It must stay well above
    // the slowest real locate (a full search over a 4K frame is ~2s) — the old 4s
    // deadline fired routinely and then re-ran that same multi-second locate
    // SYNCHRONOUSLY on the main thread, freezing the UI and the buttons with it.
    // On expiry we recycle the worker rather than taking over the main thread.
    setTimeout(() => {
      if (scanReqPending.delete(id)) {
        teardownScanWorker(false); // recycle; a later poll builds a fresh one
        finish(null);
      }
    }, SCAN_WORKER_TIMEOUT_MS);
    scanWorker.postMessage({ type: "scan", id, buf, w, h, ...opts }, [
      buf.buffer,
    ]);
  });
}

// Lazily-built main-thread pipelines, one per reader — the fallback when a Web
// Worker isn't available (file://, blocked). Same stages the worker composes.
const scanMainPipelines = new Map();
function getScanPipeline(mode) {
  const id = mode || scanReader;
  if (!scanMainPipelines.has(id))
    scanMainPipelines.set(id, pipelineForMode(id));
  return scanMainPipelines.get(id);
}

// Locate + read a frame through the modular pipeline, off-thread when possible.
// `opts.client` short-circuits the locate stage on a pixel-stable live frame;
// `opts.frameIsClient` tells the fixed template the capture IS champion select.
// Returns { layout(=client), ids, uncertain, picks, benchCount, filledSlots,
// benchSlots, pickCircles } or { layout:null }. (The field is named `layout` for
// back-compat with the live loop; it now carries the located ClientRect.)
async function scanFrameAsync(buf, w, h, opts) {
  const o = {
    mode: scanReader,
    client: null,
    tight: false,
    frameIsClient: false,
    rescue: true,
    ...(opts || {}),
  };
  const worker = ensureScanWorker();
  if (worker) {
    if (!scanWorkerReady && scanWorkerReadyPromise) {
      // Wait for the worker to come up. If it never does, disable it for good so
      // the main-thread path is a deliberate, one-time decision — not something
      // we silently drop into mid-session on every slow frame.
      await Promise.race([
        scanWorkerReadyPromise,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (!scanWorkerReady) teardownScanWorker(true);
    }
    if (scanWorkerReady) {
      const m = await scanViaWorker(buf, w, h, o);
      // A null answer means the worker died/was recycled. Skip this frame rather
      // than running the same heavy locate on the main thread — that freeze is
      // what made the Start over / Stop sharing buttons unclickable.
      if (!m || !m.client) return { layout: null };
      return {
        layout: m.client,
        ids: m.ids,
        uncertain: new Set(m.uncertainIds),
        picks: m.picks,
        benchCount: m.benchCount,
        filledSlots: m.filledSlots,
        verify: m.verify,
        benchSlots: m.benchSlots,
        pickCircles: m.pickCircles,
      };
    }
  }
  // Main thread only when there is genuinely no worker (file://, blocked). This
  // path DOES block the UI for the duration of the read; it's the documented
  // fallback, not something a slow frame can drop us into.
  const frame = { buf, W: w, H: h };
  const ctx = {
    iconHashById: iconHashes.byId,
    tight: o.tight,
    client: o.client,
    frameIsClient: o.frameIsClient,
    rescue: o.rescue,
  };
  const r = runFrameRead(getScanPipeline(o.mode), frame, ctx);
  if (!r.client) return { layout: null };
  return {
    layout: r.client,
    ids: r.ids,
    uncertain: r.uncertain,
    picks: r.picks,
    benchCount: r.benchCount,
    filledSlots: r.filledSlots,
    verify: r.verify,
    benchSlots: r.benchSlots,
    pickCircles: r.pickCircles,
  };
}
