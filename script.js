// --- CONFIG ---
const PATCH = "14.2.1"; // can be updated anytime
const LANG = "en_US";

const CHAMPION_JSON_URL =
    `https://ddragon.leagueoflegends.com/cdn/${PATCH}/data/${LANG}/champion.json`;
const CHAMPION_ICON_BASE =
    `https://ddragon.leagueoflegends.com/cdn/${PATCH}/img/champion/`;

const STORAGE_KEY = "lol_champion_progress";

// --- STATE ---
let progress = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};

// --- ELEMENTS ---
const grid = document.getElementById("champion-grid");
const progressText = document.getElementById("progress");

// --- FUNCTIONS ---
function saveProgress() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
}

function updateProgressText(total) {
    const done = Object.values(progress).filter(Boolean).length;
    progressText.textContent = `Progress: ${done} / ${total}`;
}

function createChampionCard(champ) {
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

    div.addEventListener("click", () => {
        progress[champ.id] = !progress[champ.id];
        div.classList.toggle("done");
        saveProgress();
        updateProgressText(window.totalChampions);
    });

    return div;
}

// --- MAIN ---
fetch(CHAMPION_JSON_URL)
    .then(res => res.json())
    .then(data => {
        const champions = Object.values(data.data);
        window.totalChampions = champions.length;

        champions
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(champ => {
                if (!(champ.id in progress)) {
                    progress[champ.id] = false;
                }
                grid.appendChild(createChampionCard(champ));
            });

        saveProgress();
        updateProgressText(champions.length);
    })
    .catch(err => {
        progressText.textContent = "Failed to load champion data.";
        console.error(err);
    });