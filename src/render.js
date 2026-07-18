// UI rendering: grid, tabs + tab menu, filters, progress/undo, theme + settings.

const grid = document.getElementById("champion-grid");
const progressText = document.getElementById("progress");
const tabsBar = document.getElementById("tabs-bar");

// --- UNDO BANNER ---
// Destructive tab actions run immediately instead of asking confirm();
// the banner offers a few seconds to revert them.
const UNDO_DURATION = 8000;
let undoBannerTimers = [];

// The last undoable action stays available in the tab ⚙ menu after the
// banner expires, until it is undone or replaced by a newer action.
let lastUndoAction = null;

function performUndo() {
  if (!lastUndoAction) return;
  const { undo } = lastUndoAction;
  lastUndoAction = null;
  dismissUndoBanner(true);
  undo();
}

function dismissUndoBanner(immediate = false) {
  const banner = document.querySelector(".undo-banner");
  undoBannerTimers.forEach(clearTimeout);
  undoBannerTimers = [];
  if (!banner) return;
  if (immediate) {
    banner.remove();
  } else {
    banner.classList.add("leaving");
    window.setTimeout(() => banner.remove(), 400);
  }
}

function showUndoBanner(message, undoFn) {
  dismissUndoBanner(true);
  lastUndoAction = { message, undo: undoFn };
  // The tab menu was rebuilt before this call; refresh its Undo entry.
  renderTabActions();

  const banner = document.createElement("div");
  banner.className = "undo-banner";
  banner.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "undo-message";
  text.textContent = message;
  banner.appendChild(text);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "undo-btn";
  btn.textContent = "Undo";
  btn.onclick = performUndo;
  banner.appendChild(btn);

  document.body.appendChild(banner);
  undoBannerTimers.push(
    window.setTimeout(() => dismissUndoBanner(), UNDO_DURATION),
  );
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
    const tabLabel = document.createElement("span");
    tabLabel.className = "tab-label";
    if (textColor) tabLabel.style.color = textColor;
    tabLabel.textContent = page.name;
    tab.appendChild(tabLabel);
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

  // Undo section — mirrors the transient banner so the last destructive
  // action stays revertible after the banner disappears.
  if (lastUndoAction) {
    const undoSection = document.createElement("div");
    undoSection.className = "menu-section";
    undoSection.appendChild(
      createMenuItem("↶", `Undo: ${lastUndoAction.message}`, performUndo),
    );
    menu.appendChild(undoSection);
  }

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
        const deletedId = state.activePage;
        const deletedPage = state.pages[deletedId];
        delete state.pages[deletedId];
        const ids = Object.keys(state.pages);
        state.activePage = ids.length ? ids[0] : null;
        saveState();
        renderAll();
        showUndoBanner(`Deleted tab "${deletedPage.name}"`, () => {
          state.pages[deletedId] = deletedPage;
          state.activePage = deletedId;
          saveState();
          renderAll();
        });
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
      const previousProgress = page.progress;
      page.progress = {};
      saveState();
      renderAll();
      showUndoBanner(`Progress reset for "${page.name}"`, () => {
        page.progress = previousProgress;
        saveState();
        renderAll();
      });
    }),
  );

  section2.appendChild(
    createMenuItem("✓", "Select all", () => {
      const previousProgress = { ...page.progress };
      const now = new Date().toISOString();
      for (const champ of champions) {
        // Keep the original timestamp of champions already marked
        if (!page.progress[champ.id]) page.progress[champ.id] = now;
      }
      saveState();
      renderAll();
      showUndoBanner(`Marked all champions on "${page.name}"`, () => {
        page.progress = previousProgress;
        saveState();
        renderAll();
      });
      window.Celebrations?.check(champions, page.progress, null);
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
              // Older export files store booleans; stamp them with today
              migrateProgressTimestamps(imported);
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

function setRegionCount(el, { done, total }) {
  el.textContent = `${done}/${total} done`;
  el.classList.toggle("complete", total > 0 && done === total);
}

// Refreshes every progress count shown in the UI (dropdown options,
// harmony badges, region section headers) without re-rendering the grid.
function refreshFilterCounts() {
  populateFilterOptions();
  renderActiveFilters();
  document
    .querySelectorAll(".region-section[data-champ-ids]")
    .forEach((section) => {
      const countEl = section.querySelector(".region-count");
      if (!countEl) return;
      const ids = section.dataset.champIds.split(",").filter(Boolean);
      setRegionCount(countEl, filterProgressCounts(ids));
    });
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

    return champList.filter((champ) =>
      fuzzyMatchesName(filterState.search, champ.name),
    );
  }

  // Hides done champions after counts are computed so hiding doesn't skew
  // them. Ordering itself comes from championOrder (see applySort).
  function applyViewOptions(champList) {
    if (!filterState.hideCompleted) return champList;
    return champList.filter((champ) => !progress[champ.id]);
  }

  // If no globetrotter filters selected, show all champions with harmony/search filters
  if (filterState.globetrotter.length === 0) {
    let filteredChampions = orderedChampions();
    filteredChampions = filterBySearch(filteredChampions);
    filteredChampions = filterByHarmony(filteredChampions);
    filteredChampions = applyViewOptions(filteredChampions);

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
      let filterChampions = orderedChampions().filter((champ) =>
        filterData.champions.includes(champ.id),
      );
      filterChampions = filterBySearch(filterChampions);
      filterChampions = filterByHarmony(filterChampions);

      // Create filter section; remember the shown champion ids so the
      // header count can be refreshed in place when a card is toggled.
      const filterSection = document.createElement("div");
      filterSection.className = "region-section";
      filterSection.dataset.champIds = filterChampions
        .map((c) => c.id)
        .join(",");

      // Create filter header with badge
      const filterHeader = document.createElement("div");
      filterHeader.className = "region-header";

      const filterBadge = document.createElement("div");
      filterBadge.className = "filter-badge filter-badge-region";
      const crest = createRegionCrest(selectedFilter, "region-crest");
      if (crest) filterBadge.appendChild(crest);
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

      // Show progress for this filter
      const filterCount = document.createElement("span");
      filterCount.className = "region-count";
      setRegionCount(
        filterCount,
        filterProgressCounts(filterChampions.map((c) => c.id)),
      );
      filterHeader.appendChild(filterCount);

      filterSection.appendChild(filterHeader);

      // Create grid for this filter
      const filterGrid = document.createElement("div");
      filterGrid.className = "champion-grid-region";

      applyViewOptions(filterChampions).forEach((champ) => {
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
  populateFilterOptions();
  renderActiveFilters();
  renderScanResults();
  renderChampions();
  renderHistory();
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

  let count = null;
  const filterData =
    type === "harmony" ? HARMONY_FILTERS[value] : GLOBETROTTER_FILTERS[value];
  if (filterData) {
    count = document.createElement("span");
    count.className = "filter-badge-count";
    const progress = filterProgressCounts(filterData.champions);
    count.textContent = `${progress.done}/${progress.total}`;
  }

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
  if (count) badge.appendChild(count);
  badge.appendChild(remove);
  return badge;
}

// Progress on the active page for the champions in a filter's list,
// counted against the current roster (filter lists may lag a patch).
function filterProgressCounts(champIds) {
  const progress = state.pages[state.activePage]?.progress || {};
  let done = 0;
  let total = 0;
  for (const champ of champions) {
    if (!champIds.includes(champ.id)) continue;
    total++;
    if (progress[champ.id]) done++;
  }
  return { done, total };
}

function filterOptionLabel(filterName, filterData) {
  const { done, total } = filterProgressCounts(filterData.champions);
  return total ? `${filterName} (${done}/${total})` : filterName;
}

// Repopulates dropdown options (with progress counts); safe to call on
// every render.
function populateFilterOptions() {
  const globetrotterSelect = document.getElementById("filter-region");
  const harmonySelect = document.getElementById("filter-properties");
  if (!globetrotterSelect || !harmonySelect) return;

  // Populate globetrotter dropdown
  const globetrotterFilters = Object.keys(GLOBETROTTER_FILTERS).sort();
  globetrotterSelect.innerHTML =
    '<option value="" disabled selected>Add Globetrotter Filter</option>';
  globetrotterFilters.forEach((filterName) => {
    const opt = document.createElement("option");
    opt.value = filterName;
    opt.textContent = filterOptionLabel(
      filterName,
      GLOBETROTTER_FILTERS[filterName],
    );
    globetrotterSelect.appendChild(opt);
  });

  // Populate harmony dropdown
  const harmonyFilters = Object.keys(HARMONY_FILTERS).sort();
  harmonySelect.innerHTML =
    '<option value="" disabled selected>Add Harmony Filter</option>';
  harmonyFilters.forEach((filterName) => {
    const opt = document.createElement("option");
    opt.value = filterName;
    opt.textContent = filterOptionLabel(
      filterName,
      HARMONY_FILTERS[filterName],
    );
    harmonySelect.appendChild(opt);
  });
}

// Keeps the sort controls and hide-completed button in sync with filterState.
function syncViewControls() {
  const sortSelect = document.getElementById("filter-sort");
  const sortDirBtn = document.getElementById("filter-sort-dir");
  const hideDoneBtn = document.getElementById("filter-hide-done");
  if (sortSelect) sortSelect.value = filterState.sortKey;
  if (sortDirBtn) {
    const ascending = filterState.sortDir === "asc";
    sortDirBtn.textContent = ascending ? "↑" : "↓";
    sortDirBtn.setAttribute(
      "aria-label",
      `Sort direction: ${ascending ? "ascending" : "descending"}`,
    );
  }
  if (hideDoneBtn) {
    hideDoneBtn.classList.toggle("active", filterState.hideCompleted);
    hideDoneBtn.setAttribute("aria-pressed", String(filterState.hideCompleted));
  }
}

// Wires filter control listeners exactly once (re-running this on every
// render used to stack duplicate listeners and re-render per keystroke).
(function initFilterControls() {
  const searchInput = document.getElementById("filter-search");
  const globetrotterSelect = document.getElementById("filter-region");
  const harmonySelect = document.getElementById("filter-properties");
  const sortSelect = document.getElementById("filter-sort");
  const sortDirBtn = document.getElementById("filter-sort-dir");
  const hideDoneBtn = document.getElementById("filter-hide-done");
  const resetBtn = document.getElementById("filter-reset");

  const searchClearBtn = document.getElementById("filter-search-clear");
  if (!searchInput || !globetrotterSelect || !harmonySelect || !searchClearBtn)
    return;

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

  // Each sort action re-sorts the current order in place (stable), so
  // earlier sorts survive as tie-breakers.
  sortSelect?.addEventListener("change", (e) => {
    filterState.sortKey = e.target.value;
    applySort();
    renderChampions();
  });

  sortDirBtn?.addEventListener("click", () => {
    filterState.sortDir = filterState.sortDir === "asc" ? "desc" : "asc";
    syncViewControls();
    applySort();
    renderChampions();
  });

  hideDoneBtn?.addEventListener("click", () => {
    filterState.hideCompleted = !filterState.hideCompleted;
    syncViewControls();
    renderChampions();
  });

  resetBtn.addEventListener("click", () => {
    filterState = {
      search: "",
      globetrotter: [],
      harmony: [],
      hideCompleted: false,
      sortKey: "name",
      sortDir: "asc",
    };
    resetSortOrder();
    searchInput.value = "";
    searchClearBtn.style.display = "none";
    syncViewControls();
    renderActiveFilters();
    renderChampions();
  });
})();

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

// The secondary toggles (✨ effects, 🔍 summoner search) live in a drawer
// behind the ⚙ settings button; only the theme toggle stays standalone.
let settingsOpen = false;

function applySettingsDrawerState() {
  const gear = document.querySelector("#theme-switcher .settings-toggle");
  const drawer = document.querySelector("#theme-switcher .settings-drawer");
  if (!gear || !drawer) return;
  gear.classList.toggle("open", settingsOpen);
  gear.setAttribute("aria-expanded", String(settingsOpen));
  drawer.classList.toggle("open", settingsOpen);
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

  // Settings button — expands the drawer with the remaining toggles.
  // Toggling classes (instead of re-rendering) lets the CSS transition play;
  // re-renders recreate the drawer already in its final state, so the
  // animation doesn't replay when a toggle inside is clicked.
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "settings-toggle" + (settingsOpen ? " open" : "");
  settingsBtn.textContent = "⚙";
  settingsBtn.title = "Settings";
  settingsBtn.setAttribute("aria-haspopup", "true");
  settingsBtn.setAttribute("aria-expanded", String(settingsOpen));
  settingsBtn.onclick = () => {
    settingsOpen = !settingsOpen;
    applySettingsDrawerState();
  };
  // A small dot nudges returning users that the guide has unseen features.
  if (typeof featuresHasNew === "function" && featuresHasNew()) {
    const dot = document.createElement("span");
    dot.className = "settings-new-dot";
    dot.title = "New features — see the ❔ guide";
    settingsBtn.appendChild(dot);
  }
  bar.appendChild(settingsBtn);

  const drawer = document.createElement("div");
  drawer.className = "settings-drawer" + (settingsOpen ? " open" : "");

  // Features & guide button — opens the guide overlay (marks it seen).
  const guideBtn = document.createElement("button");
  guideBtn.className = "guide-toggle";
  guideBtn.textContent = "❔";
  guideBtn.title = "Features & guide";
  guideBtn.onclick = () => {
    settingsOpen = false;
    applySettingsDrawerState();
    openFeaturesOverlay();
    renderThemeSwitcher();
  };
  drawer.appendChild(guideBtn);

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
  drawer.appendChild(animBtn);

  // Summoner search toggle button
  const summonerVisible =
    localStorage.getItem("lol_summoner_search") === "true";
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
  drawer.appendChild(summonerBtn);

  // Champion quote toggle button
  const quotesOn = localStorage.getItem("lol_quotes") === "true";
  const quotesBtn = document.createElement("button");
  quotesBtn.className = "quotes-toggle" + (quotesOn ? "" : " disabled");
  quotesBtn.textContent = "🔊";
  quotesBtn.title = `Champion quotes: ${
    quotesOn ? "On" : "Off"
  } (click to toggle)`;
  quotesBtn.onclick = () => {
    localStorage.setItem("lol_quotes", String(!quotesOn));
    renderThemeSwitcher();
  };
  drawer.appendChild(quotesBtn);

  // Screenshot scan button — opens the paste/drop overlay. Global Ctrl+V works
  // without it, but this makes the feature discoverable and offers a file picker.
  const scanBtn = document.createElement("button");
  scanBtn.className = "scan-toggle";
  scanBtn.textContent = "📷";
  scanBtn.title = "Scan a champion-select screenshot for available champions";
  scanBtn.onclick = () => {
    settingsOpen = false;
    applySettingsDrawerState();
    openScanOverlay();
  };
  drawer.appendChild(scanBtn);

  bar.appendChild(drawer);
}

// Close the settings drawer on outside click or Escape.
(function initSettingsDrawer() {
  document.addEventListener("mousedown", (e) => {
    if (!settingsOpen) return;
    if (e.target.closest("#theme-switcher")) return;
    settingsOpen = false;
    applySettingsDrawerState();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsOpen) {
      settingsOpen = false;
      applySettingsDrawerState();
    }
  });
})();
