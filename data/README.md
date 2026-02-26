# Champion Metadata

This directory contains generated JavaScript filter files used by the LoL Champion Checklist UI.

## Files

### `globetrotter-filters.js`
Maps challenge category names (region-style buckets) to champion ID lists.

**Structure:**
```js
{
  "Region Name": {
    description: "Source challenge name",
    champions: ["ChampionId1", "ChampionId2"]
  },
  ...
}
```

**Regions:**
- Bandle City
- Bilgewater
- Demacia
- Freljord
- Icathia
- Ionia
- Ixtal
- Noxus
- Piltover
- Runeterra
- Shadow Isles
- Shurima
- Targon
- Void
- Zaun

### `harmony-filters.js`
Defines champion properties/classes that can be used as filters.

**Structure:**
```js
{
  "PropertyName": {
    description: "Source challenge name",
    champions: ["ChampionId1", "ChampionId2", ...]
  },
  ...
}
```

**Current Properties:**
- **Arena God**: Champions in the Arena God challenge
- **Global Ultimate**: Champions with map-wide ultimate abilities
- **Manaless**: Champions that do not use mana
- **Percent Health Damage**: Champions dealing damage based on enemy max health
- **Pet/Summon**: Champions that summon units or pets
- **Revive**: Champions that can revive themselves or allies
- **Shapeshifter**: Champions that can transform or change forms
- **Stealth**: Champions with invisibility or camouflage abilities
- **True Damage**: Champions with true damage abilities

## Maintenance

These files are generated from `scripts/reference-challenge-data.json` by:

```bash
npm run update-data
```

To change mappings or labels, update:
- `scripts/reference-challenge-data.json`
- challenge label maps inside `scripts/update-champion-data.js`

## Notes

- Champion IDs must match Riot Data Dragon champion IDs
- Filter names are displayed as-is in the UI
- Filters are sorted alphabetically when generated
