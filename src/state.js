// Core state: persistence, page/progress model, filter + sort state, migrations.

// --- CONFIG ---
const LANG = "en_US";
const STORAGE_KEY = "lol_pages";

let PATCH = null;
let CHAMPION_JSON_URL = null;
let CHAMPION_ICON_BASE = null;

// --- STATE ---
let state = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {
  activePage: null,
  pages: {},
};

// Progress values: ISO timestamp string when done (records *when* the champion
// was marked), false when not done. Truthiness checks keep working either way.
// Legacy data stored `true`; migrate it in place by stamping the current date.
function migrateProgressTimestamps(page) {
  if (!page || typeof page.progress !== "object" || page.progress === null) {
    return false;
  }
  let changed = false;
  const now = new Date().toISOString();
  for (const [champId, value] of Object.entries(page.progress)) {
    if (value === true) {
      page.progress[champId] = now;
      changed = true;
    }
  }
  return changed;
}

(function migrateState() {
  let changed = false;
  for (const page of Object.values(state.pages)) {
    if (migrateProgressTimestamps(page)) changed = true;
  }
  if (changed) saveState();
})();

// Remembers the completion timestamp of champions unmarked during this session,
// keyed by `${pageId}:${champId}`. Toggling a champion off then on again (an
// accidental double-click, or just for fun) restores the original date instead
// of stamping a fresh one, which is almost never what the user wants.
const clearedTimestamps = new Map();
function clearedTimestampKey(champId) {
  return `${state.activePage}:${champId}`;
}

let champions = [];

// Champion metadata - loaded from data/*.js files as global constants:
// GLOBETROTTER_FILTERS and HARMONY_FILTERS

// Filter state - now supports multiple selections per category
let filterState = {
  search: "",
  globetrotter: [], // Multiple globetrotter filters (regions)
  harmony: [], // Multiple harmony filters (properties)
  hideCompleted: false,
  sortKey: "name", // "name" | "done" | "recent"
  sortDir: "asc", // "asc" | "desc"
};

// Current display order (champion ids). Sorts are applied to this array
// in place with a stable sort, so sorting by one key after another keeps
// the previous order as the tie-breaker (multi-key sorting): e.g. sort by
// Name ↓ then Completion ↑ gives incomplete-first, Z→A within each group.
let championOrder = [];

function applySort() {
  const progress = getProgress();
  const byId = new Map(champions.map((c) => [c.id, c]));
  const dir = filterState.sortDir === "desc" ? -1 : 1;
  const doneTime = (champ) => {
    const value = progress[champ.id];
    if (!value) return -1; // unmarked sorts before the oldest done date
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isNaN(time) ? 0 : time;
  };
  championOrder.sort((aId, bId) => {
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b) return 0;
    let cmp = 0;
    if (filterState.sortKey === "name") {
      cmp = a.name.localeCompare(b.name);
    } else if (filterState.sortKey === "done") {
      // ascending: incomplete before done
      cmp = (progress[a.id] ? 1 : 0) - (progress[b.id] ? 1 : 0);
    } else if (filterState.sortKey === "recent") {
      cmp = doneTime(a) - doneTime(b);
    }
    return cmp * dir;
  });
}

function resetSortOrder() {
  championOrder = champions.map((c) => c.id);
}

// Champions in the current display order (falls back to A–Z before load).
function orderedChampions() {
  if (!championOrder.length) return [...champions];
  const byId = new Map(champions.map((c) => [c.id, c]));
  return championOrder.map((id) => byId.get(id)).filter(Boolean);
}


// --- ELEMENTS ---
const DEFAULT_COLORS = [
  "#e57373",
  "#64b5f6",
  "#81c784",
  "#ffd54f",
  "#ba68c8",
  "#4db6ac",
  "#ffb74d",
  "#a1887f",
  "#90a4ae",
];
function getNextColor() {
  const used = Object.values(state.pages).map((p) => p.color);
  for (const c of DEFAULT_COLORS) if (!used.includes(c)) return c;
  // fallback: random color
  return `#${Math.floor(Math.random() * 16777215)
    .toString(16)
    .padStart(6, "0")}`;
}
// --- STORAGE ---
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// --- PAGES ---
function createPage(name) {
  const id = crypto.randomUUID();
  state.pages[id] = {
    name,
    progress: {},
    color: getNextColor(),
  };
  state.activePage = id;
  saveState();
}

function getProgress() {
  const page = state.pages[state.activePage];
  return page ? page.progress : {};
}

