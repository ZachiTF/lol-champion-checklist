// Screenshot scan — UI glue: the inline scan panel, live screen capture,
// paste/drop handling, icon-hash building, and the pinned "Available now"
// group. Pure pipeline math lives in scan-core.js.

// ============================================================================
// CHAMPION SCAN — paste an ARAM champion-select screenshot, detect the top
// "Available Champions" square icons, and pin them into an "Available now"
// group at the top of the grid so you can see at a glance which you still need.
//
// Fully client-side: champion icons are hashed live from Data Dragon (which
// serves permissive CORS), matched with a perceptual hash (dHash) refined by a
// small per-slot local search and re-ranked by a color signature. See the
// prototype validation in project memory for the tuned thresholds.
// ============================================================================

// Detected champion ids from the last scan; renderScanResults pins these.
let scanState = {
  ids: [],
  uncertain: new Set(),
  alternatives: new Map(),
  active: false,
};

// Champion icon hashes, keyed by champ id: { h: BigInt (64-bit dHash), sig: [27] }.
let iconHashes = null;
const ICON_HASH_STORE = "lol_icon_hashes"; // localStorage cache, keyed by patch

function loadCrossOriginImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("load failed: " + url));
    img.src = url;
  });
}

// Build (or restore from localStorage) a hash per champion icon. Cached by patch.
const ICON_HASH_VERSION = 2; // bump when the stored hash shape changes (added hC/sigC)

async function ensureIconHashes(onProgress) {
  if (iconHashes && iconHashes.patch === PATCH) return iconHashes;
  try {
    const raw = JSON.parse(localStorage.getItem(ICON_HASH_STORE) || "null");
    if (
      raw &&
      raw.v === ICON_HASH_VERSION &&
      raw.patch === PATCH &&
      Array.isArray(raw.items)
    ) {
      const byId = new Map(
        raw.items.map((it) => [
          it.id,
          {
            h: BigInt("0x" + it.h),
            sig: it.sig,
            hC: BigInt("0x" + it.hC),
            sigC: it.sigC,
          },
        ]),
      );
      iconHashes = { patch: PATCH, byId, items: raw.items };
      return iconHashes;
    }
  } catch (_) {}

  const byId = new Map();
  const items = [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let done = 0;
  const CONC = 12; // small concurrency pool over ~170 icons
  const queue = champions.slice();
  async function worker() {
    while (queue.length) {
      const champ = queue.shift();
      try {
        const img = await loadCrossOriginImage(
          CHAMPION_ICON_BASE + champ.image.full,
        );
        const w = img.naturalWidth,
          h = img.naturalHeight;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(img, 0, 0);
        const buf = ctx.getImageData(0, 0, w, h).data;
        // Bench squares match the full icon; team circles match a center-crop.
        const hash = dHashRegion(buf, w, h, 0, 0, w, h);
        const t = Math.round(w * 0.04);
        const sig = colorSigRegion(buf, w, h, t, t, w - 2 * t, h - 2 * t);
        const r = circleIconRect(w);
        const hashC = dHashRegion(buf, w, h, r.x, r.y, r.w, r.h);
        const sigC = colorSigRegion(buf, w, h, r.x, r.y, r.w, r.h);
        byId.set(champ.id, { h: hash, sig, hC: hashC, sigC });
        items.push({
          id: champ.id,
          h: hash.toString(16).padStart(16, "0"),
          sig,
          hC: hashC.toString(16).padStart(16, "0"),
          sigC,
        });
      } catch (_) {
        /* skip an icon that fails to load; matching just won't offer it */
      }
      done++;
      if (onProgress) onProgress(done, champions.length);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  iconHashes = { patch: PATCH, byId, items };
  try {
    localStorage.setItem(
      ICON_HASH_STORE,
      JSON.stringify({ v: ICON_HASH_VERSION, patch: PATCH, items }),
    );
  } catch (_) {}
  return iconHashes;
}

// ============================================================================
// The scan panel is docked inline inside #scan-results (above the pinned
// "Available now" results), NOT a modal — so the controls and the results are
// visible at the same time, and there is no full-screen overlay that closes over
// the grid (which used to let a stray click land on a champion card underneath).
// ============================================================================
let scanPanelOpen = false;

function scanHost() {
  return document.getElementById("scan-results");
}
function scanPanelEl() {
  return scanHost()?.querySelector(".scan-panel") || null;
}

// ---- stepped progress (so it's clear something is happening) ----
// Four honest stages the user can follow — the frame is theirs (they shared the
// window), so we don't "locate the window"; we find champion select inside it and
// read its two distinct parts (the available pool, and their team's locked picks).
const SCAN_STEP_LABELS = [
  "Prepare champion database",
  "Find champion select",
  "Read available champions",
  "Read your team's picks",
];
const STEP_DB = 0,
  STEP_FIND = 1,
  STEP_BENCH = 2,
  STEP_PICKS = 3;
// null = idle (steps hidden); otherwise one state per step:
// "pending" | "active" | "done" | "error".
let scanStepStates = null;

function scanBeginSteps() {
  scanStepStates = SCAN_STEP_LABELS.map(() => "pending");
  scanRenderSteps();
}
// Set step `i` to `state`; any earlier still-running steps are marked done.
// (One-shot path — a clean forward sequence.)
function scanStep(i, state) {
  if (!scanStepStates) scanStepStates = SCAN_STEP_LABELS.map(() => "pending");
  for (let k = 0; k < i; k++) {
    if (scanStepStates[k] === "pending" || scanStepStates[k] === "active")
      scanStepStates[k] = "done";
  }
  scanStepStates[i] = state;
  scanRenderSteps();
}
// Set the whole state vector at once (live path — steps reflect current progress
// each poll). Skips a re-render when nothing changed so the spinner doesn't reset.
function scanSetStepStates(states) {
  const key = states.join(",");
  if (scanStepStates && scanStepStates.join(",") === key) return;
  scanStepStates = states.slice();
  scanRenderSteps();
}
function scanRenderSteps() {
  const ol = scanPanelEl()?.querySelector(".scan-steps");
  if (!ol) return;
  if (!scanStepStates) {
    ol.hidden = true;
    ol.innerHTML = "";
    return;
  }
  ol.hidden = false;
  ol.innerHTML = scanStepStates
    .map(
      (st, i) =>
        `<li class="scan-step scan-step-${st}">` +
        `<span class="scan-step-mark"></span>` +
        `<span class="scan-step-label">${SCAN_STEP_LABELS[i]}</span></li>`,
    )
    .join("");
}
function scanSetStatus(msg, isErr) {
  const s = scanPanelEl()?.querySelector(".scan-status");
  if (!s) return;
  s.textContent = msg || "";
  s.classList.toggle("error", !!isErr);
}
// Yield to the browser so a just-set step state actually paints BEFORE we start
// the next blocking stage — otherwise all three steps flip at once at the very
// end (locate/read are heavy synchronous work that never lets the DOM repaint).
function nextPaint() {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
}

// ---- pipeline pieces (shared by the one-shot and live-auto paths) ----
// Ensure the champion hash DB is ready; returns false if it couldn't load.
async function ensureScanDb() {
  await ensureIconHashes((d, t) =>
    scanSetStatus(`Preparing champion database… ${d}/${t}`),
  );
  return !!(iconHashes && iconHashes.byId.size);
}
// Locate the champ-select layout in a frame (assumes the DB is ready).
function locateForScan(buf, w, h) {
  return locateLayout(buf, w, h, iconHashes.byId);
}
// (readBench / readPicks / combineReads are pure and live in scan-core.js so the
// Web Worker can share them; the main thread passes iconHashes.byId explicitly.)

// For the one-shot (single-frame) path there's no cross-frame consensus, so an
// uncertain id's "alternatives" are just the runner-up champions from the slot it
// matched. Returns { alternatives: Map(id -> [altId, ...]),
// scores: Map(id -> { self, alts:Map(altId->color) }) } — the same shape the live
// consensus produces, so renderScanResults can show match-distance confidence
// numbers either way. `color` is the icon-match distance (lower = closer).
function altsAndScoresFromReads(reads, uncertain) {
  const alternatives = new Map();
  const scores = new Map();
  if (!uncertain || !uncertain.size) return { alternatives, scores };
  for (const r of reads) {
    for (const pos of r.slots || r.circles || []) {
      const m = pos.m;
      if (!m || !uncertain.has(m.id) || alternatives.has(m.id)) continue;
      const altObjs = (m.alts || []).filter((a) => a.id !== m.id).slice(0, 3);
      if (!altObjs.length) continue;
      alternatives.set(
        m.id,
        altObjs.map((a) => a.id),
      );
      const altScore = new Map();
      for (const a of altObjs) if (a.color != null) altScore.set(a.id, a.color);
      scores.set(m.id, { self: m.color ?? null, alts: altScore });
    }
  }
  return { alternatives, scores };
}

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
  return {
    core,
    worker: core.replace(/scan-core\.js(\?.*)?$/, "scan-worker.js"),
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
      const boot = `importScripts(${JSON.stringify(
        urls.core,
      )}, ${JSON.stringify(urls.worker)});`;
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
function scanViaWorker(buf, w, h, cachedClient, tight) {
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
    scanWorker.postMessage(
      {
        type: "scan",
        id,
        buf,
        w,
        h,
        client: cachedClient || null,
        tight: !!tight,
      },
      [buf.buffer],
    );
  });
}

// Lazily-built main-thread ARAM pipeline — the fallback when a Web Worker isn't
// available (file://, blocked). Same stages the worker composes.
let scanMainPipeline = null;
function getScanPipeline() {
  if (!scanMainPipeline) scanMainPipeline = pipelineForMode("aram");
  return scanMainPipeline;
}

// Locate + read a frame through the modular pipeline, off-thread when possible.
// `cachedClient` short-circuits the locate stage on a pixel-stable live frame.
// Returns { layout(=client), ids, uncertain, picks, benchCount, filledSlots,
// benchSlots, pickCircles } or { layout:null }. (The field is named `layout` for
// back-compat with the live loop; it now carries the located ClientRect.)
async function scanFrameAsync(buf, w, h, cachedClient, tight) {
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
      const m = await scanViaWorker(buf, w, h, cachedClient, tight);
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
    tight: !!tight,
    client: cachedClient || null,
  };
  const r = runFrameRead(getScanPipeline(), frame, ctx);
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

// Run the whole pipeline on a loaded image element.
async function runScanFromImage(img) {
  const w = img.naturalWidth || img.width,
    h = img.naturalHeight || img.height;
  if (!w || !h) {
    scanSetStatus("That image looks empty.", true);
    return 0;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const buf = ctx.getImageData(0, 0, w, h).data;
  return runScanFromBuffer(buf, w, h);
}

// Run the pipeline on a raw RGBA buffer (a pasted image or a live capture frame)
// and pin the results. Reports progress through the stepped indicator + status
// line. Returns the number of champions found. The panel always stays open, so a
// live capture can read again as the bench fills over ~10s and gets swapped.
async function runScanFromBuffer(buf, w, h) {
  ensureScanPanel();
  scanBeginSteps();
  await nextPaint(); // paint the "all pending" checklist first

  // Finding champion select matches against champion icons, so the hash database
  // must be ready first.
  scanStep(STEP_DB, "active");
  scanSetStatus("Preparing champion database…");
  await nextPaint();
  if (!(await ensureScanDb())) {
    scanStep(STEP_DB, "error");
    scanSetStatus("Couldn't load champion icons (offline?).", true);
    return 0;
  }
  scanStep(STEP_DB, "done");

  // Find the champ-select layout anywhere in the frame (works on a full-desktop
  // print screen, at any scale) — bench bar + the reconstructed team-circle region.
  scanStep(STEP_FIND, "active");
  scanSetStatus("Finding champion select…");
  await nextPaint();
  const layout = locateForScan(buf, w, h);
  if (!layout) {
    scanStep(STEP_FIND, "error");
    scanSetStatus(
      "Couldn't find champion select. Make sure the top “Available Champions” bar is fully visible.",
      true,
    );
    return 0;
  }
  scanStep(STEP_FIND, "done");

  // Read the available-champion pool (bench squares).
  scanStep(STEP_BENCH, "active");
  scanSetStatus("Reading available champions…");
  await nextPaint();
  const bench = readBench(buf, w, h, layout, iconHashes.byId);
  scanStep(STEP_BENCH, "done");

  // Read your team's locked picks (the circles).
  scanStep(STEP_PICKS, "active");
  scanSetStatus("Reading your team's picks…");
  await nextPaint();
  const picks = readPicks(buf, w, h, layout, iconHashes.byId);

  const { ids, uncertain } = combineReads(bench, picks);
  if (!ids.length) {
    scanStep(STEP_PICKS, "error");
    scanSetStatus(
      "No champions recognized. Make sure champion select is on screen and the top row is visible.",
      true,
    );
    return 0;
  }
  scanStep(STEP_PICKS, "done");
  const { alternatives, scores } = altsAndScoresFromReads(
    [bench, picks],
    uncertain,
  );
  scanState = {
    ids,
    uncertain,
    alternatives,
    scores,
    active: true,
    finalized: true,
  };
  renderScanResults();
  const n = ids.length;
  // Same layout check the live loop uses. There's no state to step back to on a
  // single pasted image, so just say the read looks off — the champions are still
  // pinned, flagged, and the user can re-crop or paste a cleaner screenshot.
  const v = verifyLayout(bench.slots, picks.circles);
  scanSetStatus(
    `Found ${n} champion${n === 1 ? "" : "s"} — pinned below ↓` +
      (v.ok ? "" : ` (heads up: ${v.reason} — double-check these)`),
    !v.ok,
  );
  scanHost()
    ?.querySelector(".scan-pinned")
    ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return n;
}

// ---- the pinned "Available now" group (its own child of #scan-results) ----
function scanDoneCount() {
  const progress = getProgress();
  let done = 0;
  for (const id of scanState.ids) if (progress[id]) done++;
  return { done, total: scanState.ids.length };
}
function refreshScanCount() {
  const el = document.querySelector("#scan-results .scan-count");
  if (!el) return;
  const { done, total } = scanDoneCount();
  const missing = total - done;
  el.textContent = missing
    ? `${missing} still needed · ${done}/${total} done`
    : `all ${total} done ✓`;
  el.classList.toggle("complete", missing === 0);
}
function syncChampionCardState(champId, nowDone) {
  document
    .querySelectorAll(`.champion[data-champ-id="${champId}"]`)
    .forEach((el) => {
      el.classList.toggle("done", nowDone);
      el.setAttribute("aria-pressed", String(nowDone));
    });
}
function renderScanResults() {
  const host = document.getElementById("scan-results");
  if (!host) return;
  let pinned = host.querySelector(".scan-pinned");
  if (!scanState.active || !scanState.ids.length) {
    pinned?.remove();
    return;
  }
  if (!pinned) {
    pinned = document.createElement("div");
    pinned.className = "scan-pinned";
    host.appendChild(pinned); // always after the panel
  }
  pinned.innerHTML = "";

  const byId = new Map(champions.map((c) => [c.id, c]));

  const section = document.createElement("div");
  section.className = "scan-section";

  const header = document.createElement("div");
  header.className = "scan-header";
  const title = document.createElement("span");
  title.className = "scan-title";
  title.textContent = "📷 Available now";
  const count = document.createElement("span");
  count.className = "scan-count";
  header.appendChild(title);
  header.appendChild(count);

  const rescan = document.createElement("button");
  rescan.className = "scan-action";
  rescan.textContent = "Scan again";
  rescan.onclick = openScanPanel;
  header.appendChild(rescan);

  const clear = document.createElement("button");
  clear.className = "scan-action scan-clear";
  clear.textContent = "×";
  clear.title = "Dismiss";
  clear.onclick = () => {
    scanState = {
      ids: [],
      uncertain: new Set(),
      alternatives: new Map(),
      active: false,
    };
    renderScanResults();
  };
  header.appendChild(clear);
  section.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "champion-grid-region scan-grid";
  const alternatives = scanState.alternatives || new Map();
  scanState.ids.forEach((id) => {
    const champ = byId.get(id);
    if (!champ) return;
    const card = createChampionCard(champ);
    if (scanState.uncertain.has(id)) {
      card.classList.add("scan-uncertain");
      const alts = (alternatives.get(id) || [])
        .map((a) => byId.get(a)?.name)
        .filter(Boolean);
      card.title =
        (card.title ? card.title + " — " : "") +
        "uncertain match, verify" +
        (alts.length ? ` (or ${alts.join(", ")})` : "");
    }
    grid.appendChild(card);
  });
  section.appendChild(grid);

  // "Double-check" list: for every uncertain champion, show what else it might be
  // so the user can eyeball the alternatives instead of just trusting the pick.
  const uncertainWithAlts = scanState.ids.filter(
    (id) => scanState.uncertain.has(id) && (alternatives.get(id) || []).length,
  );
  if (uncertainWithAlts.length) {
    const note = document.createElement("div");
    note.className = "scan-uncertain-list";
    const h = document.createElement("div");
    h.className = "scan-uncertain-head";
    h.textContent = scanState.finalized
      ? "Double-check these — best guess vs. alternatives:"
      : "Still deciding — current best guess vs. alternatives:";
    note.appendChild(h);
    for (const id of uncertainWithAlts) {
      const champ = byId.get(id);
      if (!champ) continue;
      const rowScores = scanState.scores?.get(id);
      const row = document.createElement("div");
      row.className = "scan-uncertain-row";
      row.appendChild(scanMiniChip(champ, "best", rowScores?.self));
      const arrow = document.createElement("span");
      arrow.className = "scan-uncertain-or";
      arrow.textContent = "or";
      row.appendChild(arrow);
      const altWrap = document.createElement("div");
      altWrap.className = "scan-uncertain-alts";
      for (const altId of alternatives.get(id) || []) {
        const alt = byId.get(altId);
        if (alt)
          altWrap.appendChild(
            scanMiniChip(alt, "alt", rowScores?.alts?.get(altId)),
          );
      }
      row.appendChild(altWrap);
      note.appendChild(row);
    }
    section.appendChild(note);
  }

  pinned.appendChild(section);
  refreshScanCount();
}

// A small icon+name chip used in the "double-check" alternatives list. `kind` is
// "best" (the winning guess) or "alt" (a runner-up). Display-only (not clickable —
// the real toggle lives on the champion card above): it shows the match distance
// as a confidence number so the best guess and its alternatives can be compared.
// `score` is that distance (lower = closer icon match), or null if unavailable.
function scanMiniChip(champ, kind, score) {
  const chip = document.createElement("div");
  chip.className = "scan-chip scan-chip-" + kind;
  chip.title =
    kind === "best" ? `${champ.name} — best guess` : `Could be ${champ.name}`;
  const img = document.createElement("img");
  img.src = `${CHAMPION_ICON_BASE}${champ.image.full}`;
  img.alt = champ.name;
  const name = document.createElement("span");
  name.className = "scan-chip-name";
  name.textContent = champ.name;
  chip.appendChild(img);
  chip.appendChild(name);
  if (score != null && Number.isFinite(score)) {
    const conf = document.createElement("span");
    conf.className = "scan-chip-conf";
    conf.textContent = score.toFixed(1);
    conf.title = "match distance — lower means a closer icon match";
    chip.appendChild(conf);
  }
  return chip;
}

// ---- image sources: file picker, global paste, drag/drop ----
function firstImageFromItems(items) {
  for (const it of items || []) {
    if (it.kind === "file" && it.type.startsWith("image/"))
      return it.getAsFile();
  }
  return null;
}
async function handleScanFile(file) {
  ensureScanPanel();
  if (!file) {
    scanSetStatus("No image found — copy a screenshot first.", true);
    return;
  }
  if (!champions.length) {
    scanSetStatus(
      "Champion data is still loading — try again in a moment.",
      true,
    );
    return;
  }
  scanSetStatus("Reading screenshot…");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadCrossOriginImage(url);
    await runScanFromImage(img);
  } catch (_) {
    scanSetStatus("Couldn't read that image.", true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- live screen capture (getDisplayMedia): auto-read the League window ----
// Share the League window once and it auto-scans: it polls, retrying until it
// gets a complete read (bench + all 5 picks), pins that, and then stops scanning.
// After that it lightly watches for champion select to disappear and auto-drops
// the screen share when the game starts — so you never share during the game.
//
// With no LCU, the only "game started" signal is the pixels: champ select is no
// longer in the frame. That's reliable when you share the League WINDOW (it stays
// captured even when unfocused); when you share the whole SCREEN, "gone" is
// ambiguous with alt-tabbing, so there we also require a generous timer.
let liveStream = null;
let liveVideo = null; // frame source (kept live but hidden; the canvas is the preview)
let livePreview = null; // <canvas> showing the live frame + focus overlay
let liveFocus = null; // last read's boxes to stroke: { client, bench, circ }
let liveTimer = null; // the single pending poll/watch timeout
let liveTicker = null; // 250ms interval that renders the "next check in Ns" line
let liveState = "idle"; // idle | watching | reading | complete
let liveSurface = "monitor"; // "window" | "monitor" | "browser" (from the track)
let liveLayout = null; // cached champ-select layout — reused across polls (frame is
// pixel-stable), so we locate once and then do fast "tight" reads. Dropped whenever
// a read comes back empty (window moved / champ select gone) to force a re-locate.
let liveAgg = null; // temporal-consensus accumulator over the reading window (votes
// each slot across frames). Reset whenever champ select goes missing so a fresh
// lobby starts from a clean slate.
let liveFilledSlots = null; // bench slots that read as champions at the full read
let liveFullAt = 0; // when the full read landed (ms)
let liveGoneSince = 0; // when champ select first went missing (ms), 0 = present
let liveNextCheckAt = 0; // when the next check is scheduled (ms) — drives the countdown
let liveChecking = false; // true while a read is actually running (blocks the thread)

// ---- the live state machine ------------------------------------------------
// watching → reading → complete, plus an explicit way BACK. Going back is how the
// scanner recovers when it locked onto the wrong thing: re-entering an earlier
// state drops the caches the LATER states own, so the work is genuinely redone
// (back to "watching" drops the cached client rect, forcing a fresh full locate).
// Two things drive it: the automatic layout check (verifyLayout — a bench whose
// slots aren't all champions-or-empty means the window isn't where we think), and
// the user's "Start over" button when they can see it got something wrong.
const LIVE_FLOW = ["watching", "reading", "complete"];
let liveHistory = []; // states we came from, most recent last: [{ state, at, why }]
let liveBadStreak = 0; // consecutive frames whose layout failed verification
// Bumped on every state change. A poll captures it before its first await and
// bails if it changed while the read was in flight — otherwise a read that
// started before "Start over" would land afterwards and undo it, which is
// exactly why the button looked like it did nothing.
let liveEpoch = 0;
const LIVE_VERIFY_STRIKES = 2; // fail this many in a row before stepping back —
// a single frame grabbed mid-animation can fail the check honestly.

// Entry actions. Each state resets what the states AFTER it derived, so entering
// an earlier state really does discard the later work rather than just relabel it.
function liveEnter(state) {
  liveState = state;
  liveBadStreak = 0;
  liveEpoch++; // any read still in flight belongs to the old state — discard it
  if (state === "watching") {
    liveLayout = null; // no cached client rect → next poll does a full locate
    liveAgg = null;
    liveFocus = null;
    liveFilledSlots = null;
    liveGoneSince = 0;
    scanSetStepStates(["done", "active", "pending", "pending"]);
  } else if (state === "reading") {
    // A fresh consensus every time we (re-)enter reading — otherwise coming back
    // from "complete" would re-finalize instantly off the old stable window.
    liveAgg = createScanAggregator();
    liveFilledSlots = null;
    liveGoneSince = 0;
  }
}
// Move forward (or anywhere), remembering where we came from.
function liveSetState(next, why) {
  if (liveState === next) return;
  liveHistory.push({ state: liveState, at: Date.now(), why });
  if (liveHistory.length > 8) liveHistory.shift();
  liveEnter(next);
}
// Drop back to hunting for the window. Unlike liveSetState this re-runs the entry
// actions even when we're nominally already watching, so a rejected frame can't
// leave its cached rect or its focus overlay standing.
function liveRelocate(why) {
  if (liveState === "watching") liveEnter("watching");
  else liveSetState("watching", why);
}
// Step back one state and resume polling there. Repeated presses walk the ladder:
// complete → reading (re-read champion select) → watching (re-find the window).
function liveGoBack(why) {
  if (!liveVideo || liveState === "idle") return;
  const entry = liveHistory.pop();
  const prev =
    entry && entry.state !== "idle" && entry.state !== liveState
      ? entry.state
      : LIVE_FLOW[Math.max(0, LIVE_FLOW.indexOf(liveState) - 1)];
  liveEnter(prev);
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  liveChecking = false;
  scanSetStatus(
    prev === "watching"
      ? `Finding the League window again${why ? ` — ${why}` : ""}…`
      : `Reading champion select again${why ? ` — ${why}` : ""}…`,
  );
  scheduleNextCheck(prev === "complete" ? liveWatchTick : liveLoop, 150);
}

// Reads are cheap now (tight per-slot search, off-thread in a Web Worker), so we
// poll often and build a consensus from many frames rather than trusting one.
const LIVE_INTERVAL_MS = 600; // wait between reading-phase checks (shown as countdown)
const LIVE_WATCH_MS = 3000; // cheap "still in champ select?" re-check interval
const LIVE_WINDOW_GONE_MS = 8000; // window share: gone this long → game started
const LIVE_SCREEN_GONE_MS = 15000; // screen share: gone this long (alt-tab tolerant)
const LIVE_SCREEN_MAX_MS = 120000; // screen share: hard cap after a full read

function stopLiveCapture() {
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  if (liveTicker) {
    clearInterval(liveTicker);
    liveTicker = null;
  }
  liveState = "idle";
  liveHistory = [];
  liveBadStreak = 0;
  liveLayout = null;
  liveAgg = null;
  liveFilledSlots = null;
  liveGoneSince = 0;
  liveNextCheckAt = 0;
  liveChecking = false;
  if (liveStream) {
    liveStream.getTracks().forEach((t) => t.stop());
    liveStream = null;
  }
  if (liveVideo) {
    liveVideo.srcObject = null;
    liveVideo = null;
  }
  livePreview = null;
  liveGrabCanvas = null;
  liveFocus = null;
  // Nothing is running anymore — clear the checklist so its spinner stops turning.
  scanStepStates = null;
  scanRenderSteps();
}

// Draw the current live frame to a canvas → raw RGBA buffer, or null if not ready.
// The canvas is reused across polls: a fresh full-screen one every 600ms meant
// allocating (and then collecting) tens of MB of backing store on the main thread.
let liveGrabCanvas = null;
function grabLiveFrame() {
  if (!liveVideo || !liveVideo.videoWidth) return null;
  const w = liveVideo.videoWidth,
    h = liveVideo.videoHeight;
  if (!liveGrabCanvas) liveGrabCanvas = document.createElement("canvas");
  const canvas = liveGrabCanvas;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(liveVideo, 0, 0, w, h);
  return { buf: ctx.getImageData(0, 0, w, h).data, w, h };
}

async function startLiveCapture() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    scanSetStatus("Live capture isn’t supported in this browser.", true);
    return;
  }
  try {
    liveStream = await navigator.mediaDevices.getDisplayMedia({
      // A few fps so each fast poll (~600ms) grabs a genuinely fresh frame — the
      // consensus wants independent frames, not the same one re-read. Champ select
      // is near-static, so this stays cheap.
      video: { frameRate: 5 },
      audio: false,
    });
  } catch (err) {
    scanSetStatus(
      err && err.name === "NotAllowedError"
        ? "Screen share was cancelled."
        : "Couldn’t start screen capture.",
      true,
    );
    return;
  }
  const track = liveStream.getVideoTracks()[0];
  liveSurface =
    (track && track.getSettings && track.getSettings().displaySurface) ||
    "monitor";
  const video = document.createElement("video");
  video.className = "scan-live-video";
  video.muted = true;
  video.playsInline = true;
  video.srcObject = liveStream;
  await video.play().catch(() => {});
  liveVideo = video;
  // If the user stops sharing via the browser's own control, tear down cleanly.
  track?.addEventListener("ended", () => {
    stopLiveCapture();
    renderLiveControls(false);
    scanSetStatus("Screen sharing stopped.");
  });
  renderLiveControls(true);
  startLiveTicker();
  runLiveAuto();
}

// A light 250ms ticker that renders the cadence line: a countdown to the next
// check, or "Checking…" while one is running. (Replaces the old "Scan now" button
// — it shows WHEN the next automatic check happens instead of asking for a click.)
function startLiveTicker() {
  if (liveTicker) return;
  // ~4fps: matches the 5fps capture, so the canvas preview looks as smooth as the
  // raw video while letting us stroke the focus overlay on top of each frame.
  liveTicker = setInterval(() => {
    updateCadence();
    paintLivePreview();
  }, 250);
  updateCadence();
  paintLivePreview();
}

// Colors for the focus overlay, keyed by match verdict.
const FOCUS_COLORS = {
  accept: "#57e389",
  maybe: "#ffcf6b",
  reject: "rgba(255, 255, 255, 0.16)",
};
// Paint the current live frame into the preview canvas, then stroke what the
// scanner is focusing on: the located client rectangle (dashed) + every bench and
// team-circle box, colored by how confident the current match is. Everything is in
// captured-frame pixels and the canvas shares the frame's resolution, so the boxes
// line up with the video exactly (no letterbox math).
// The preview is never shown larger than a couple hundred CSS pixels, so backing
// it with a full 4K canvas (redrawn 4x/sec) was pure main-thread cost for pixels
// nobody sees. Cap the backing store and draw the overlay through a matching
// transform, so the boxes still line up and the picture looks identical.
const LIVE_PREVIEW_MAX_W = 900;
function paintLivePreview() {
  const cv = livePreview;
  if (!cv || !liveVideo || !liveVideo.videoWidth) return;
  const fw = liveVideo.videoWidth,
    fh = liveVideo.videoHeight;
  const sc = Math.min(1, LIVE_PREVIEW_MAX_W / fw); // frame px → canvas px
  const cw = Math.max(1, Math.round(fw * sc)),
    ch = Math.max(1, Math.round(fh * sc));
  if (cv.width !== cw) cv.width = cw;
  if (cv.height !== ch) cv.height = ch;
  const g = cv.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(liveVideo, 0, 0, cw, ch);
  const f = liveFocus;
  if (!f || !f.client) return;
  g.setTransform(sc, 0, 0, sc, 0, 0); // everything below is in FRAME pixels
  const lw = Math.max(1.5, fw / 600) / sc; // constant on-screen stroke weight
  // Located client area.
  g.lineWidth = lw;
  g.setLineDash([lw * 4, lw * 3]);
  g.strokeStyle = "rgba(200, 155, 60, 0.85)";
  g.strokeRect(f.client.x, f.client.y, f.client.w, f.client.h);
  g.setLineDash([]);
  // Per-spot boxes, colored by verdict (empty/reject slots stay faint).
  const stroke = (list) => {
    for (const p of list || []) {
      const s = p.spot;
      if (!s) continue;
      g.strokeStyle = FOCUS_COLORS[p.verdict] || FOCUS_COLORS.reject;
      g.lineWidth = p.verdict === "reject" ? lw : lw * 1.7;
      // A matched spot draws where the icon actually locked on (matchSlot/
      // matchCircle's winning crop); an empty/reject spot has no art to snap
      // to, so it stays on the clean grid cell.
      const pos =
        p.verdict !== "reject" && p.m && p.m.pos
          ? p.m.pos
          : { x0: s.cx - s.size / 2, y0: s.cy - s.size / 2, size: s.size };
      g.strokeRect(pos.x0, pos.y0, pos.size, pos.size);
    }
  };
  stroke(f.bench);
  stroke(f.circ);
}
function updateCadence() {
  const el = scanPanelEl()?.querySelector(".scan-live-next");
  if (!el) return;
  if (liveChecking || !liveNextCheckAt) {
    el.textContent = liveChecking ? "Checking…" : "";
    return;
  }
  const s = Math.max(0, Math.ceil((liveNextCheckAt - Date.now()) / 1000));
  el.textContent = s > 0 ? `Next check in ${s}s` : "Checking…";
}
// Schedule the next check `interval` ms out and reflect it in the countdown.
function scheduleNextCheck(fn, interval) {
  liveNextCheckAt = Date.now() + interval;
  liveTimer = setTimeout(fn, interval);
  updateCadence();
}

// Prepare the DB once, then start polling for champion select.
async function runLiveAuto() {
  ensureScanPanel();
  scanBeginSteps();
  await nextPaint();
  scanStep(STEP_DB, "active");
  scanSetStatus("Preparing champion database…");
  await nextPaint();
  if (!(await ensureScanDb())) {
    scanStep(STEP_DB, "error");
    scanSetStatus("Couldn't load champion icons (offline?).", true);
    return;
  }
  if (!liveVideo) return; // sharing was stopped while the DB loaded
  ensureScanWorker(); // warm the worker (seed hashes) before the first poll
  liveHistory = [];
  liveEnter("watching");
  scanSetStatus(
    "Watching for champion select… open your ARAM lobby and it’ll read automatically.",
  );
  liveLoop();
}

// One poll: grab a frame, read it, fold it into the running consensus, and show
// the current best guess. Advances the state machine; finalizes only once the
// consensus is STABLE (all 5 picks settled across several frames), never on a
// single frame — that's what makes a transient misread unable to win.
async function liveLoop() {
  if (!liveVideo || (liveState !== "watching" && liveState !== "reading"))
    return;
  const epoch = liveEpoch; // this poll belongs to the state we start in
  liveChecking = true;
  updateCadence();
  await nextPaint(); // let "Checking…" show before the read is dispatched
  if (epoch !== liveEpoch) return; // state changed under us — that poll owns it now
  const frame = grabLiveFrame();
  if (frame) {
    // Reuse the cached layout if we have one (fast tight reads); only pay for a
    // full locate when we don't. Runs in the Web Worker when available, so the UI
    // stays smooth during the first read and the watching-phase locates.
    const cached = !!liveLayout;
    const res = await scanFrameAsync(
      frame.buf,
      frame.w,
      frame.h,
      liveLayout,
      cached,
    );
    // Sharing may have been stopped, or the user may have pressed Start over,
    // while the read was in flight. Either way this result is stale — drop it
    // without touching the state or scheduling a follow-up poll.
    if (
      !liveVideo ||
      epoch !== liveEpoch ||
      (liveState !== "watching" && liveState !== "reading")
    ) {
      liveChecking = false;
      return;
    }
    if (!res.layout || (!res.ids.length && cached)) {
      // Nothing here — or a cached layout that stopped reading (window moved /
      // champ select ended). Going back to watching drops the cache + consensus.
      liveRelocate("champion select isn’t in the frame");
      scanSetStatus("Watching for champion select…");
    } else if (res.verify && !res.verify.ok) {
      // We found SOMETHING, but it doesn't hold together as an ARAM bench: every
      // slot should be a champion or an empty placeholder, left-packed. Usually
      // the League window isn't where we think it is (it moved under a cached
      // rect, or the locate stage latched onto other champion art on screen).
      // Don't let the frame vote, and step back to re-locate after a couple of
      // strikes — one bad frame can just be a mid-animation grab.
      liveBadStreak++;
      liveFocus = {
        client: res.layout,
        bench: res.benchSlots,
        circ: res.pickCircles,
      };
      paintLivePreview();
      if (liveBadStreak >= LIVE_VERIFY_STRIKES) {
        liveRelocate(res.verify.reason);
        scanSetStatus(
          `That doesn’t look like champion select (${res.verify.reason}) — finding the League window again…`,
        );
      } else {
        scanSetStatus(`Checking the window is right (${res.verify.reason})…`);
      }
    } else {
      liveBadStreak = 0;
      liveSetState("reading", "champion select found");
      if (res.ids.length) liveLayout = res.layout; // cache a layout that reads
      // Update the live focus overlay from this frame's located area + boxes.
      liveFocus = {
        client: res.layout,
        bench: res.benchSlots,
        circ: res.pickCircles,
      };
      paintLivePreview();
      // Fold this frame's per-position matches into the consensus, then read the
      // current aggregate — that (not the single frame) drives the UI.
      if (!liveAgg) liveAgg = createScanAggregator();
      aggregateFrame(liveAgg, res.benchSlots, res.pickCircles);
      const agg = aggregateResult(liveAgg);
      scanSetStepStates([
        "done",
        "done",
        agg.ids.length ? "done" : "active",
        agg.picksFilled >= 5 ? "done" : "active",
      ]);
      if (agg.ids.length) {
        // Show the running prediction every poll, uncertain ones flagged with the
        // alternatives they're being weighed against.
        scanState = {
          ids: agg.ids,
          uncertain: agg.uncertain,
          alternatives: agg.alternatives,
          confidence: agg.confidence,
          scores: agg.scores,
          active: true,
          finalized: agg.stable,
        };
        renderScanResults();
        if (agg.stable) {
          // Consensus locked — pin it, stop scanning, watch for game start.
          liveSetState("complete", "consensus stable");
          liveFilledSlots = res.filledSlots;
          liveFullAt = Date.now();
          liveGoneSince = 0;
          liveChecking = false;
          const scope =
            liveSurface === "window" ? "the League window" : "your screen";
          const nMaybe = agg.uncertain.size;
          scanSetStatus(
            `Champion select read ✓ — ${agg.ids.length} champions pinned below` +
              (nMaybe ? `, ${nMaybe} to double-check` : "") +
              `. Waiting for the game to start, then I’ll stop sharing ${scope}.`,
          );
          scheduleNextCheck(liveWatchTick, LIVE_WATCH_MS);
          return;
        }
        scanSetStatus(
          agg.picksFilled >= 5
            ? `All 5 picks in — confirming the read…`
            : `Reading champion select… ${agg.picksFilled}/5 picks locked, ` +
                `${agg.ids.length} champions so far.`,
        );
      } else {
        scanSetStatus("Champion select found — waiting for picks to lock in…");
      }
    }
  }
  liveChecking = false;
  scheduleNextCheck(liveLoop, LIVE_INTERVAL_MS);
}

// Cheap "is champion select still on screen?" — re-check only the bench slots
// that were filled at the full read, instead of a full re-locate every tick.
function liveStillPresent(buf, w, h) {
  const slots = (liveFilledSlots || []).slice(0, 6);
  let hits = 0;
  for (const slot of slots) {
    const m = matchSlot(buf, w, h, slot, iconHashes.byId, { tight: true });
    if (m && classifyMatch(m) !== "reject") hits++;
    if (hits >= 2) return true;
  }
  return false;
}

// After a full read: watch for champion select to vanish, then drop the share.
async function liveWatchTick() {
  if (!liveVideo || liveState !== "complete") return;
  const epoch = liveEpoch;
  liveChecking = true;
  updateCadence();
  await nextPaint();
  if (!liveVideo || epoch !== liveEpoch || liveState !== "complete") return;
  const frame = grabLiveFrame();
  const present = frame ? liveStillPresent(frame.buf, frame.w, frame.h) : false;
  const now = Date.now();
  if (present) liveGoneSince = 0;
  else if (!liveGoneSince) liveGoneSince = now;

  const goneFor = liveGoneSince ? now - liveGoneSince : 0;
  const elapsed = now - liveFullAt;
  const stop =
    liveSurface === "window"
      ? goneFor >= LIVE_WINDOW_GONE_MS
      : goneFor >= LIVE_SCREEN_GONE_MS || elapsed >= LIVE_SCREEN_MAX_MS;

  if (stop) {
    const scope =
      liveSurface === "window" ? "the League window" : "your screen";
    stopLiveCapture();
    renderLiveControls(false);
    scanSetStatus(
      `Game started — stopped sharing ${scope}. Your champions are still pinned below.`,
    );
    return;
  }
  liveChecking = false;
  scheduleNextCheck(liveWatchTick, LIVE_WATCH_MS);
}

// (Re)build the live-capture controls inside the panel's .scan-live slot.
function renderLiveControls(active) {
  const wrap = scanPanelEl()?.querySelector(".scan-live");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (active && liveVideo) {
    // The <video> is only a frame source now; the canvas is the visible preview
    // (so we can stroke the focus overlay on top with exact pixel alignment).
    liveVideo.className = "scan-live-source";
    const stage = document.createElement("div");
    stage.className = "scan-live-stage";
    const preview = document.createElement("canvas");
    preview.className = "scan-live-canvas";
    stage.appendChild(liveVideo);
    stage.appendChild(preview);
    livePreview = preview;
    wrap.appendChild(stage);
    paintLivePreview();
    // Cadence line where the old "Scan now" button was: shows when the next
    // automatic check runs, so it's clear the scanner is working on its own.
    const next = document.createElement("span");
    next.className = "scan-live-next";
    // Manual counterpart to the automatic layout check: if you can see it read
    // the wrong thing, walk the state machine back a step. Press again to go
    // further back (re-read champion select → re-find the League window).
    const back = document.createElement("button");
    back.className = "scan-action scan-live-back";
    back.textContent = "↩ Start over";
    back.title =
      "Go back a step: re-read champion select, or (again) re-find the League window";
    back.onclick = () => liveGoBack("you asked to start over");
    const stop = document.createElement("button");
    stop.className = "scan-action";
    stop.textContent = "Stop sharing";
    stop.onclick = () => {
      stopLiveCapture();
      renderLiveControls(false);
      scanSetStatus("Screen sharing stopped.");
    };
    const row = document.createElement("div");
    row.className = "scan-live-row";
    row.appendChild(next);
    row.appendChild(back);
    row.appendChild(stop);
    wrap.appendChild(row);
    updateCadence();
  } else {
    const start = document.createElement("button");
    start.className = "scan-live-start";
    start.textContent = "📹 Read live from your screen";
    start.onclick = startLiveCapture;
    wrap.appendChild(start);
  }
}

// ---- the inline panel itself ----
// Build the panel once (stable child slots: .scan-live, .scan-sources,
// .scan-steps, .scan-status) so the live <video> and progress survive re-renders.
function ensureScanPanel() {
  const host = scanHost();
  if (!host) return null;
  let panel = host.querySelector(".scan-panel");
  if (panel) return panel;
  scanPanelOpen = true;
  panel = document.createElement("div");
  panel.className = "scan-panel";
  panel.innerHTML =
    `<div class="scan-panel-head">` +
    `<span class="scan-panel-title">📷 Scan champion select</span>` +
    `<button class="scan-panel-close" title="Hide scanner">×</button>` +
    `</div>` +
    `<p class="scan-panel-hint">Read live from your screen (no install — share the ` +
    `League window once and it reads champion select automatically, then stops ` +
    `sharing when the game starts), or paste a screenshot with ` +
    `<kbd>Ctrl</kbd>+<kbd>V</kbd>, drop an image, or choose a file.</p>` +
    `<div class="scan-live"></div>` +
    `<div class="scan-sources"></div>` +
    `<ol class="scan-steps" hidden></ol>` +
    `<div class="scan-status" role="status"></div>`;
  // Insert before the pinned results so the panel is always on top.
  host.insertBefore(panel, host.querySelector(".scan-pinned"));

  panel.querySelector(".scan-panel-close").onclick = closeScanPanel;

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.className = "scan-file";
  input.onchange = () => handleScanFile(input.files[0]);
  panel.querySelector(".scan-sources").appendChild(input);

  panel.addEventListener("dragover", (e) => {
    e.preventDefault();
    panel.classList.add("dragover");
  });
  panel.addEventListener("dragleave", () => panel.classList.remove("dragover"));
  panel.addEventListener("drop", (e) => {
    e.preventDefault();
    panel.classList.remove("dragover");
    handleScanFile(e.dataTransfer.files[0]);
  });

  renderLiveControls(false);
  return panel;
}

function openScanPanel() {
  ensureScanPanel();
  scanHost()?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closeScanPanel() {
  scanPanelOpen = false;
  stopLiveCapture();
  scanStepStates = null;
  scanPanelEl()?.remove();
}

// Back-compat aliases: the settings 📷 button and older callers used these names.
function openScanOverlay() {
  openScanPanel();
}
function closeScanOverlay() {
  closeScanPanel();
}

// Global paste: if the clipboard holds an image, reveal the panel and scan it.
document.addEventListener("paste", (e) => {
  const file = firstImageFromItems(e.clipboardData && e.clipboardData.items);
  if (!file) return;
  e.preventDefault();
  openScanPanel();
  handleScanFile(file);
});
