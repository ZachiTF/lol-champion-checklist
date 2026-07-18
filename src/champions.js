// Champion domain: search/filter helpers, region crests, hover tooltip,
// voice-line playback, and the champion card component.

// Fuzzy name matching for the search box. Case and punctuation are ignored
// ("khazix" finds Kha'Zix, "miss fortune" finds MissFortune); when no
// substring matches, the query may also appear as a subsequence of the name
// ("mfort" finds Miss Fortune).
function normalizeSearchText(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fuzzyMatchesName(query, name) {
  const q = normalizeSearchText(query);
  if (!q) return true;
  const n = normalizeSearchText(name);
  if (n.includes(q)) return true;
  let matched = 0;
  for (const ch of n) {
    if (ch === q[matched]) matched++;
    if (matched === q.length) return true;
  }
  return false;
}

// Get which filters a champion belongs to
function getChampionFilters(champId, filterObject) {
  const filters = [];
  for (const [filterName, filterData] of Object.entries(filterObject)) {
    if (filterData.champions.includes(champId)) {
      filters.push(filterName);
    }
  }
  return filters;
}

// Official region crest icons served by Riot's Universe site.
// "iona" and "mt_targon" are the actual asset names on their CDN.
const REGION_CREST_SLUGS = {
  "Bandle City": "bandle_city",
  Bilgewater: "bilgewater",
  Demacia: "demacia",
  Freljord: "freljord",
  Ionia: "iona",
  Ixtal: "ixtal",
  Noxus: "noxus",
  Piltover: "piltover",
  "Shadow Isles": "shadow_isles",
  Shurima: "shurima",
  Targon: "mt_targon",
  Void: "void",
  Zaun: "zaun",
};

function regionCrestUrl(regionName) {
  const slug = REGION_CREST_SLUGS[regionName];
  return slug
    ? `https://universe.leagueoflegends.com/images/${slug}_crest_icon.png`
    : null;
}

function createRegionCrest(regionName, className) {
  const url = regionCrestUrl(regionName);
  if (!url) return null;
  const img = document.createElement("img");
  img.className = className;
  img.src = url;
  img.alt = "";
  img.onerror = () => img.remove();
  return img;
}

// --- CHAMPION FILTER TOOLTIP ---
// Shows which Globetrotter regions and Harmony filters a champion belongs to.
// Desktop: mouseover or keyboard focus. Touch: long-press the card.
const HOVER_CAPABLE = window.matchMedia("(hover: hover)").matches;
const LONG_PRESS_MS = 450;

function getChampionTooltip() {
  let tip = document.getElementById("champion-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "champion-tooltip";
    tip.className = "champion-tooltip";
    document.body.appendChild(tip);
    // A fixed-position tooltip would drift away from its card on scroll.
    window.addEventListener("scroll", hideChampionTooltip, { passive: true });
    // On touch, dismiss when tapping anywhere outside a champion card.
    document.addEventListener(
      "touchstart",
      (e) => {
        if (!e.target.closest(".champion")) hideChampionTooltip();
      },
      { passive: true },
    );
  }
  return tip;
}

function buildChampionTooltipContent(tip, champ) {
  tip.innerHTML = "";

  const title = document.createElement("div");
  title.className = "tooltip-champ";
  title.textContent = champ.name;
  tip.appendChild(title);

  // Completion date (progress stores an ISO timestamp when marked done)
  const doneValue = state.pages[state.activePage]?.progress?.[champ.id];
  if (doneValue) {
    const done = document.createElement("div");
    done.className = "tooltip-done";
    const time =
      typeof doneValue === "string" ? new Date(doneValue).getTime() : NaN;
    done.textContent = Number.isNaN(time)
      ? "✓ Done"
      : `✓ Done ${formatDay(time, true)}`;
    tip.appendChild(done);
  }

  const regions = getChampionFilters(champ.id, GLOBETROTTER_FILTERS);
  const harmony = getChampionFilters(champ.id, HARMONY_FILTERS);

  if (regions.length) {
    const heading = document.createElement("div");
    heading.className = "tooltip-section-title";
    heading.textContent = "Globetrotter";
    tip.appendChild(heading);

    regions.forEach((region) => {
      const row = document.createElement("div");
      row.className = "tooltip-region";
      const crest = createRegionCrest(region, "tooltip-crest");
      if (crest) row.appendChild(crest);
      const label = document.createElement("span");
      label.textContent = region;
      row.appendChild(label);
      tip.appendChild(row);
    });
  }

  if (harmony.length) {
    const heading = document.createElement("div");
    heading.className = "tooltip-section-title";
    heading.textContent = "Harmony";
    tip.appendChild(heading);

    const list = document.createElement("div");
    list.className = "tooltip-harmony";
    list.textContent = harmony.join(", ");
    tip.appendChild(list);
  }

  if (!regions.length && !harmony.length) {
    const empty = document.createElement("div");
    empty.className = "tooltip-empty";
    empty.textContent = "Not part of any challenge filter";
    tip.appendChild(empty);
  }
}

function showChampionTooltip(card, champ) {
  const tip = getChampionTooltip();
  buildChampionTooltipContent(tip, champ);
  tip.classList.add("visible");

  const rect = card.getBoundingClientRect();
  const margin = 8;
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;

  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  // Prefer above the card; fall back to below near the top of the viewport.
  let top = rect.top - height - margin;
  if (top < margin) top = rect.bottom + margin;

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideChampionTooltip() {
  const tip = document.getElementById("champion-tooltip");
  if (tip) tip.classList.remove("visible");
}
// --- UTILITY FUNCTIONS ---
// Shade color to create a grayed-out version
function shadeColor(color, percent) {
  // percent: 0 = original color, 1 = white
  let R = parseInt(color.substring(1, 3), 16);
  let G = parseInt(color.substring(3, 5), 16);
  let B = parseInt(color.substring(5, 7), 16);

  R = Math.round(R + (128 - R) * percent);
  G = Math.round(G + (128 - G) * percent);
  B = Math.round(B + (128 - B) * percent);

  const rr = R.toString(16).padStart(2, "0");
  const gg = G.toString(16).padStart(2, "0");
  const bb = B.toString(16).padStart(2, "0");

  return `#${rr}${gg}${bb}`;
}

// --- CHAMPION QUOTE PLAYBACK ---
// Champion select/ban voice lines from Community Dragon's key-free CDN,
// addressed by the numeric champion id (DDragon exposes it as `champ.key`).
// Gated by the 🔊 toggle in the settings drawer; off by default so the site
// never makes noise unprompted.
const CDRAGON_VO_BASE =
  "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1";
let quoteAudio = null;

function quotesEnabled() {
  return localStorage.getItem("lol_quotes") === "true";
}

function playChampionQuote(champ) {
  if (!quotesEnabled() || !champ?.key) return;

  // Each champion has a "choose" (select) and a "ban" voice line; play a
  // random one for variety and fall back to the other if it 404s.
  const variants = ["champion-choose-vo", "champion-ban-vo"];
  if (Math.random() < 0.5) variants.reverse();
  const urls = variants.map((v) => `${CDRAGON_VO_BASE}/${v}/${champ.key}.ogg`);

  // Interrupt a still-playing quote so quick marking doesn't overlap.
  if (quoteAudio) {
    quoteAudio.pause();
    quoteAudio = null;
  }

  const audio = new Audio();
  audio.volume = 0.6;
  let attempt = 0;
  const tryNext = () => {
    if (attempt >= urls.length) return;
    audio.src = urls[attempt++];
    audio.play().catch(() => {}); // guards autoplay rejection; error hops on
  };
  // A failed source (404/decode) fires "error" → move to the fallback url.
  audio.addEventListener("error", tryNext);
  quoteAudio = audio;
  tryNext();
}

function createChampionCard(champ) {
  const progress = getProgress();

  const div = document.createElement("div");
  div.className = "champion";
  div.dataset.champId = champ.id;
  div.tabIndex = 0;
  div.setAttribute("role", "button");
  div.setAttribute("aria-pressed", String(Boolean(progress[champ.id])));
  if (progress[champ.id]) div.classList.add("done");

  const img = document.createElement("img");
  img.src = `${CHAMPION_ICON_BASE}${champ.image.full}`;
  img.alt = champ.name;

  const name = document.createElement("div");
  name.className = "champion-name";
  name.textContent = champ.name;

  div.appendChild(img);
  div.appendChild(name);

  // Long-press on touch devices shows the tooltip instead of toggling.
  let longPressTimer = null;
  let longPressFired = false;

  div.onclick = () => {
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    hideChampionTooltip();
    const nowDone = !progress[champ.id];
    const key = clearedTimestampKey(champ.id);
    if (nowDone) {
      // Re-marking: reuse the timestamp from before it was toggled off, so an
      // accidental off/on doesn't wipe the original completion date.
      progress[champ.id] =
        clearedTimestamps.get(key) || new Date().toISOString();
      clearedTimestamps.delete(key);
    } else {
      clearedTimestamps.set(key, progress[champ.id]);
      progress[champ.id] = false;
    }
    // A champion can appear twice (main grid + the "Available now" scan
    // group); keep every card for this id visually in sync.
    syncChampionCardState(champ.id, nowDone);
    saveState();
    updateProgressText();
    refreshFilterCounts();
    refreshScanCount();
    renderHistory();
    // With "Hide completed" active the marked card has to leave the grid.
    if (nowDone && filterState.hideCompleted) renderChampions();
    if (nowDone) playChampionQuote(champ);
    if (nowDone) window.Celebrations?.check(champions, progress, champ);
  };

  div.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      div.click();
    }
  });

  if (HOVER_CAPABLE) {
    div.addEventListener("mouseenter", () => showChampionTooltip(div, champ));
    div.addEventListener("mouseleave", hideChampionTooltip);
  }
  div.addEventListener("focus", () => showChampionTooltip(div, champ));
  div.addEventListener("blur", hideChampionTooltip);

  div.addEventListener(
    "touchstart",
    () => {
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        showChampionTooltip(div, champ);
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );
  const cancelLongPress = () => clearTimeout(longPressTimer);
  div.addEventListener("touchmove", cancelLongPress, { passive: true });
  div.addEventListener("touchend", cancelLongPress, { passive: true });
  div.addEventListener("touchcancel", cancelLongPress, { passive: true });
  div.addEventListener("contextmenu", (e) => {
    if (longPressFired) e.preventDefault();
  });

  return div;
}
