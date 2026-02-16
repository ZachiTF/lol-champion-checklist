# Champion Metadata

This directory contains JSON files that define champion metadata for the LoL Champion Checklist application.

## Files

### `champion-regions.json`
Maps champion IDs to their lore regions.

**Structure:**
```json
{
  "ChampionId": "RegionName",
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

### `champion-properties.json`
Defines champion properties/abilities that can be used as filters.

**Structure:**
```json
{
  "PropertyName": {
    "description": "Description of the property",
    "champions": ["ChampionId1", "ChampionId2", ...]
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

### Adding a New Champion
1. Add the champion to `champion-regions.json` with their region
2. Add the champion to relevant properties in `champion-properties.json`

### Adding a New Property
1. Add a new entry to `champion-properties.json` with:
   - A descriptive name (used in UI)
   - A description
   - An array of champion IDs that have this property

### Adding a New Region
Simply add champions with the new region name to `champion-regions.json`. The application will automatically detect and display it in the filter dropdown.

## Notes

- Champion IDs must match the IDs used by Riot's Data Dragon API
- Property names are displayed as-is in the UI, so use proper capitalization and spacing
- The properties are automatically sorted alphabetically in the filter dropdown
- Regions are automatically sorted alphabetically in the filter dropdown
