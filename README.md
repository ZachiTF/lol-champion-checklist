# LoL Champion Checklist

Track champion progress for Arena challenges (or any custom grind) with tabs, filters, and local saves.

Live site: https://zachitf.github.io/lol-champion-checklist/

## What this app does

- Tracks champion completion per tab/page
- Supports multiple pages (for different goals/accounts)
- Filters by Globetrotter and Harmony groups, with done/total progress
  counts per filter (dropdowns, badges, and region section headers)
- Hide-completed toggle and sorting by name, completion, or done date —
  ascending/descending, applied in place with a stable sort so chained
  sorts keep the previous order as tie-breaker
- Fuzzy champion search — punctuation-insensitive ("khazix" finds Kha'Zix)
  with subsequence fallback ("mfort" finds Miss Fortune)
- Progress history chart with per-day bars, a cumulative total line, and
  gridlines
- Undo for destructive actions (reset progress, delete tab, select all)
  instead of confirm dialogs — via a transient banner and a persistent
  entry in the tab menu
- Shows each champion's Globetrotter region (with official crest), Harmony
  groups, and completion date on hover, keyboard focus, or long-press (touch)
- Celebrates milestones with confetti (100%, finishing a region, finishing a
  starting letter)
- Optional champion quotes: with the 🔊 toggle on, marking a champion plays
  one of its select/ban voice lines (Community Dragon audio, no API key);
  off by default
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

- `index.html` — app shell (loads the `src/` scripts in order)
- `src/` — app logic, split by concern (classic scripts sharing globals, no build step):
  - `scan-core.js` — pure screenshot-scan pipeline math (also runs in Node; unit-tested). Locates the ARAM client/bench/circles anywhere in the frame and at any scale — a full-desktop print screen works, even with the client windowed over a busy background (browser chrome, other champion grids), by finding the bench through periodicity + champion content rather than fixed positions
  - `scan-ui.js` — scan overlay, paste/drop, icon hashing, the "Available now" group
  - `state.js` · `champions.js` · `render.js` · `history.js` · `riot-api.js` · `main.js`
- `style.css` — styling
- `scan-debug.html` — interactive debugger for the screenshot-scan pipeline
- `test/` — `node:test` regression tests + fixtures (run with `npm test`)
- `data/` — generated filter files
- `scripts/` — data generation scripts
- `vendor/` — vendored third-party libraries (canvas-confetti; the jsdelivr
  auto-minified build serves varying bytes per edge node, breaking SRI)

## Development

The app itself needs no build step. For contributing, one-time per clone:

```bash
npm install            # dev tools: pngjs (tests) + prettier (formatting)
npm run hooks:install  # activate the pre-commit hook (sets core.hooksPath)
```

The pre-commit hook runs `npm run format:check` and `npm test`, blocking the
commit if either fails. Run them directly any time; `npm run format` rewrites
files to the Prettier style. (Users of the Python
[pre-commit](https://pre-commit.com) framework can `pre-commit install`
instead — `.pre-commit-config.yaml` enforces the same two checks.)

## Related tools

- https://github.com/AlexDerr/ChallengeComps
- https://tahm-ken.ch/team_builder
