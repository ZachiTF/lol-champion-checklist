// Screenshot scan — UI glue: overlay, paste/drop handling, icon-hash building,
// and the pinned "Available now" group. Pure pipeline math lives in scan-core.js.

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
let scanState = { ids: [], uncertain: new Set(), active: false };

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
async function ensureIconHashes(onProgress) {
  if (iconHashes && iconHashes.patch === PATCH) return iconHashes;
  try {
    const raw = JSON.parse(localStorage.getItem(ICON_HASH_STORE) || "null");
    if (raw && raw.patch === PATCH && Array.isArray(raw.items)) {
      const byId = new Map(
        raw.items.map((it) => [it.id, { h: BigInt("0x" + it.h), sig: it.sig }]),
      );
      iconHashes = { patch: PATCH, byId };
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
        const img = await loadCrossOriginImage(CHAMPION_ICON_BASE + champ.image.full);
        const w = img.naturalWidth, h = img.naturalHeight;
        canvas.width = w; canvas.height = h;
        ctx.drawImage(img, 0, 0);
        const buf = ctx.getImageData(0, 0, w, h).data;
        const hash = dHashRegion(buf, w, h, 0, 0, w, h);
        const t = Math.round(w * 0.04);
        const sig = colorSigRegion(buf, w, h, t, t, w - 2 * t, h - 2 * t);
        byId.set(champ.id, { h: hash, sig });
        items.push({ id: champ.id, h: hash.toString(16).padStart(16, "0"), sig });
      } catch (_) {
        /* skip an icon that fails to load; matching just won't offer it */
      }
      done++;
      if (onProgress) onProgress(done, champions.length);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  iconHashes = { patch: PATCH, byId };
  try {
    localStorage.setItem(ICON_HASH_STORE, JSON.stringify({ patch: PATCH, items }));
  } catch (_) {}
  return iconHashes;
}

// Run the whole pipeline on a loaded image element.
async function runScanFromImage(img, setStatus) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) { setStatus("That image looks empty.", true); return; }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const buf = ctx.getImageData(0, 0, w, h).data;

  const bench = detectBenchRow(buf, w, h);
  if (!bench) {
    setStatus("Couldn't find the champion row. Make sure the top “Available Champions” bar is fully visible in the screenshot.", true);
    return;
  }

  setStatus("Preparing champion database…");
  await ensureIconHashes((d, t) => setStatus(`Preparing champion database… ${d}/${t}`));
  if (!iconHashes.byId.size) { setStatus("Couldn't load champion icons (offline?).", true); return; }

  setStatus("Identifying champions…");
  const ids = [];
  const uncertain = new Set();
  for (const slot of bench.slots) {
    const m = matchSlot(buf, w, h, slot, iconHashes.byId);
    const verdict = classifyMatch(m); // "accept" | "maybe" | "reject"
    if (verdict === "reject") continue; // empty slot / no real champion
    if (ids.includes(m.id)) continue; // de-dup (bench champions are distinct)
    ids.push(m.id);
    if (verdict === "maybe") uncertain.add(m.id);
  }

  if (!ids.length) {
    setStatus("No champions recognized. Try a sharper, unscaled screenshot of the champion-select screen.", true);
    return;
  }
  scanState = { ids, uncertain, active: true };
  closeScanOverlay();
  renderScanResults();
  document.getElementById("scan-results")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---- the pinned "Available now" group above the grid ----
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
  el.textContent = missing ? `${missing} still needed · ${done}/${total} done` : `all ${total} done ✓`;
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
  host.innerHTML = "";
  if (!scanState.active || !scanState.ids.length) return;

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
  rescan.onclick = openScanOverlay;
  header.appendChild(rescan);

  const clear = document.createElement("button");
  clear.className = "scan-action scan-clear";
  clear.textContent = "×";
  clear.title = "Dismiss";
  clear.onclick = () => {
    scanState = { ids: [], uncertain: new Set(), active: false };
    renderScanResults();
  };
  header.appendChild(clear);
  section.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "champion-grid-region scan-grid";
  scanState.ids.forEach((id) => {
    const champ = byId.get(id);
    if (!champ) return;
    const card = createChampionCard(champ);
    if (scanState.uncertain.has(id)) {
      card.classList.add("scan-uncertain");
      card.title = (card.title ? card.title + " — " : "") + "uncertain match, verify";
    }
    grid.appendChild(card);
  });
  section.appendChild(grid);
  host.appendChild(section);
  refreshScanCount();
}

// ---- overlay (button path) + global paste / drag-drop ----
function firstImageFromItems(items) {
  for (const it of items || []) {
    if (it.kind === "file" && it.type.startsWith("image/")) return it.getAsFile();
  }
  return null;
}
async function handleScanFile(file, setStatus) {
  if (!file) { setStatus("No image found — copy a screenshot first.", true); return; }
  if (!champions.length) { setStatus("Champion data is still loading — try again in a moment.", true); return; }
  setStatus("Reading screenshot…");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadCrossOriginImage(url);
    await runScanFromImage(img, setStatus);
  } catch (_) {
    setStatus("Couldn't read that image.", true);
  } finally {
    URL.revokeObjectURL(url);
  }
}
function openScanOverlay() {
  if (document.getElementById("scan-overlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "scan-overlay";
  overlay.className = "scan-overlay";

  const box = document.createElement("div");
  box.className = "scan-overlay-box";
  box.tabIndex = 0;
  box.innerHTML = `
    <h3>Scan a champion-select screenshot</h3>
    <p>Take a screenshot of the ARAM lobby (the top <strong>Available Champions</strong> bar visible), then <strong>paste it here with Ctrl+V</strong> — or drop / choose a file below.</p>
    <div class="scan-status" role="status"></div>`;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.className = "scan-file";
  const setStatus = (msg, isErr) => {
    const s = box.querySelector(".scan-status");
    if (s) { s.textContent = msg; s.classList.toggle("error", !!isErr); }
  };
  input.onchange = () => handleScanFile(input.files[0], setStatus);
  box.appendChild(input);

  const close = document.createElement("button");
  close.className = "scan-overlay-close";
  close.textContent = "×";
  close.onclick = closeScanOverlay;
  box.appendChild(close);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeScanOverlay(); });
  overlay.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("dragover"); });
  overlay.addEventListener("dragleave", () => box.classList.remove("dragover"));
  overlay.addEventListener("drop", (e) => {
    e.preventDefault(); box.classList.remove("dragover");
    handleScanFile(e.dataTransfer.files[0], setStatus);
  });
  document.body.appendChild(overlay);
  box.focus();
}
function closeScanOverlay() {
  document.getElementById("scan-overlay")?.remove();
}

// Global paste: if the clipboard holds an image, scan it. When the overlay is
// open, report status there; otherwise open the overlay to show progress.
document.addEventListener("paste", (e) => {
  const file = firstImageFromItems(e.clipboardData && e.clipboardData.items);
  if (!file) return;
  e.preventDefault();
  if (!document.getElementById("scan-overlay")) openScanOverlay();
  const setStatus = (msg, isErr) => {
    const s = document.querySelector("#scan-overlay .scan-status");
    if (s) { s.textContent = msg; s.classList.toggle("error", !!isErr); }
  };
  handleScanFile(file, setStatus);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeScanOverlay();
});
