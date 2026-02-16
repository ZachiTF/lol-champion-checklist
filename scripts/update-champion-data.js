#!/usr/bin/env node

/**
 * Update Champion Filter Data from Reference Challenge Data
 *
 * This script generates globetrotter-filters.js and harmony-filters.js
 * using curated reference data from the League of Legends challenges.
 *
 * Run: node scripts/update-champion-data.js
 */

const fs = require("fs");
const path = require("path");

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

async function main() {
  try {
    console.log("Loading reference challenge data...\n");

    // Load reference data with accurate champion lists
    const referencePath = path.join(__dirname, "reference-challenge-data.json");
    const referenceData = JSON.parse(fs.readFileSync(referencePath, "utf8"));

    console.log(
      `Loaded ${Object.keys(referenceData).length} challenge champion lists\n`,
    );

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

    // Generate globetrotter-filters.js
    const globetrotterPath = path.join(
      __dirname,
      "..",
      "data",
      "globetrotter-filters.js",
    );

    let globetrotterOutput = `// Auto-generated from curated challenge reference data
// Last updated: ${new Date().toISOString()}
// Run: npm run update-data

const GLOBETROTTER_FILTERS = {\n`;

    Object.entries(globetrotterFilters)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([filterName, filterData]) => {
        globetrotterOutput += `  "${filterName}": {\n`;
        globetrotterOutput += `    description: "${filterData.description}",\n`;
        globetrotterOutput += `    champions: [\n`;

        filterData.champions.forEach((champId, idx) => {
          globetrotterOutput += `      "${champId}"`;
          if (idx < filterData.champions.length - 1) globetrotterOutput += ",";
          globetrotterOutput += "\n";
        });

        globetrotterOutput += `    ],\n`;
        globetrotterOutput += `  },\n`;
      });

    globetrotterOutput += `};\n`;
    fs.writeFileSync(globetrotterPath, globetrotterOutput, "utf8");

    // Generate harmony-filters.js
    const harmonyPath = path.join(
      __dirname,
      "..",
      "data",
      "harmony-filters.js",
    );

    let harmonyOutput = `// Auto-generated from curated challenge reference data
// Last updated: ${new Date().toISOString()}
// Run: npm run update-data

const HARMONY_FILTERS = {\n`;

    Object.entries(harmonyFilters)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([filterName, filterData]) => {
        harmonyOutput += `  "${filterName}": {\n`;
        harmonyOutput += `    description: "${filterData.description}",\n`;
        harmonyOutput += `    champions: [\n`;

        filterData.champions.forEach((champId, idx) => {
          harmonyOutput += `      "${champId}"`;
          if (idx < filterData.champions.length - 1) harmonyOutput += ",";
          harmonyOutput += "\n";
        });

        harmonyOutput += `    ],\n`;
        harmonyOutput += `  },\n`;
      });

    harmonyOutput += `};\n`;
    fs.writeFileSync(harmonyPath, harmonyOutput, "utf8");

    console.log(`\n✓ Generated: ${globetrotterPath}`);
    console.log(`✓ Generated: ${harmonyPath}\n`);
  } catch (error) {
    console.error("Error:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
