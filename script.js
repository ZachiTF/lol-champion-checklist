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
        )}?api_key=YOUR_API_KEY`,
      );
      if (!summonerRes.ok) throw new Error("Summoner not found.");
      const summonerData = await summonerRes.json();
      // Step 2: Get Challenge Progress (Adapt to All Situations, challengeId=303001)
      const challengeRes = await fetch(
        `https://${server}.api.riotgames.com/lol/challenges/v1/player-data/${summonerData.puuid}?api_key=YOUR_API_KEY`,
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
// CHAMPION_REGIONS and CHAMPION_PROPERTIES

// Filter state - now supports multiple selections per category
let filterState = {
  search: "",
  regions: [], // Multiple regions
  properties: [], // Multiple properties
};

// Get champion metadata
function getChampionRegion(champId) {
  return CHAMPION_REGIONS[champId] || "Unknown";
}

function getChampionProperties(champId) {
  const props = [];
  for (const [propName, propData] of Object.entries(CHAMPION_PROPERTIES)) {
    const champList = propData.champions || propData;
    if (champList.includes(champId)) {
      props.push(propName);
    }
  }
  return props;
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

  progressText.textContent = `Progress: ${done} / ${total}`;

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
}

function renderTabActions() {
  const actionsBar = document.getElementById("tab-actions");
  actionsBar.innerHTML = "";
  if (!state.activePage || !state.pages[state.activePage]) return;
  const page = state.pages[state.activePage];

  // Style the actions bar with the tab color (grayed out)
  if (page.color) {
    actionsBar.style.background = shadeColor(page.color, 0.7);
  } else {
    actionsBar.style.background = "";
  }

  // Group 1: Color / Rename / Delete
  const group1 = document.createElement("div");
  group1.className = "action-group";

  // Color picker swatch
  const colorSwatch = document.createElement("label");
  colorSwatch.className = "color-swatch";
  colorSwatch.style.background = page.color || "#e57373";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = page.color || "#e57373";
  colorInput.title = "Pick tab color";
  colorInput.onchange = (e) => {
    page.color = e.target.value;
    saveState();
    renderAll();
  };
  colorSwatch.appendChild(colorInput);
  group1.appendChild(colorSwatch);

  // Rename
  const renameBtn = document.createElement("button");
  renameBtn.className = "action";
  renameBtn.textContent = "Rename";
  renameBtn.onclick = () => {
    const newName = prompt("Rename tab:", page.name);
    if (newName && newName !== page.name) {
      page.name = newName;
      saveState();
      renderAll();
    }
  };
  group1.appendChild(renameBtn);

  // Delete
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "action";
  deleteBtn.textContent = "Delete";
  deleteBtn.onclick = () => {
    if (confirm("Delete this tab? This cannot be undone.")) {
      delete state.pages[state.activePage];
      // Switch to another tab if any
      const ids = Object.keys(state.pages);
      state.activePage = ids.length ? ids[0] : null;
      saveState();
      renderAll();
    }
  };
  group1.appendChild(deleteBtn);
  actionsBar.appendChild(group1);

  // Group 2: Reset Progress / Select All
  const group2 = document.createElement("div");
  group2.className = "action-group";

  // Reset
  const resetBtn = document.createElement("button");
  resetBtn.className = "action";
  resetBtn.textContent = "Reset Progress";
  resetBtn.onclick = () => {
    if (confirm("Reset progress for this tab?")) {
      page.progress = {};
      saveState();
      renderAll();
    }
  };
  group2.appendChild(resetBtn);

  // Select All
  const selectAllBtn = document.createElement("button");
  selectAllBtn.className = "action";
  selectAllBtn.textContent = "Select All";
  selectAllBtn.onclick = () => {
    if (confirm("Mark all champions as done for this tab?")) {
      for (const champ of champions) {
        page.progress[champ.id] = true;
      }
      saveState();
      renderAll();
    }
  };
  group2.appendChild(selectAllBtn);
  actionsBar.appendChild(group2);

  // Group 3: Export / Import
  const group3 = document.createElement("div");
  group3.className = "action-group";

  // Export
  const exportBtn = document.createElement("button");
  exportBtn.className = "action";
  exportBtn.textContent = "Export";
  exportBtn.onclick = () => {
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
  };
  group3.appendChild(exportBtn);

  // Import
  const importBtn = document.createElement("button");
  importBtn.className = "action";
  importBtn.textContent = "Import";
  importBtn.onclick = () => {
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
            // Ensure imported page has a color
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
  };
  group3.appendChild(importBtn);
  actionsBar.appendChild(group3);
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
    progress[champ.id] = !progress[champ.id];
    div.classList.toggle("done");
    saveState();
    updateProgressText();
  };

  return div;
}

function renderChampions() {
  grid.innerHTML = "";
  const progress = getProgress();

  // Helper function to filter champions by properties (AND logic)
  function filterByProperties(champList) {
    if (filterState.properties.length === 0) return champList;

    return champList.filter((champ) => {
      const champProps = getChampionProperties(champ.id);
      // Must have ALL selected properties (AND logic)
      return filterState.properties.every((prop) => champProps.includes(prop));
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

  // If no regions selected, show all champions with property/search filters
  if (filterState.regions.length === 0) {
    let filteredChampions = [...champions];
    filteredChampions = filterBySearch(filteredChampions);
    filteredChampions = filterByProperties(filteredChampions);

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
    // Multiple regions selected - create separate grid for each region
    filterState.regions.forEach((selectedRegion, index) => {
      // Filter champions for this region
      let regionChampions = champions.filter(
        (champ) => getChampionRegion(champ.id) === selectedRegion,
      );
      regionChampions = filterBySearch(regionChampions);
      regionChampions = filterByProperties(regionChampions);

      // Create region section
      const regionSection = document.createElement("div");
      regionSection.className = "region-section";

      // Create region header with badge
      const regionHeader = document.createElement("div");
      regionHeader.className = "region-header";

      const regionBadge = document.createElement("div");
      regionBadge.className = "filter-badge filter-badge-region";
      const regionLabel = document.createElement("span");
      regionLabel.className = "filter-badge-label";
      regionLabel.textContent = selectedRegion;
      const regionRemove = document.createElement("span");
      regionRemove.className = "filter-badge-remove";
      regionRemove.textContent = "×";
      regionRemove.onclick = () => {
        filterState.regions = filterState.regions.filter(
          (r) => r !== selectedRegion,
        );
        renderActiveFilters();
        renderChampions();
      };
      regionBadge.appendChild(regionLabel);
      regionBadge.appendChild(regionRemove);
      regionHeader.appendChild(regionBadge);

      // Show count for this region
      const regionCount = document.createElement("span");
      regionCount.className = "region-count";
      regionCount.textContent = `${regionChampions.length} champions`;
      regionHeader.appendChild(regionCount);

      regionSection.appendChild(regionHeader);

      // Create grid for this region
      const regionGrid = document.createElement("div");
      regionGrid.className = "champion-grid-region";

      regionChampions.forEach((champ) => {
        if (!(champ.id in progress)) {
          progress[champ.id] = false;
        }
        regionGrid.appendChild(createChampionCard(champ));
      });

      regionSection.appendChild(regionGrid);
      grid.appendChild(regionSection);
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

  // Only render property badges in the active filters area
  // Region badges are shown inline with their respective grids
  filterState.properties.forEach((prop) => {
    const badge = createFilterBadge(prop, "property");
    container.appendChild(badge);
  });
}

function createFilterBadge(value, type) {
  const badge = document.createElement("div");
  badge.className = "filter-badge";
  if (type === "region") badge.classList.add("filter-badge-region");
  if (type === "property") badge.classList.add("filter-badge-property");

  const label = document.createElement("span");
  label.className = "filter-badge-label";
  label.textContent = value;

  const remove = document.createElement("span");
  remove.className = "filter-badge-remove";
  remove.textContent = "×";
  remove.onclick = () => {
    if (type === "region") {
      filterState.regions = filterState.regions.filter((r) => r !== value);
    } else if (type === "property") {
      filterState.properties = filterState.properties.filter(
        (p) => p !== value,
      );
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
  const regionSelect = document.getElementById("filter-region");
  const propertiesSelect = document.getElementById("filter-properties");
  const resetBtn = document.getElementById("filter-reset");

  const searchClearBtn = document.getElementById("filter-search-clear");
  if (!searchInput || !regionSelect || !propertiesSelect || !searchClearBtn)
    return;

  // Populate region dropdown
  const regions = new Set();
  champions.forEach((champ) => {
    const region = getChampionRegion(champ.id);
    if (region !== "Unknown") regions.add(region);
  });
  regionSelect.innerHTML =
    '<option value="" disabled selected>Add Region Filter</option>';
  [...regions].sort().forEach((region) => {
    const opt = document.createElement("option");
    opt.value = region;
    opt.textContent = region;
    regionSelect.appendChild(opt);
  });

  // Populate properties dropdown
  const properties = Object.keys(CHAMPION_PROPERTIES).sort();
  propertiesSelect.innerHTML =
    '<option value="" disabled selected>Add Property Filter</option>';
  properties.forEach((prop) => {
    const opt = document.createElement("option");
    opt.value = prop;
    opt.textContent = prop;
    propertiesSelect.appendChild(opt);
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

  regionSelect.addEventListener("change", (e) => {
    const value = e.target.value;
    if (value && !filterState.regions.includes(value)) {
      filterState.regions.push(value);
      renderActiveFilters();
      renderChampions();
    }
    // Reset dropdown to placeholder
    regionSelect.selectedIndex = 0;
  });

  propertiesSelect.addEventListener("change", (e) => {
    const value = e.target.value;
    if (value && !filterState.properties.includes(value)) {
      filterState.properties.push(value);
      renderActiveFilters();
      renderChampions();
    }
    // Reset dropdown to placeholder
    propertiesSelect.selectedIndex = 0;
  });

  resetBtn.addEventListener("click", () => {
    filterState = { search: "", regions: [], properties: [] };
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
  animBtn.title = `Animations: ${
    animationsEnabled ? "On" : "Off"
  } (click to toggle)`;
  animBtn.onclick = () => {
    const newState = !animationsEnabled;
    localStorage.setItem("lol_animations", newState);
    document.body.classList.toggle("animations-enabled", newState);
    renderThemeSwitcher();
  };
  bar.appendChild(animBtn);
}

// --- MAIN ---
// Initialize theme on load
setTheme(localStorage.getItem("lol_theme") || "auto");

// Initialize animations (off by default for better performance)
const animationsEnabled = localStorage.getItem("lol_animations") === "true";
document.body.classList.toggle("animations-enabled", animationsEnabled);

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
