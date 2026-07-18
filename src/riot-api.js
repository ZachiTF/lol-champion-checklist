// Riot API: server list, API key handling, and the challenge-import wiring.

// --- SERVER LIST ---
// `value` is the platform routing host (challenges API), `cluster` the
// regional routing host (account-v1 lives only on americas/asia/europe).
const RIOT_SERVERS = [
  { value: "euw1", label: "EUW", cluster: "europe" },
  { value: "na1", label: "NA", cluster: "americas" },
  { value: "br1", label: "BR", cluster: "americas" },
  { value: "eun1", label: "EUNE", cluster: "europe" },
  { value: "kr", label: "KR", cluster: "asia" },
  { value: "jp1", label: "JP", cluster: "asia" },
  { value: "ru", label: "RU", cluster: "europe" },
  { value: "tr1", label: "TR", cluster: "europe" },
  { value: "oc1", label: "OCE", cluster: "americas" },
  { value: "la1", label: "LAN", cluster: "americas" },
  { value: "la2", label: "LAS", cluster: "americas" },
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
      // Riot IDs are "gameName#tagLine"; default the tag to the server label
      // (matches the input placeholder, e.g. "name" on EUW → "name#EUW").
      const serverInfo = RIOT_SERVERS.find((s) => s.value === server);
      const [gameName, tagLine] = summoner.includes("#")
        ? summoner.split("#").map((part) => part.trim())
        : [summoner, serverInfo?.label || ""];
      // Step 1: Riot ID → PUUID (summoner-v4 by-name was removed by Riot)
      const accountRes = await fetch(
        `https://${
          serverInfo?.cluster
        }.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
          gameName,
        )}/${encodeURIComponent(tagLine)}?api_key=${encodeURIComponent(
          apiKey,
        )}`,
      );
      if (!accountRes.ok) throw new Error("Player not found.");
      const accountData = await accountRes.json();
      // Step 2: Get Challenge Progress (Adapt to All Situations, challengeId=303001)
      const challengeRes = await fetch(
        `https://${server}.api.riotgames.com/lol/challenges/v1/player-data/${
          accountData.puuid
        }?api_key=${encodeURIComponent(apiKey)}`,
      );
      if (!challengeRes.ok) throw new Error("Challenge data not found.");
      const challengeData = await challengeRes.json();
      // Find progress for challengeId=303001
      const challenge = (challengeData.challenges || []).find(
        (c) => c.challengeId === 303001,
      );
      if (!challenge) throw new Error("Challenge not found.");
      // `value` is the champion count; `percentile` is a player ranking, not progress
      status.textContent = `Progress: ${challenge.value}${
        challenge.level ? ` (${challenge.level})` : ""
      }`;
      // TODO: Parse and update champion progress here
    } catch (e) {
      status.textContent = e.message || "Error fetching data.";
    }
  };
});
