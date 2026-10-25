// Screenshot scan — UI glue: the inline scan panel, the progress checklist,
// icon-hash building, the one-shot (pasted/dropped image) read, and the reader
// switch. Siblings: scan-runner.js (worker / pipeline call), scan-results.js
// (the pinned "Available now" group), scan-live.js (screen capture). Pure
// pipeline math lives in scan-core.js / scan-aram.js.

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

// ---- which reader is in charge --------------------------------------------
// "aram" is the default: the hardcoded ARAM: Mayhem layout (src/scan-aram.js).
// It assumes the screen is ARAM champion select, works out where the client
// rectangle is, and then reads 15 exact positions. That is the right bet — it
// is what the tool is used for essentially every time — and it is both faster
// and far harder to fool than searching for the bench.
//
// "aram-adaptive" is the original pipeline, which hunts for the bench by
// champion content at any scale and position. Slower and easier to mislead, but
// it copes with captures the template cannot pin down — a screenshot cropped so
// tightly that the client's own edges aren't in frame, most of all. The UI
// keeps it one click away while a scan is running.
const SCAN_READERS = [
  {
    id: "aram",
    label: "ARAM layout",
    hint: "Assumes ARAM: Mayhem champion select and reads the known icon positions.",
  },
  {
    id: "aram-adaptive",
    label: "Search for the bench",
    hint: "Slower fallback: finds the champion bench anywhere in the picture. Try this if the ARAM layout can't find champion select — for example on a tightly cropped screenshot.",
  },
];
let scanReader = "aram";
function scanReaderInfo(id) {
  return (
    SCAN_READERS.find((r) => r.id === (id || scanReader)) || SCAN_READERS[0]
  );
}

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
// One hash per CHAMPION, from the modern icon: `champions` is the folded list
// (see foldClassicChampions), so Classic-mode art never enters the candidate set.
// That's deliberate — champion select shows the modern icons, and hashing the
// classic art too was measured to only cost accuracy: with those 60 extra
// candidates in the map, an upscaled capture of the test fixture started reading
// Elise as Dr. Mundo's classic art. If the old icons ever do turn up in champ
// select, hash `champ.classic.image.full` as its own entry and map the id back
// through the folder's aliases before the read is used.
const ICON_HASH_VERSION = 3; // bump when the stored hash set changes (v3: drops caches built while the Classic duplicates counted as champions)

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
// (The pipeline stages are pure and live in scan-core.js / scan-aram.js so the
// Web Worker can share them; the main thread passes iconHashes.byId explicitly.)

// For the one-shot (single-frame) path there's no cross-frame consensus, so an
// uncertain id's "alternatives" are just the runner-up champions from the slot it
// matched. Returns { alternatives: Map(id -> [altId, ...]),
// scores: Map(id -> { self, alts:Map(altId->color) }) } — the same shape the live
// consensus produces, so renderScanResults can show match-distance confidence
// numbers either way. `color` is the icon-match distance (lower = closer).
function altsAndScoresFromPositions(positionLists, uncertain) {
  const alternatives = new Map();
  const scores = new Map();
  if (!uncertain || !uncertain.size) return { alternatives, scores };
  for (const list of positionLists) {
    for (const pos of list || []) {
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

// The last still image scanned, so switching reader can re-run without asking
// for the screenshot again. Cleared when a live capture takes over.
let lastScanImage = null;

// Run the pipeline on a raw RGBA buffer (a pasted image or a live capture frame)
// and pin the results. Reports progress through the stepped indicator + status
// line. Returns the number of champions found. The panel always stays open, so a
// live capture can read again as the bench fills over ~10s and gets swapped.
async function runScanFromBuffer(buf, w, h) {
  ensureScanPanel();
  // Keep a copy: scanFrameAsync TRANSFERS the buffer to the worker, which
  // detaches it, and the reader switch needs to read the same picture again.
  lastScanImage = { buf: new Uint8ClampedArray(buf), w, h };
  scanBeginSteps();
  await nextPaint(); // paint the "all pending" checklist first

  // Matching runs against champion icons, so the hash database must be ready.
  scanStep(STEP_DB, "active");
  scanSetStatus("Preparing champion database…");
  await nextPaint();
  if (!(await ensureScanDb())) {
    scanStep(STEP_DB, "error");
    scanSetStatus("Couldn't load champion icons (offline?).", true);
    return 0;
  }
  scanStep(STEP_DB, "done");

  // One pass of the selected reader: locate champion select, then read the
  // bench and your team's picks. Same code path the live loop uses, so the two
  // can never drift apart.
  scanStep(STEP_FIND, "active");
  scanSetStatus(`Finding champion select (${scanReaderInfo().label})…`);
  await nextPaint();
  const res = await scanFrameAsync(buf, w, h, {});
  if (!res.layout) {
    scanStep(STEP_FIND, "error");
    scanSetStatus(scanNotFoundMessage(), true);
    renderReaderSwitch();
    return 0;
  }
  // One pipeline call covers both reads, so they land together.
  scanStep(STEP_BENCH, "done");

  const { ids, uncertain } = res;
  if (!ids.length) {
    scanStep(STEP_PICKS, "error");
    scanSetStatus(
      "No champions recognized. Make sure champion select is on screen and the top row is visible.",
      true,
    );
    renderReaderSwitch();
    return 0;
  }
  scanStep(STEP_PICKS, "done");
  const { alternatives, scores } = altsAndScoresFromPositions(
    [res.benchSlots, res.pickCircles],
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
  // pinned, flagged, and the user can switch reader or paste a cleaner shot.
  const v = res.verify;
  scanSetStatus(
    `Found ${n} champion${n === 1 ? "" : "s"} — pinned below ↓` +
      (!v || v.ok ? "" : ` (heads up: ${v.reason} — double-check these)`),
    !!(v && !v.ok),
  );
  renderReaderSwitch();
  scanHost()
    ?.querySelector(".scan-pinned")
    ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return n;
}

// What to say when the current reader couldn't find champion select — including
// the nudge towards the other one, since that is the actual fix most of the time.
function scanNotFoundMessage() {
  const other = SCAN_READERS.find((r) => r.id !== scanReader);
  return (
    `Couldn't find champion select with the ${
      scanReaderInfo().label
    } reader. ` +
    (scanReader === "aram"
      ? "Make sure the whole League window is in the picture"
      : "Make sure the top “Available Champions” bar is fully visible") +
    (other ? ` — or try “${other.label}”.` : ".")
  );
}

// Re-run the last still image with whichever reader is selected now.
async function rescanLastImage() {
  if (!lastScanImage) return;
  const { buf, w, h } = lastScanImage;
  await runScanFromBuffer(new Uint8ClampedArray(buf), w, h);
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
    `League window once and it reads every champion select automatically, game ` +
    `after game), or paste a screenshot with ` +
    `<kbd>Ctrl</kbd>+<kbd>V</kbd>, drop an image, or choose a file.</p>` +
    `<div class="scan-live"></div>` +
    `<div class="scan-sources"></div>` +
    `<ol class="scan-steps" hidden></ol>` +
    `<div class="scan-status" role="status"></div>` +
    `<div class="scan-reader"></div>`;
  // Insert before the pinned results so the panel is always on top.
  host.insertBefore(panel, host.querySelector(".scan-pinned"));

  panel.querySelector(".scan-panel-close").onclick = closeScanPanel;
  renderReaderSwitch();

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
  syncLiveLaunch();
  return panel;
}

// ---- the reader switch ("this isn't working, try the other tool") ----------
// Always visible in the panel, including mid-scan: if you can SEE the overlay
// boxes landing in the wrong place, the fix is one click away rather than a
// re-paste. Switching restarts whatever is currently running — a live capture
// goes back to hunting for champion select with the new reader, a pasted
// screenshot is simply read again.
function renderReaderSwitch() {
  const wrap = scanPanelEl()?.querySelector(".scan-reader");
  if (!wrap) return;
  wrap.innerHTML = "";
  const label = document.createElement("span");
  label.className = "scan-reader-label";
  label.textContent = "Reading as:";
  wrap.appendChild(label);
  for (const reader of SCAN_READERS) {
    const b = document.createElement("button");
    b.className = "scan-reader-option";
    b.classList.toggle("active", reader.id === scanReader);
    b.textContent = reader.label;
    b.title = reader.hint;
    b.setAttribute("aria-pressed", String(reader.id === scanReader));
    b.onclick = () => setScanReader(reader.id);
    wrap.appendChild(b);
  }
  const hint = document.createElement("span");
  hint.className = "scan-reader-hint";
  hint.textContent = scanReaderInfo().hint;
  wrap.appendChild(hint);
}

function setScanReader(id) {
  if (id === scanReader || !SCAN_READERS.some((r) => r.id === id)) return;
  scanReader = id;
  renderReaderSwitch();
  if (liveIsSharing()) {
    liveReaderChanged();
  } else if (lastScanImage) {
    rescanLastImage();
  }
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
  syncLiveLaunch();
}

// The always-visible "read live" button above the results: live reading is the
// scanner's main use, so it shouldn't sit behind settings → 📷 → panel. One click
// opens the panel AND asks for the share — startLiveCapture's getDisplayMedia
// runs inside this click, which is the user gesture the browser requires. Hidden
// while the panel is open (the panel has its own controls).
function syncLiveLaunch() {
  const btn = document.getElementById("live-launch");
  if (btn) btn.hidden = !!scanPanelEl();
}
(function initLiveLaunch() {
  const btn = document.getElementById("live-launch");
  if (!btn) return;
  btn.onclick = () => {
    openScanPanel();
    if (!liveIsSharing()) startLiveCapture();
  };
})();

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
