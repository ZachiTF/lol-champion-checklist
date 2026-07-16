#!/usr/bin/env node

/**
 * Update Champion Filter Data
 *
 * Generates data/globetrotter-filters.js and data/harmony-filters.js.
 *
 * Data source (in order of preference):
 *  1. The running League client (LCU API) — authoritative, resolved live by
 *     Riot's challenge service. Refreshes scripts/reference-challenge-data.json.
 *  2. The committed scripts/reference-challenge-data.json snapshot.
 *
 * With the League client open, this also refreshes the snapshot so new
 * champions (e.g. new releases) are picked up automatically.
 *
 * Run: npm run update-data
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// LCU challenge id -> reference key (keys are the historical names used in
// reference-challenge-data.json; matched by id because Riot occasionally
// renames challenges, e.g. 'It Has "Ultimate" In the Name!').
const CHALLENGE_IDS = {
  // Globetrotter (regions)
  303501: "5 Under 5'",
  303502: "All Hands on Deck",
  303503: "FOR DEMACIA",
  303504: "Ice, Ice, Baby",
  303505: "Everybody was Wuju Fighting",
  303506: "Elemental, My Dear Watson",
  303507: "Strength Above All",
  303508: "Calculated",
  303509: "Spooky Scary Skeletons",
  303510: "The Sun Disc Never Sets",
  303511: "Peak Performance",
  303512: "(Inhuman Screeching Sounds)",
  303513: "Chemtech Comrades",
  // Harmony (ability traits)
  303401: "Nowhere to Hide",
  303402: "It Has Ultimate In the Name!",
  303403: "We Protec",
  303404: "They Just... Don't... DIE!",
  303405: "Where'd They Go?",
  303406: "We're Good Over Here",
  303407: "Summoners on the Rift",
  303409: "Get Over Here",
  303410: "It's a Trap!",
  303411: "I'm Helping",
  303412: "Hold That Pose",
  // Classes (Master <class> challenges — same champion lists as Specialist)
  401207: "assassin",
  401208: "fighter",
  401209: "mage",
  401210: "marksman",
  401211: "support",
  401212: "tank",
};

// Category mappings
const GLOBETROTTER_CHALLENGES = {
  "5 Under 5'": "Bandle City",
  "All Hands on Deck": "Bilgewater",
  "FOR DEMACIA": "Demacia",
  Calculated: "Piltover",
  "Spooky Scary Skeletons": "Shadow Isles",
  "The Sun Disc Never Sets": "Shurima",
  "Peak Performance": "Targon",
  "Ice, Ice, Baby": "Freljord",
  "Everybody was Wuju Fighting": "Ionia",
  "Elemental, My Dear Watson": "Ixtal",
  "Strength Above All": "Noxus",
  "(Inhuman Screeching Sounds)": "Void",
  "Chemtech Comrades": "Zaun",
};

const HARMONY_CHALLENGES = {
  "Nowhere to Hide": "Global",
  "It Has Ultimate In the Name!": "Ultimate AOE",
  "We Protec": "Ally Shield/Heal",
  "They Just... Don't... DIE!": "Revive/Immunity",
  "Where'd They Go?": "Stealth",
  "We're Good Over Here": "Poke",
  "Summoners on the Rift": "Summoner",
  fighter: "Fighter",
  mage: "Mage",
  assassin: "Assassin",
  marksman: "Marksman",
  tank: "Tank",
  support: "Support",
  "Get Over Here": "Displacements",
  "It's a Trap!": "Trap",
  "I'm Helping": "Terrain",
  "Hold That Pose": "Crowd Control",
};

const REFERENCE_PATH = path.join(__dirname, "reference-challenge-data.json");

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    require("https")
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// Locate the League client lockfile (contains the LCU port and password).
function findLockfile() {
  const candidates = [
    process.env.LCU_LOCKFILE,
    "/mnt/c/Riot Games/League of Legends/lockfile", // WSL
    "C:\\Riot Games\\League of Legends\\lockfile", // Windows
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* permission issues on /mnt/c when Windows locks the file */
    }
  }
  return null;
}

// Fetch the local player's challenge data from the running League client.
// The LCU listens on Windows loopback only, so under WSL we call the
// Windows-native curl.exe, which runs on the Windows side of the boundary.
function fetchLcuChallenges() {
  const lockfilePath = findLockfile();
  if (!lockfilePath) return null;

  let lockfile;
  try {
    lockfile = fs.readFileSync(lockfilePath, "utf8");
  } catch {
    return null; // client not running (file locked/gone)
  }
  const [, , port, password] = lockfile.trim().split(":");
  const url = `https://127.0.0.1:${port}/lol-challenges/v1/challenges/local-player`;
  const isWsl = process.platform === "linux" && fs.existsSync("/mnt/c");
  const curl = isWsl ? "curl.exe" : "curl";

  try {
    const out = execFileSync(
      curl,
      ["-s", "-k", "-m", "20", "-u", `riot:${password}`, url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
    );
    const data = JSON.parse(out.toString("utf8"));
    return typeof data === "object" && data !== null ? data : null;
  } catch {
    return null;
  }
}

async function main() {
  // Champion roster from Data Dragon: numeric key -> ddragon id, and the
  // full roster for the coverage report.
  const versions = await httpsGetJson(
    "https://ddragon.leagueoflegends.com/api/versions.json",
  );
  const patch = versions[0];
  const championJson = await httpsGetJson(
    `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`,
  );
  const numericToId = {};
  const allChampionIds = new Set();
  Object.values(championJson.data).forEach((c) => {
    numericToId[c.key] = c.id;
    allChampionIds.add(c.id);
  });
  console.log(`Data Dragon ${patch}: ${allChampionIds.size} champions\n`);

  // Try the live source first.
  let referenceData;
  const lcu = fetchLcuChallenges();
  if (lcu) {
    console.log("League client detected — using live challenge data (LCU)\n");
    referenceData = {};
    const skipped = new Set();
    for (const [challengeId, refKey] of Object.entries(CHALLENGE_IDS)) {
      const challenge = lcu[challengeId];
      if (!challenge || !Array.isArray(challenge.availableIds)) {
        console.warn(`  ! challenge ${challengeId} (${refKey}) missing in LCU data — keeping old list`);
        continue;
      }
      const ids = [];
      challenge.availableIds.forEach((num) => {
        const id = numericToId[num];
        if (id) ids.push(id);
        else skipped.add(num); // special game-mode variants etc.
      });
      referenceData[refKey] = ids.sort();
    }
    if (skipped.size) {
      console.log(`  (ignored non-roster champion ids: ${[...skipped].join(", ")})\n`);
    }
    // Preserve any lists the LCU couldn't provide.
    const old = JSON.parse(fs.readFileSync(REFERENCE_PATH, "utf8"));
    for (const [key, list] of Object.entries(old)) {
      if (!referenceData[key]) referenceData[key] = list;
    }
    fs.writeFileSync(
      REFERENCE_PATH,
      JSON.stringify(referenceData, null, 2) + "\n",
      "utf8",
    );
    console.log(`✓ Refreshed snapshot: ${REFERENCE_PATH}\n`);
  } else {
    console.log(
      "League client not running — using committed snapshot.\n" +
        "(Start the League client and rerun to pull live challenge data.)\n",
    );
    referenceData = JSON.parse(fs.readFileSync(REFERENCE_PATH, "utf8"));
  }

  // Coverage report: champions not in any group. Unaffiliated champions
  // (e.g. Runeterra natives) legitimately have no Globetrotter region.
  const covered = new Set();
  Object.values(referenceData).forEach((list) =>
    list.forEach((id) => covered.add(id)),
  );
  const uncovered = [...allChampionIds].filter((id) => !covered.has(id)).sort();
  if (uncovered.length) {
    console.log(`Champions in no challenge group: ${uncovered.join(", ")}\n`);
  }

  // Build Globetrotter filters
  const globetrotterFilters = {};
  Object.entries(GLOBETROTTER_CHALLENGES).forEach(
    ([challengeName, displayName]) => {
      if (referenceData[challengeName]) {
        globetrotterFilters[displayName] = {
          description: challengeName,
          champions: referenceData[challengeName].sort(),
        };
      }
    },
  );

  // Build Harmony filters
  const harmonyFilters = {};
  Object.entries(HARMONY_CHALLENGES).forEach(
    ([challengeName, displayName]) => {
      if (referenceData[challengeName]) {
        harmonyFilters[displayName] = {
          description: challengeName,
          champions: referenceData[challengeName].sort(),
        };
      }
    },
  );

  // Display stats
  console.log(
    `Globetrotter Filters (${Object.keys(globetrotterFilters).length}):`,
  );
  Object.entries(globetrotterFilters).forEach(([name, data]) => {
    console.log(`  ${name}: ${data.champions.length} champions`);
  });

  console.log(`\nHarmony Filters (${Object.keys(harmonyFilters).length}):`);
  Object.entries(harmonyFilters).forEach(([name, data]) => {
    console.log(`  ${name}: ${data.champions.length} champions`);
  });

  writeFilterFile(
    path.join(__dirname, "..", "data", "globetrotter-filters.js"),
    "GLOBETROTTER_FILTERS",
    globetrotterFilters,
  );
  writeFilterFile(
    path.join(__dirname, "..", "data", "harmony-filters.js"),
    "HARMONY_FILTERS",
    harmonyFilters,
  );
}

function writeFilterFile(filePath, constName, filters) {
  let output = `// Auto-generated from curated challenge reference data
// Last updated: ${new Date().toISOString()}
// Run: npm run update-data

const ${constName} = {\n`;

  Object.entries(filters)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([filterName, filterData]) => {
      output += `  "${filterName}": {\n`;
      output += `    description: "${filterData.description}",\n`;
      output += `    champions: [\n`;
      filterData.champions.forEach((champId, idx) => {
        output += `      "${champId}"`;
        if (idx < filterData.champions.length - 1) output += ",";
        output += "\n";
      });
      output += `    ],\n`;
      output += `  },\n`;
    });

  output += `};\n`;
  fs.writeFileSync(filePath, output, "utf8");
  console.log(`✓ Generated: ${filePath}`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  console.error(error.stack);
  process.exit(1);
});
