// App bootstrap: theme/animation init and the Data Dragon champion-data load.


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
    resetSortOrder();

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
