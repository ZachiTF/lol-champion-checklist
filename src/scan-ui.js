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
// matched. Returns Map(id -> [altId, ...]) for the uncertain ids only.
function altsFromReads(reads, uncertain) {
  const out = new Map();
  if (!uncertain || !uncertain.size) return out;
  for (const r of reads) {
    for (const pos of r.slots || r.circles || []) {
      const m = pos.m;
      if (!m || !uncertain.has(m.id) || out.has(m.id)) continue;
      const alts = (m.alts || [])
        .map((a) => a.id)
        .filter((id) => id !== m.id)
        .slice(0, 3);
      if (alts.length) out.set(m.id, alts);
    }
  }
  return out;
}

// ---- Web Worker: run locate + read off the main thread (live loop) ----
// Keeps the UI (preview, countdown, spinner) fluid while a scan runs. Falls back
// to running the same functions inline when a worker can't be created — notably a
// page opened from a file:// path, where workers are blocked.
let scanWorker = null;
let scanWorkerReady = false;
let scanWorkerDisabled = false;
let scanWorkerReadyPromise = null;
let scanReqId = 1;
const scanReqPending = new Map(); // id -> resolve

function ensureScanWorker() {
  if (scanWorker || scanWorkerDisabled) return scanWorker;
  if (typeof Worker === "undefined" || !iconHashes || !iconHashes.items)
    return null;
  try {
    scanWorker = new Worker("src/scan-worker.js");
  } catch (_) {
    scanWorkerDisabled = true; // file:// or blocked — never retry
    return null;
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
  if (disable) scanWorkerDisabled = true; // worker errored — stay on the main thread
  scanReqPending.forEach((resolve) => resolve(null));
  scanReqPending.clear();
}

// Run one frame through the worker; resolves the worker's message (or null on
// timeout/failure so the caller can fall back). The buffer is cloned (not
// transferred) so a fallback can still use it if the worker doesn't answer.
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
    setTimeout(() => {
      if (scanReqPending.delete(id)) finish(null); // worker hung — fall back
    }, 4000);
    scanWorker.postMessage({
      type: "scan",
      id,
      buf,
      w,
      h,
      client: cachedClient || null,
      tight: !!tight,
    });
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
      await Promise.race([
        scanWorkerReadyPromise,
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }
    if (scanWorkerReady) {
      const m = await scanViaWorker(buf, w, h, cachedClient, tight);
      if (m) {
        if (!m.client) return { layout: null };
        return {
          layout: m.client,
          ids: m.ids,
          uncertain: new Set(m.uncertainIds),
          picks: m.picks,
          benchCount: m.benchCount,
          filledSlots: m.filledSlots,
          benchSlots: m.benchSlots,
          pickCircles: m.pickCircles,
        };
      }
      // worker failed/timed out — fall through to the main thread (buf is intact)
    }
  }
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
  scanState = {
    ids,
    uncertain,
    alternatives: altsFromReads([bench, picks], uncertain),
    active: true,
    finalized: true,
  };
  renderScanResults();
  const n = ids.length;
  scanSetStatus(`Found ${n} champion${n === 1 ? "" : "s"} — pinned below ↓`);
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
      const row = document.createElement("div");
      row.className = "scan-uncertain-row";
      row.appendChild(scanMiniChip(champ, "best"));
      const arrow = document.createElement("span");
      arrow.className = "scan-uncertain-or";
      arrow.textContent = "or";
      row.appendChild(arrow);
      const altWrap = document.createElement("div");
      altWrap.className = "scan-uncertain-alts";
      for (const altId of alternatives.get(id) || []) {
        const alt = byId.get(altId);
        if (alt) altWrap.appendChild(scanMiniChip(alt, "alt"));
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
// "best" (the winning guess) or "alt" (a runner-up). Clicking a chip toggles that
// champion done, just like a card — handy when the alternative is the real one.
function scanMiniChip(champ, kind) {
  const chip = document.createElement("button");
  chip.className = "scan-chip scan-chip-" + kind;
  chip.title =
    kind === "best" ? `${champ.name} (best guess)` : `Could be ${champ.name}`;
  const img = document.createElement("img");
  img.src = `${CHAMPION_ICON_BASE}${champ.image.full}`;
  img.alt = champ.name;
  const name = document.createElement("span");
  name.textContent = champ.name;
  chip.appendChild(img);
  chip.appendChild(name);
  chip.onclick = () => {
    const nowDone = toggleChampionDone(champ.id);
    syncChampionCardState(champ.id, nowDone);
    saveState();
    updateProgressText();
    refreshFilterCounts();
    refreshScanCount();
    renderHistory();
    chip.classList.toggle("done", nowDone);
  };
  if (getProgress()[champ.id]) chip.classList.add("done");
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
let liveVideo = null;
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
  // Nothing is running anymore — clear the checklist so its spinner stops turning.
  scanStepStates = null;
  scanRenderSteps();
}

// Draw the current live frame to a canvas → raw RGBA buffer, or null if not ready.
function grabLiveFrame() {
  if (!liveVideo || !liveVideo.videoWidth) return null;
  const w = liveVideo.videoWidth,
    h = liveVideo.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
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
  liveTicker = setInterval(updateCadence, 250);
  updateCadence();
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
  scanSetStepStates(["done", "active", "pending", "pending"]);
  liveState = "watching";
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
  liveChecking = true;
  updateCadence();
  await nextPaint(); // let "Checking…" show before the blocking read
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
    // Sharing may have been stopped during the await — bail if so.
    if (!liveVideo || (liveState !== "watching" && liveState !== "reading")) {
      liveChecking = false;
      return;
    }
    if (!res.layout || (!res.ids.length && cached)) {
      // Nothing here — or a cached layout that stopped reading (window moved /
      // champ select ended). Drop the cache + consensus and go back to watching.
      liveLayout = null;
      liveAgg = null;
      liveState = "watching";
      scanSetStepStates(["done", "active", "pending", "pending"]);
      scanSetStatus("Watching for champion select…");
    } else {
      liveState = "reading";
      if (res.ids.length) liveLayout = res.layout; // cache a layout that reads
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
          active: true,
          finalized: agg.stable,
        };
        renderScanResults();
        if (agg.stable) {
          // Consensus locked — pin it, stop scanning, watch for game start.
          liveFilledSlots = res.filledSlots;
          liveFullAt = Date.now();
          liveGoneSince = 0;
          liveState = "complete";
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
  liveChecking = true;
  updateCadence();
  await nextPaint();
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
    wrap.appendChild(liveVideo);
    // Cadence line where the old "Scan now" button was: shows when the next
    // automatic check runs, so it's clear the scanner is working on its own.
    const next = document.createElement("span");
    next.className = "scan-live-next";
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
