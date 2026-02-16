# lol-champion-checklist

The checklist can be found at the [github page](https://zachitf.github.io/lol-champion-checklist/)  

**For local use:** Simply open `index.html` in your browser. Progress will be saved in your browser's local storage.

------

A simple checklist to track your personal progress on champions in the video game league of legends.

Can be a handy tool to remember on which champions you have already won in Arena or whatever league/personal challenge you are currently grinding for.

Allows the creation and naming of multiple instances of the list; in case you are grinding on multiple fronts at the same time!

## Features
- Filter champions by region and properties (abilities, mechanics)
- Multiple tracking pages/lists
- Dark/Light theme support
- Import/Export functionality
- Progress tracking with visual indicators

## Data Structure
Champion metadata is stored in `/data` folder:
- `champion-regions.js` - Maps champions to lore regions (auto-generated from Community Dragon)
- `champion-properties.js` - Champion abilities and properties

### Updating Champion Data
To update champion region mappings from Riot's official data:
```bash
npm run update-data
```
This fetches the latest champion data from [Community Dragon](https://communitydragon.org/) and regenerates `champion-regions.js` based on champion faction tags from the challenges API.

## Globetrotter / Harmony

While this tool can filter by some of the challenges, there are tools better tailored for that.

Check out https://github.com/AlexDerr/ChallengeComps and https://tahm-ken.ch/team_builder