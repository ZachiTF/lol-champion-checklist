// --- SERVER LIST ---
const RIOT_SERVERS = [
  { value: "euw1", label: "EUW" },
  { value: "na1", label: "NA" },
  { value: "br1", label: "BR" },
  { value: "eune1", label: "EUNE" },
  { value: "kr", label: "KR" },
  { value: "jp1", label: "JP" },
  { value: "ru", label: "RU" },
  { value: "tr1", label: "TR" },
  { value: "oc1", label: "OCE" },
  { value: "la1", label: "LAN" },
  { value: "la2", label: "LAS" },
];

const RIOT_API_STORAGE_KEY = "lol_riot_api_key";

function getRiotApiKey() {
  if (window.APP_CONFIG?.RIOT_API_KEY) {
    return window.APP_CONFIG.RIOT_API_KEY;
  }

  const params = new URLSearchParams(window.location.search);
  const keyFromUrl = params.get("api");

  if (keyFromUrl) {
    localStorage.setItem(RIOT_API_STORAGE_KEY, keyFromUrl);
    params.delete("api");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${
      nextQuery ? `?${nextQuery}` : ""
    }${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }

  return localStorage.getItem(RIOT_API_STORAGE_KEY) || "";
}

function populateServerDropdown() {
  const select = document.getElementById("server-select");
  if (!select) return;
  select.innerHTML = "";
  const labelOpt = document.createElement("option");
  labelOpt.value = "";
  labelOpt.textContent = "Region";
  labelOpt.disabled = true;
  labelOpt.selected = true;
  select.appendChild(labelOpt);
  RIOT_SERVERS.forEach((server) => {
    const opt = document.createElement("option");
    opt.value = server.value;
    opt.textContent = server.label;
    select.appendChild(opt);
  });

  // Set default to EUW after label
  select.selectedIndex = 1;

  // Update placeholder dynamically based on selected region
  const searchInput = document.getElementById("summoner-search");
  const updatePlaceholder = () => {
    const selected = RIOT_SERVERS.find((s) => s.value === select.value);
    if (searchInput && selected) {
      searchInput.placeholder = `Summoner name #${selected.label}`;
    }
  };
  select.addEventListener("change", updatePlaceholder);
  updatePlaceholder();
}

document.addEventListener("DOMContentLoaded", () => {
  populateServerDropdown();
});
// --- CHALLENGE IMPORT ---
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("arena-god-btn");
  if (!btn) return;
  btn.onclick = async () => {
    const summoner = document.getElementById("summoner-search").value.trim();
    const server = document.getElementById("server-select").value;
    const status = document.getElementById("challenge-import-status");
    const apiKey = getRiotApiKey();

    if (!apiKey) {
      status.textContent =
        "Riot API key missing. Set localStorage key 'lol_riot_api_key' or open with ?api=YOUR_KEY once.";
      return;
    }

    if (!summoner) {
      status.textContent = "Enter a summoner name.";
      return;
    }
    status.textContent = "Fetching...";
    try {
      // Step 1: Get Summoner ID
      const summonerRes = await fetch(
        `https://${server}.api.riotgames.com/lol/summoner/v4/summoners/by-name/${encodeURIComponent(
          summoner,
        )}?api_key=${encodeURIComponent(apiKey)}`,
      );
      if (!summonerRes.ok) throw new Error("Summoner not found.");
      const summonerData = await summonerRes.json();
      // Step 2: Get Challenge Progress (Adapt to All Situations, challengeId=303001)
      const challengeRes = await fetch(
        `https://${server}.api.riotgames.com/lol/challenges/v1/player-data/${
          summonerData.puuid
        }?api_key=${encodeURIComponent(apiKey)}`,
      );
      if (!challengeRes.ok) throw new Error("Challenge data not found.");
      const challengeData = await challengeRes.json();
      // Find progress for challengeId=303001
      const challenge = (challengeData.challenges || []).find(
        (c) => c.challengeId === 303001,
      );
      if (!challenge) throw new Error("Challenge not found.");
      status.textContent = `Progress: ${
        challenge.percentile
          ? Math.round(challenge.percentile * 100)
          : challenge.value
      }`;
      // TODO: Parse and update champion progress here
    } catch (e) {
      status.textContent = e.message || "Error fetching data.";
    }
  };
});
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

let champions = [];

// Champion metadata - loaded from data/*.js files as global constants:
// GLOBETROTTER_FILTERS and HARMONY_FILTERS

// Filter state - now supports multiple selections per category
let filterState = {
  search: "",
  globetrotter: [], // Multiple globetrotter filters (regions)
  harmony: [], // Multiple harmony filters (properties)
};

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
const grid = document.getElementById("champion-grid");
const progressText = document.getElementById("progress");
const tabsBar = document.getElementById("tabs-bar");

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
  return state.pages[state.activePage].progress;
}

// --- UI ---
function updateProgressText() {
  const progress = getProgress();
  const done = Object.values(progress).filter(Boolean).length;
  const total = champions.length;
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0;

  progressText.textContent = `Progress: ${done} / ${total} (${percentage}%)`;

  // Update progress bar
  const progressBar = document.getElementById("progress-bar");
  if (progressBar) {
    progressBar.style.width = `${percentage}%`;
  }
}

function renderTabs() {
  tabsBar.innerHTML = "";

  for (const [id, page] of Object.entries(state.pages)) {
    const tab = document.createElement("div");
    tab.className = "tab" + (id === state.activePage ? " active" : "");
    // Determine text color for contrast
    let textColor = "";
    if (page.color) {
      tab.style.background = page.color;
      textColor = getContrastYIQ(page.color);
    }
    tab.innerHTML = `<span class="tab-label" style="color:${textColor}">${page.name}</span>`;
    tab.onclick = () => {
      state.activePage = id;
      saveState();
      renderAll();
    };
    tabsBar.appendChild(tab);
  }
  // Returns '#222' for light backgrounds, '#fff' for dark backgrounds
  function getContrastYIQ(hexcolor) {
    let hex = hexcolor.replace("#", "");
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((x) => x + x)
        .join("");
    }
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    // YIQ formula
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 180 ? "#222" : "#fff";
  }

  const addTab = document.createElement("div");
  addTab.className = "tab add";
  addTab.textContent = "+";
  addTab.onclick = () => {
    const name = prompt("New page name:");
    if (name) {
      createPage(name);
      renderAll();
    }
  };

  tabsBar.appendChild(addTab);

  // Show ⚙ menu button only when there's an active page
  const menuBtn = document.getElementById("tab-menu-btn");
  if (menuBtn) {
    const hasActivePage = !!(state.activePage && state.pages[state.activePage]);
    menuBtn.classList.toggle("hidden", !hasActivePage);
    if (!hasActivePage) closeTabMenu();
  }
}

function renderTabActions() {
  const menu = document.getElementById("tab-actions");
  menu.innerHTML = "";
  if (!state.activePage || !state.pages[state.activePage]) {
    closeTabMenu();
    return;
  }
  const page = state.pages[state.activePage];

  // Menu header: active tab name with color accent
  const header = document.createElement("div");
  header.className = "menu-header";
  const accent = document.createElement("span");
  accent.className = "header-accent";
  accent.style.background = page.color || "#e57373";
  header.appendChild(accent);
  const headerLabel = document.createElement("span");
  headerLabel.textContent = page.name;
  header.appendChild(headerLabel);
  menu.appendChild(header);

  // Section 1: Color / Rename / Delete
  const section1 = document.createElement("div");
  section1.className = "menu-section";

  // Color picker — label wraps a hidden native color input
  const colorItem = document.createElement("label");
  colorItem.className = "menu-item menu-item-color";
  const colorSwatch = document.createElement("span");
  colorSwatch.className = "color-swatch";
  colorSwatch.style.background = page.color || "#e57373";
  colorItem.appendChild(colorSwatch);
  const colorLabel = document.createElement("span");
  colorLabel.textContent = "Color";
  colorItem.appendChild(colorLabel);
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = page.color || "#e57373";
  colorInput.title = "Pick tab color";
  colorInput.onchange = (e) => {
    page.color = e.target.value;
    saveState();
    renderAll();
  };
  colorItem.appendChild(colorInput);
  section1.appendChild(colorItem);

  section1.appendChild(
    createMenuItem("✏", "Rename", () => {
      const newName = prompt("Rename tab:", page.name);
      if (newName && newName !== page.name) {
        page.name = newName;
        saveState();
        renderAll();
      }
    }),
  );

  section1.appendChild(
    createMenuItem(
      "🗑",
      "Delete tab",
      () => {
        if (confirm("Delete this tab? This cannot be undone.")) {
          delete state.pages[state.activePage];
          const ids = Object.keys(state.pages);
          state.activePage = ids.length ? ids[0] : null;
          saveState();
          renderAll();
        }
      },
      { danger: true },
    ),
  );
  menu.appendChild(section1);

  // Section 2: Reset Progress / Select All
  const section2 = document.createElement("div");
  section2.className = "menu-section";

  section2.appendChild(
    createMenuItem("↺", "Reset progress", () => {
      if (confirm("Reset progress for this tab?")) {
        page.progress = {};
        saveState();
        renderAll();
      }
    }),
  );

  section2.appendChild(
    createMenuItem("✓", "Select all", () => {
      if (confirm("Mark all champions as done for this tab?")) {
        for (const champ of champions) {
          page.progress[champ.id] = true;
        }
        saveState();
        renderAll();
        window.Celebrations?.check(champions, page.progress, null);
      }
    }),
  );
  menu.appendChild(section2);

  // Section 3: Export / Import
  const section3 = document.createElement("div");
  section3.className = "menu-section";

  section3.appendChild(
    createMenuItem("↑", "Export", () => {
      const blob = new Blob([JSON.stringify(page, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${page.name.replace(/[^a-z0-9]/gi, "_")}_lol_page.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }),
  );

  section3.appendChild(
    createMenuItem("↓", "Import", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            if (imported.name && imported.progress) {
              const id = crypto.randomUUID();
              if (!imported.color) {
                imported.color = getNextColor();
              }
              state.pages[id] = imported;
              state.activePage = id;
              saveState();
              renderAll();
            } else {
              alert("Invalid file format.");
            }
          } catch {
            alert("Failed to import file.");
          }
        };
        reader.readAsText(file);
      };
      input.click();
    }),
  );
  menu.appendChild(section3);
}

function createMenuItem(icon, label, onClick, opts = {}) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "menu-item" + (opts.danger ? " menu-item-danger" : "");
  item.setAttribute("role", "menuitem");
  const iconEl = document.createElement("span");
  iconEl.className = "menu-icon";
  iconEl.textContent = icon;
  item.appendChild(iconEl);
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  item.appendChild(labelEl);
  item.onclick = onClick;
  return item;
}

// --- TAB MENU OPEN/CLOSE CONTROLLER ---
const MOBILE_BREAKPOINT = 600;

function positionTabMenu() {
  const menu = document.getElementById("tab-actions");
  const btn = document.getElementById("tab-menu-btn");
  if (!menu || !btn || !menu.classList.contains("open")) return;

  // On narrow viewports let the CSS rule (edge-to-edge) take over
  if (window.innerWidth <= MOBILE_BREAKPOINT) {
    menu.style.left = "";
    menu.style.right = "";
    return;
  }

  // Measure naturally first
  menu.style.left = "0px";
  menu.style.right = "auto";

  const btnRect = btn.getBoundingClientRect();
  const parent = menu.offsetParent || document.body;
  const parentRect = parent.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  const viewportWidth = window.innerWidth;
  const margin = 8;

  // Prefer aligning menu's left edge under the button
  let leftViewport = btnRect.left;

  // If overflowing right viewport edge, shift left to fit
  if (leftViewport + menuWidth + margin > viewportWidth) {
    leftViewport = viewportWidth - menuWidth - margin;
  }
  // Clamp to left margin
  if (leftViewport < margin) leftViewport = margin;

  menu.style.left = `${leftViewport - parentRect.left}px`;
  menu.style.right = "auto";
}

function openTabMenu() {
  const menu = document.getElementById("tab-actions");
  const btn = document.getElementById("tab-menu-btn");
  if (!menu || !btn) return;
  menu.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  positionTabMenu();
}

function closeTabMenu() {
  const menu = document.getElementById("tab-actions");
  const btn = document.getElementById("tab-menu-btn");
  if (!menu || !btn) return;
  menu.classList.remove("open");
  btn.setAttribute("aria-expanded", "false");
  menu.style.left = "";
  menu.style.right = "";
}

function toggleTabMenu() {
  const menu = document.getElementById("tab-actions");
  if (!menu) return;
  if (menu.classList.contains("open")) closeTabMenu();
  else openTabMenu();
}

// Wire up the ⚙ button + outside-click + Escape
(function initTabMenuController() {
  const btn = document.getElementById("tab-menu-btn");
  if (btn) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTabMenu();
    });
  }

  document.addEventListener("mousedown", (e) => {
    const menu = document.getElementById("tab-actions");
    const trigger = document.getElementById("tab-menu-btn");
    if (!menu || !menu.classList.contains("open")) return;
    if (menu.contains(e.target) || trigger?.contains(e.target)) return;
    closeTabMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTabMenu();
  });

  window.addEventListener("resize", positionTabMenu);
})();

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

function createChampionCard(champ) {
  const progress = getProgress();

  const div = document.createElement("div");
  div.className = "champion";
  if (progress[champ.id]) div.classList.add("done");

  const img = document.createElement("img");
  img.src = `${CHAMPION_ICON_BASE}${champ.image.full}`;
  img.alt = champ.name;

  const name = document.createElement("div");
  name.className = "champion-name";
  name.textContent = champ.name;

  div.appendChild(img);
  div.appendChild(name);

  div.onclick = () => {
    const nowDone = !progress[champ.id];
    progress[champ.id] = nowDone;
    div.classList.toggle("done");
    saveState();
    updateProgressText();
    if (nowDone) window.Celebrations?.check(champions, progress, champ);
  };

  return div;
}

function renderChampions() {
  grid.innerHTML = "";
  const progress = getProgress();

  // Helper function to filter champions by harmony filters (AND logic)
  function filterByHarmony(champList) {
    if (filterState.harmony.length === 0) return champList;

    return champList.filter((champ) => {
      // Must be in ALL selected harmony filters (AND logic)
      return filterState.harmony.every((filterName) =>
        HARMONY_FILTERS[filterName].champions.includes(champ.id),
      );
    });
  }

  // Helper function to filter by search
  function filterBySearch(champList) {
    if (!filterState.search) return champList;

    const searchLower = filterState.search.toLowerCase();
    return champList.filter((champ) =>
      champ.name.toLowerCase().includes(searchLower),
    );
  }

  // If no globetrotter filters selected, show all champions with harmony/search filters
  if (filterState.globetrotter.length === 0) {
    let filteredChampions = [...champions];
    filteredChampions = filterBySearch(filteredChampions);
    filteredChampions = filterByHarmony(filteredChampions);

    // Show count
    const filterCount = document.createElement("div");
    filterCount.className = "filter-count";
    filterCount.textContent = `Showing ${filteredChampions.length} of ${champions.length} champions`;
    filterCount.style.marginBottom = "12px";
    filterCount.style.fontSize = "0.9em";
    filterCount.style.opacity = "0.7";
    if (filteredChampions.length < champions.length) {
      grid.appendChild(filterCount);
    }

    filteredChampions.forEach((champ) => {
      if (!(champ.id in progress)) {
        progress[champ.id] = false;
      }
      grid.appendChild(createChampionCard(champ));
    });
  } else {
    // Multiple globetrotter filters selected - create separate grid for each
    filterState.globetrotter.forEach((selectedFilter, index) => {
      // Get champions for this filter
      const filterData = GLOBETROTTER_FILTERS[selectedFilter];
      let filterChampions = champions.filter((champ) =>
        filterData.champions.includes(champ.id),
      );
      filterChampions = filterBySearch(filterChampions);
      filterChampions = filterByHarmony(filterChampions);

      // Create filter section
      const filterSection = document.createElement("div");
      filterSection.className = "region-section";

      // Create filter header with badge
      const filterHeader = document.createElement("div");
      filterHeader.className = "region-header";

      const filterBadge = document.createElement("div");
      filterBadge.className = "filter-badge filter-badge-region";
      const filterLabel = document.createElement("span");
      filterLabel.className = "filter-badge-label";
      filterLabel.textContent = selectedFilter;
      const filterRemove = document.createElement("span");
      filterRemove.className = "filter-badge-remove";
      filterRemove.textContent = "×";
      filterRemove.onclick = () => {
        filterState.globetrotter = filterState.globetrotter.filter(
          (r) => r !== selectedFilter,
        );
        renderActiveFilters();
        renderChampions();
      };
      filterBadge.appendChild(filterLabel);
      filterBadge.appendChild(filterRemove);
      filterHeader.appendChild(filterBadge);

      // Show count for this filter
      const filterCount = document.createElement("span");
      filterCount.className = "region-count";
      filterCount.textContent = `${filterChampions.length} champions`;
      filterHeader.appendChild(filterCount);

      filterSection.appendChild(filterHeader);

      // Create grid for this filter
      const filterGrid = document.createElement("div");
      filterGrid.className = "champion-grid-region";

      filterChampions.forEach((champ) => {
        if (!(champ.id in progress)) {
          progress[champ.id] = false;
        }
        filterGrid.appendChild(createChampionCard(champ));
      });

      filterSection.appendChild(filterGrid);
      grid.appendChild(filterSection);
    });
  }

  saveState();
  updateProgressText();
}

function renderAll() {
  renderThemeSwitcher();
  renderTabs();
  renderTabActions();
  initializeFilters();
  renderChampions();
}

// --- FILTERS ---
function renderActiveFilters() {
  const container = document.getElementById("active-filters");
  if (!container) return;

  container.innerHTML = "";

  // Only render harmony badges in the active filters area
  // Globetrotter badges are shown inline with their respective grids
  filterState.harmony.forEach((harmonyFilter) => {
    const badge = createFilterBadge(harmonyFilter, "harmony");
    container.appendChild(badge);
  });
}

function createFilterBadge(value, type) {
  const badge = document.createElement("div");
  badge.className = "filter-badge";
  if (type === "globetrotter") badge.classList.add("filter-badge-region");
  if (type === "harmony") badge.classList.add("filter-badge-property");

  const label = document.createElement("span");
  label.className = "filter-badge-label";
  label.textContent = value;

  const remove = document.createElement("span");
  remove.className = "filter-badge-remove";
  remove.textContent = "×";
  remove.onclick = () => {
    if (type === "globetrotter") {
      filterState.globetrotter = filterState.globetrotter.filter(
        (r) => r !== value,
      );
    } else if (type === "harmony") {
      filterState.harmony = filterState.harmony.filter((p) => p !== value);
    }
    renderActiveFilters();
    renderChampions();
  };

  badge.appendChild(label);
  badge.appendChild(remove);
  return badge;
}

function initializeFilters() {
  const searchInput = document.getElementById("filter-search");
  const globetrotterSelect = document.getElementById("filter-region");
  const harmonySelect = document.getElementById("filter-properties");
  const resetBtn = document.getElementById("filter-reset");

  const searchClearBtn = document.getElementById("filter-search-clear");
  if (!searchInput || !globetrotterSelect || !harmonySelect || !searchClearBtn)
    return;

  // Populate globetrotter dropdown
  const globetrotterFilters = Object.keys(GLOBETROTTER_FILTERS).sort();
  globetrotterSelect.innerHTML =
    '<option value="" disabled selected>Add Globetrotter Filter</option>';
  globetrotterFilters.forEach((filterName) => {
    const opt = document.createElement("option");
    opt.value = filterName;
    opt.textContent = filterName;
    globetrotterSelect.appendChild(opt);
  });

  // Populate harmony dropdown
  const harmonyFilters = Object.keys(HARMONY_FILTERS).sort();
  harmonySelect.innerHTML =
    '<option value="" disabled selected>Add Harmony Filter</option>';
  harmonyFilters.forEach((filterName) => {
    const opt = document.createElement("option");
    opt.value = filterName;
    opt.textContent = filterName;
    harmonySelect.appendChild(opt);
  });

  // Event listeners

  searchInput.addEventListener("input", (e) => {
    filterState.search = e.target.value;
    renderChampions();
    searchClearBtn.style.display = e.target.value ? "inline" : "none";
  });

  searchClearBtn.onclick = () => {
    filterState.search = "";
    searchInput.value = "";
    searchClearBtn.style.display = "none";
    renderChampions();
  };
  searchClearBtn.style.display = searchInput.value ? "inline" : "none";

  globetrotterSelect.addEventListener("change", (e) => {
    const value = e.target.value;
    if (value && !filterState.globetrotter.includes(value)) {
      filterState.globetrotter.push(value);
      renderActiveFilters();
      renderChampions();
    }
    // Reset dropdown to placeholder
    globetrotterSelect.selectedIndex = 0;
  });

  harmonySelect.addEventListener("change", (e) => {
    const value = e.target.value;
    if (value && !filterState.harmony.includes(value)) {
      filterState.harmony.push(value);
      renderActiveFilters();
      renderChampions();
    }
    // Reset dropdown to placeholder
    harmonySelect.selectedIndex = 0;
  });

  resetBtn.addEventListener("click", () => {
    filterState = { search: "", globetrotter: [], harmony: [] };
    searchInput.value = "";
    renderActiveFilters();
    renderChampions();
  });

  // Restore current filter values
  searchInput.value = filterState.search;
  renderActiveFilters();
}

// --- THEME SWITCHER ---
const THEMES = ["dark", "light", "auto"];

function setTheme(theme) {
  if (theme === "auto") {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    document.body.classList.toggle("theme-dark", prefersDark);
    document.body.classList.toggle("theme-light", !prefersDark);
  } else {
    document.body.classList.toggle("theme-dark", theme === "dark");
    document.body.classList.toggle("theme-light", theme === "light");
  }
  localStorage.setItem("lol_theme", theme);
}

function renderThemeSwitcher() {
  const bar = document.getElementById("theme-switcher");
  if (!bar) return;

  bar.innerHTML = "";

  // Theme toggle button
  const current = localStorage.getItem("lol_theme") || "auto";
  const cycleOrder = ["auto", "dark", "light"];
  const nextTheme =
    cycleOrder[(cycleOrder.indexOf(current) + 1) % cycleOrder.length];

  const icons = {
    auto: "◐",
    dark: "☾",
    light: "☀",
  };

  const themeBtn = document.createElement("button");
  themeBtn.className = "theme-toggle";
  themeBtn.textContent = icons[current];
  themeBtn.title = `Theme: ${current} (click to switch to ${nextTheme})`;
  themeBtn.onclick = () => {
    setTheme(nextTheme);
    renderThemeSwitcher();
  };
  bar.appendChild(themeBtn);

  // Animation toggle button
  const animationsEnabled = localStorage.getItem("lol_animations") !== "false";
  const animBtn = document.createElement("button");
  animBtn.className =
    "animation-toggle" + (animationsEnabled ? "" : " disabled");
  animBtn.textContent = "✨";
  animBtn.title = `Effects & celebrations: ${
    animationsEnabled ? "On" : "Off"
  } (click to toggle)`;
  animBtn.onclick = () => {
    const newState = !animationsEnabled;
    localStorage.setItem("lol_animations", newState);
    document.body.classList.toggle("animations-enabled", newState);
    renderThemeSwitcher();
  };
  bar.appendChild(animBtn);

  // Summoner search toggle button
  const summonerVisible = localStorage.getItem("lol_summoner_search") === "true";
  const summonerBtn = document.createElement("button");
  summonerBtn.className =
    "summoner-toggle" + (summonerVisible ? "" : " disabled");
  summonerBtn.textContent = "🔍";
  summonerBtn.title = `Summoner search: ${
    summonerVisible ? "On" : "Off"
  } (click to toggle)`;
  summonerBtn.onclick = () => {
    const newState = !summonerVisible;
    localStorage.setItem("lol_summoner_search", newState);
    document.body.classList.toggle("summoner-search-hidden", !newState);
    renderThemeSwitcher();
  };
  bar.appendChild(summonerBtn);
}

// --- MAIN ---
// Initialize theme on load
setTheme(localStorage.getItem("lol_theme") || "auto");

// Initialize animations & celebrations (on by default)
const animationsEnabled = localStorage.getItem("lol_animations") !== "false";
document.body.classList.toggle("animations-enabled", animationsEnabled);

// Initialize summoner search (hidden by default — feature requires API key)
const summonerSearchVisible = localStorage.getItem("lol_summoner_search") === "true";
document.body.classList.toggle("summoner-search-hidden", !summonerSearchVisible);

// Listen for system theme changes when in auto mode
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    const currentTheme = localStorage.getItem("lol_theme") || "auto";
    if (currentTheme === "auto") {
      setTheme("auto");
    }
  });

// Step 1: Fetch latest patch version
fetch("https://ddragon.leagueoflegends.com/api/versions.json")
  .then((res) => res.json())
  .then((versions) => {
    PATCH = versions[0];
    CHAMPION_JSON_URL = `https://ddragon.leagueoflegends.com/cdn/${PATCH}/data/${LANG}/champion.json`;
    CHAMPION_ICON_BASE = `https://ddragon.leagueoflegends.com/cdn/${PATCH}/img/champion/`;

    // Step 2: Fetch champion data (metadata already loaded from JS files)
    return fetch(CHAMPION_JSON_URL).then((res) => res.json());
  })
  .then((championData) => {
    // Store champion data
    champions = Object.values(championData.data).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    // Metadata (CHAMPION_REGIONS and CHAMPION_PROPERTIES) already available from loaded scripts

    // Migration: Ensure all existing pages have colors
    for (const [id, page] of Object.entries(state.pages)) {
      if (!page.color) {
        page.color = getNextColor();
      }
    }

    if (Object.keys(state.pages).length === 0) {
      createPage("Default");
    }

    saveState();
    renderAll();
  })
  .catch((err) => {
    progressText.textContent = "Failed to load champion data.";
    console.error(err);
  });
