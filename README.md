# Pure Mountain Weather — Soča / Bovec wind board

A single web page showing **observed** wind (no forecasts) for the Bovec / Soča
paragliding & skydiving launches, for go / no-go decisions.

- `index.html` — the board. Reads `data.json` on load and every 5 minutes.
  Map with wind barbs, sortable station list, history chart, unit toggle
  (default m/s), and caution/danger thresholds. If `data.json` is missing or
  older than ~30 min it shows a clearly-labelled **MODEL** wind from Open-Meteo
  ("MODEL — not observed") so the page is never blank.
- `data.json` — the observed data, refreshed automatically (see below).
- `collector.js` — headless-browser collector: pulls skytech.si launch
  anemometers + ARSO high stations, converts to the board's format, writes
  `data.json`.
- `.github/workflows/refresh.yml` — runs the collector on GitHub's servers
  every 15 min during daylight and commits the fresh `data.json`. No laptop
  needed.

## How the auto-refresh works
GitHub Actions runs `collector.js` on a schedule (every 15 min, ~06:00–22:00
Bovec time). It writes a new `data.json` and commits it. GitHub Pages serves
the new file; the open page picks it up within 5 minutes.

## Pause / resume the auto-refresh
- **Pause:** GitHub repo → **Actions** tab → "Refresh wind data" → **⋯ / Disable workflow**.
- **Resume:** same place → **Enable workflow**.
- **Run once now:** Actions tab → "Refresh wind data" → **Run workflow**.

## Run the collector locally (optional)
```
npm install
npx playwright install chromium
node collector.js
```
