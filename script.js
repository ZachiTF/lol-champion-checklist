// --- CONFIG ---
const PATCH = "14.2.1";
const LANG = "en_US";

const CHAMPION_JSON_URL =
    `https://ddragon.leagueoflegends.com/cdn/${PATCH}/data/${LANG}/champion.json`;
const CHAMPION_ICON_BASE =
    `https://ddragon.leagueoflegends.com/cdn/${PATCH}/img/champion/`;

const STORAGE_KEY = "lol_pages";

// --- STATE ---
let state = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {
    activePage: null,
    pages: {}
};

let champions = [];

// --- ELEMENTS ---
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
        progress: {}
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
    progressText.textContent = `Progress: ${done} / ${champions.length}`;
}

function renderTabs() {
    tabsBar.innerHTML = "";

    for (const [id, page] of Object.entries(state.pages)) {
        const tab = document.createElement("div");
        tab.className = "tab" + (id === state.activePage ? " active" : "");
        tab.textContent = page.name;

        tab.onclick = () => {
            state.activePage = id;
            saveState();
            renderAll();
        };

        tabsBar.appendChild(tab);
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

    champions.forEach(champ => {
        if (!(champ.id in progress)) {
            progress[champ.id] = false;
        }
        grid.appendChild(createChampionCard(champ));
    });

    saveState();
    updateProgressText();
}

function renderAll() {
    renderTabs();
    renderChampions();
}

// --- MAIN ---
fetch(CHAMPION_JSON_URL)
    .then(res => res.json())
    .then(data => {
        champions = Object.values(data.data)
            .sort((a, b) => a.name.localeCompare(b.name));

        if (Object.keys(state.pages).length === 0) {
            createPage("Default");
        }

        renderAll();
    })
    .catch(err => {
        progressText.textContent = "Failed to load champion data.";
        console.error(err);
    });
