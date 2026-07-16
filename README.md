# LoL Champion Checklist

Track champion progress for Arena challenges (or any custom grind) with tabs, filters, and local saves.

Live site: https://zachitf.github.io/lol-champion-checklist/

## What this app does

- Tracks champion completion per tab/page
- Supports multiple pages (for different goals/accounts)
- Filters by Globetrotter and Harmony groups
- Shows each champion's Globetrotter region (with official crest) and Harmony
  groups on hover, keyboard focus, or long-press (touch)
- Celebrates milestones with confetti (100%, finishing a region, finishing a
  starting letter)
- Exports/imports tab progress as JSON
- Stores everything in browser local storage

## Run locally

No build step is required.

1. Clone the repo
2. Open `index.html` in your browser

Optional: run with a local static server.

```bash
npx serve .
```

## Riot API key (dev only)

The Arena import button reads the key from local-only sources.

### Option A: browser local storage

```js
localStorage.setItem("lol_riot_api_key", "RGAPI-...");
```

Remove it later:

```js
localStorage.removeItem("lol_riot_api_key");
```

### Option B: one-time URL param

Open the app once with:

```text
http://localhost:3000/?api=RGAPI-...
```

The key is saved to local storage and the `api` param is removed from the URL.

### Option C: local config file

Copy `config.local.example.js` to `config.local.js` and set:

```js
window.APP_CONFIG = {
	RIOT_API_KEY: "RGAPI-...",
};
```

`config.local.js` is git-ignored.

## GitHub Pages + API keys

GitHub Pages is static hosting. Any key used directly by frontend JavaScript is public.

If you want public usage, put Riot API calls behind a backend/proxy (Cloudflare Worker, Netlify Function, etc.) and keep the key there.

## Updating filter data

Filter data is generated into:

- `data/globetrotter-filters.js`
- `data/harmony-filters.js`

Run:

```bash
npm run update-data
```

If the League client is running, the script pulls the live challenge champion
lists from the LCU API and refreshes `scripts/reference-challenge-data.json`
first — do this after new champion releases. Without the client it falls back
to the committed snapshot. See `data/README.md` for details.

## Repo structure

- `index.html` — app shell
- `script.js` — main app logic
- `style.css` — styling
- `data/` — generated filter files
- `scripts/` — data generation scripts

## Related tools

- https://github.com/AlexDerr/ChallengeComps
- https://tahm-ken.ch/team_builder
