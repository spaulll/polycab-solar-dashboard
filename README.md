# Solar Dashboard

A local web dashboard for a Modbus TCP solar inverter: live stats via WebSocket,
historical charts, daily energy log with a cumulative running-total view, and
CSV export. Built for a single home
network — no auth, no HTTPS, no rate limiting, CORS wide open (`*`) on purpose.

Built and iterated with [Claude](https://claude.ai) as a hobby project.

## The inverter

This was built against a **Polycab PSIS-3K6** — a 3.6 kW single-phase on-grid
(grid-tie) solar inverter, part of Polycab's PSIS series. Relevant specs:

- 3.6 kW rated output, transformerless design, IP65-rated enclosure (indoor
  or outdoor install)
- Up to 97.8% max conversion efficiency
- Supports up to 20A string current, compatible with high-wattage TOPCon /
  Mono-PERC panels, and up to 150% DC/PV oversizing
- Connectivity: RS-485 and Wi-Fi/GPRS, with the vendor's own remote monitoring
  via a web portal and mobile app

The register map and polling logic in `inverter.py` (holding registers at
address 4097, 60 registers) are specific to this model/firmware. If you're
adapting this for a different inverter, you'll likely need to remap the
registers — check your inverter's Modbus documentation.

## Why this instead of the vendor app?

Polycab's own app/portal works, but it's built for a generic fleet of
installs, not for tinkering with your own data. A few concrete differences:

- **Actual real-time push, not polling-on-open.** This dashboard holds a
  WebSocket connection and pushes every new reading (default: every 5s) the
  moment it's read from the inverter. The vendor app/portal typically polls
  on its own schedule and often lags behind what the inverter is actually
  doing right now.
- **Full-resolution local history, kept forever.** Every reading is written
  to a local SQLite database you own. No aggregation-then-discard, no "last
  30 days only," no dependency on a cloud service staying online or keeping
  your account active.
- **Data you can actually query and export.** `/api/export` gives you a raw
  CSV of any time range for your own analysis in Excel/pandas/whatever —
  not a PDF report or a chart you can only look at inside someone else's app.
- **No cloud round-trip.** Everything runs on your home network. The
  dashboard doesn't depend on the vendor's servers being up, and your
  production data isn't leaving your LAN to get charted.
- **Purpose-built insights.** The efficiency/conversion-loss panel and
  peak-production stat are computed directly from your own Solar Input vs.
  Inverter Power readings — not a generic fleet-wide metric.
- **It's yours to change.** Want a different chart, a new stat, an alert
  rule? It's a few files of plain Python/HTML you can edit directly, instead
  of waiting on a vendor's app update cycle.

The trade-off: this only works on your local network, has no mobile app
polish, and doesn't include the vendor's remote firmware update or support
tooling — it's a monitoring layer, not a replacement for the vendor app in
every respect.

## Files

```
solar-dashboard/
├── main.py                # FastAPI app: WebSocket, REST endpoints, polling loop, lifecycle
├── solar.py                 # Solar-day sessions & profiles (sunrise-anchored buckets for the charts)
├── inverter.py             # Modbus polling + astral sunrise/sunset night-mode logic
├── database.py              # SQLite schema, background-thread writer, history/summary/CSV queries
├── config.py                # All editable settings (loaded from .env / env vars, see below)
├── .env.example               # Template for your real config -- copy to .env and fill in
├── requirements.txt
└── frontend/
    ├── index.html            # Markup only -- loads styles.css and /js/main.js
    ├── styles.css            # All styling (dark theme)
    ├── js/                   # ES modules, no build step -- served as-is
    │   ├── main.js           # Entry point: boot sequence, event wiring, WS message routing
    │   ├── config.js         # Endpoints and tuning constants (gap threshold, trim sizes, refresh rates)
    │   ├── state.js          # Tiny shared state (selected range, night mode)
    │   ├── api.js            # REST fetchers (history, daily summary, generation summary, status, sun, CSV URL)
    │   ├── ws.js             # WebSocket client with auto-reconnect
    │   ├── charts.js         # Chart.js views (1H/Today/7D/All), gap-breaking, live-point appending, daily bar + cumulative energy charts
    │   ├── insights.js       # Conversion loss / peak / average computations
    │   ├── sun.js            # Sunrise/sunset strip + countdown ticker
    │   ├── ui.js             # Status pills, night banner, stat cards
    │   ├── yield.js          # Average Daily Yield card (range-selectable avg/best/worst day)
    │   └── format.js         # Number/date formatting helpers
    └── vendor/                 # Locally-vendored Chart.js + date adapter (no CDN dependency)
```

The frontend is plain native ES modules — no bundler, no npm, no build step.
`main.py` serves everything, so editing any file under `frontend/` takes effect
on the next browser reload.

## 1. Install dependencies

```bash
cd solar-dashboard
pip install -r requirements.txt
```

## 2. Configure

Copy the example env file and fill in your real values:

```bash
cp .env.example .env
nano .env
```

Set at minimum `INVERTER_IP` and your location (`CITY`, `COUNTRY`, `TIMEZONE`,
`LATITUDE`, `LONGITUDE` -- used for sunrise/sunset night-mode timing). See
`.env.example` for the full list of options and their defaults.

`OPENWEATHER_API_KEY` is optional: when set, OpenWeatherMap is used as the
primary weather provider for the top bar; when missing or empty, the
dashboard automatically uses **Open-Meteo**, which requires no key at all.

`.env` is gitignored and never committed -- keep your real inverter IP and
home coordinates out of version control. `config.py` itself only contains
generic placeholder defaults, safe to publish as-is.

Real environment variables (e.g. set by systemd) always take priority over
`.env`, which takes priority over the hardcoded defaults in `config.py`.

## 3. Run

One command starts the backend **and** serves the frontend:

```bash
python main.py
```

This reads `HOST`/`PORT` from your `.env` (defaults: `0.0.0.0:8000`).
Equivalently: `uvicorn main:app --host 0.0.0.0 --port 8000`.

Then open **http://localhost:8000** (or `http://<machine-ip>:8000` from another
device on your LAN — e.g. your phone). The FastAPI app serves the frontend
directly, so there's no separate frontend server to run.

On first run, `solar_data.db` (SQLite) is created automatically in the working
directory (path controlled by `DB_PATH`). The schema is created via
`database.init_db()`, which runs on startup — no separate migration step needed.


## How it works

- **Polling loop** (`main.py` → `polling_loop()`) runs as an `asyncio` background
  task started in the FastAPI `lifespan` handler. Every `POLL_DELAY` seconds it
  reads the inverter over Modbus, or — if it's currently night per `astral`'s
  sunrise/sunset calculation for your configured location — sleeps until sunrise
  instead of polling.
- **Modbus reads** run via `asyncio.to_thread(...)` since `pymodbus`'s sync
  client is blocking; this keeps the event loop (and WebSocket broadcasts)
  responsive.
- **Every reading** is hashed off to a background thread (`database.py`) via a
  `queue.Queue`, so SQLite writes never block the polling loop.
- **WebSocket clients** (`/ws`) get every new reading pushed immediately, plus
  an `init` message on connect with the latest known state (including inverter
  health) so the UI isn't blank while waiting for the next tick.
- **Powercut tracking** uses dual detection. *Hard Modbus failures* still use
  the consecutive-error threshold (`POWERCUT_ERROR_THRESHOLD`): once crossed, a
  powercut is recorded only when both the check IP and the inverter IP are
  unreachable (check IP up → glitch; check IP down but inverter still answering
  → keep waiting). Additionally, *successful reads* that report both
  `Solar_Input ≤ 0.1` **and** `Inverter_Power ≤ 0.1` are treated as the start of
  a powercut when the check IP is also unreachable — this catches the window
  where the inverter still answers Modbus on residual power but produces
  nothing. A small non-zero `Solar_Input` with a zero `Inverter_Power` (low
  light) is intentionally ignored. The zero-production signal must repeat for
  `POWERCUT_ZERO_THRESHOLD` consecutive reads (default 3) before a row is
  opened. The next successful read showing real
  production closes the open row with a computed duration. Errors during night
  mode are ignored, and an open row survives app/host restarts — so offline
  episodes are recorded even when the dashboard machine itself loses power.
  The Inverter Status card shows the live state (Online / Unreachable + offline
  timer / Night mode) and a powercut count per selected range.
- **Historical/aggregate/CSV endpoints** query SQLite directly and are safe to
  call anytime, independent of the live polling loop.
- **Solar-day views** (`solar.py`): the Today/7D/All charts are shaped around
  solar days — per-date sunrise/sunset windows come from `inverter.py`'s
  astral calculation, sessions are bucketed relative to each day's sunrise,
  and the long-term profile is aggregated inside SQLite. Raw readings are
  never modified; this is purely a read-side view.
- **Average Daily Yield card**: in the sidebar (between Inverter Status and
  Insights), one panel stacking Average / Best Day / Worst Day. Two date
  inputs in the panel head select the range; both are constrained via
  `min`/`max` attributes to `[first day with data … today]` as reported by
  `/api/generation/stats` (`min_date`/`max_date`). The default range is the
  last 30 days ending today, applied server-side on first load and then
  synced into the inputs — so short histories simply start at their first
  day instead of erroring. Only days that actually have generation data are
  counted; gaps in the range never dilute the average. Refreshes on the same
  cadence as the Daily Energy Log and immediately after night mode ends.
- **Generation KPI strip**: a six-card strip under the live stat cards showing
  Today / Yesterday / This Week / This Month / This Year, plus a wider
  Lifetime card that shows **both** lifetime figures: Calculated Production
  (primary — the sum of daily totals stored in this dashboard, including
  today's live reading) and Inverter Lifetime (secondary — the running total
  reported directly by the inverter). The two can differ slightly (partial
  days, reset timing, rounding, or data recorded before the dashboard
  started); hovering the card (or its `*`) shows a tooltip explaining this. Values ≥ 1 MWh are shown as MWh. The strip is fetched on page load
  and refreshed on the same cadence as the Daily Energy Log (every
  `DAILY_SUMMARY_REFRESH_MS`, day mode only), plus immediately when the
  inverter wakes up from night mode.

- **Weather chip** (`weather.py` + `frontend/js/weather.js`): a small
  icon+temperature chip in the top bar — no permanent weather card. Clicking
  it opens a popup (with a dimmed, backdrop-blurred background; click the
  backdrop, the × button, or Escape to close) showing current conditions,
  feels-like/humidity/wind/cloud cover, today's high/low, rain chance and a
  compact multi-hour forecast, with a small note of which provider answered.
  The backend tries OpenWeatherMap first when `OPENWEATHER_API_KEY` is set,
  otherwise falls back to Open-Meteo (no key needed) automatically, caches
  results for 15 minutes, and maps both providers' codes onto one shared icon
  set. If weather is unavailable the chip shows a grayed-out `–°` and the
  popup stays disabled.

## REST API

| Endpoint | Description |
|---|---|
| `GET /api/history?range=1h\|today\|24h\|7d\|all` | Raw readings in the given range. `today` returns the current solar day (sunrise → now) plus its `sun` window so charts can be bounded correctly; `24h` remains a rolling window for compatibility |
| `GET /api/history/solar-sessions?days=N&bin=60\|300\|900` | Daylight buckets for the last N local dates, each normalized to seconds-after-sunrise (`bin` = aggregation width; 900 = 15-minute buckets for the 7D sequential timeline). Buckets failing the minimum-coverage rule are omitted — a power cut shows as a gap, never as zero |
| `GET /api/history/solar-profile?bin_minutes=M` | Long-term average power vs position within the solar day, aggregated server-side over all history (powers the All view; distinct from daily totals) |
| `GET /api/daily-summary` | Max `E_Today` per calendar day, ordered ascending (backs the Daily Energy Log bar chart and the Cumulative Energy running-total line chart; the running total is computed client-side from this same aggregated series) |
| `GET /api/generation/summary` | Generation KPIs in kWh: `today`, `yesterday`, `this_week` (Monday–today, ISO week), `this_month`, `this_year`, plus two lifetime figures — `calculated_total` (sum of stored daily `energy_kwh`, with today's live value included via on-the-fly grouping) and `inverter_lifetime` (the newest `E_Total` counter reading). Completed days come from `readings_daily.energy_kwh` (max `E_Today`) plus still-raw days grouped on the fly; **today** always uses the live max `E_Today` since local midnight (per `TIMEZONE`) straight from raw readings. The two lifetime figures can differ slightly — see below. Backs the dashboard's Generation KPI strip |
| `GET /api/generation/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` | Range-selectable yield stats over `[from, to]`: `days` (only days that actually have data count), `total_kwh`, `average_daily_kwh`, and `best_day`/`worst_day` as `{date, kwh}`. Validation: `to` must be ≤ today (local) and `from` ≥ the first day present in the database — violations return `{"error": ...}`. When omitted, defaults to the last 30 days ending today. Every response echoes `min_date`/`max_date` (the full available range, `min_date` = first day with data, `max_date` = today) so the frontend can constrain its date pickers. Backs the Average Daily Yield card |
| `GET /api/export?range=...` | CSV download of the given range |
| `GET /api/status` | Current inverter status (`online`/`offline`/`night`), offline-since, last reading/error, sun info |
| `GET /api/powercuts?range=today\|7d\|30d\|lifetime` | Number of recorded powercut events in the given window |
| `GET /api/sun` | Next sunrise/sunset times and countdowns |
| `GET /api/weather` | Current weather + a short forecast for the configured location, in a provider-agnostic normalized shape (`provider`, `temp`, `feels_like`, `humidity`, `wind_speed`, `condition`, `icon`, `cloud_cover`, `pop`, `high`/`low`, `forecast[]`). **Primary:** OpenWeatherMap (only when `OPENWEATHER_API_KEY` is set); **fallback:** Open-Meteo — no key required, used automatically whenever OWM is unconfigured or fails. Cached in-memory for 15 minutes. Returns `502 {"detail": ...}` when every provider fails |
| `WS /ws` | Live reading/status broadcast |

## Notes

- If the inverter is unreachable, the backend logs the error, broadcasts an
  `error` message over the WebSocket, records a powercut event (see above),
  and retries after `ERROR_RETRY_DELAY` seconds — it never crashes, matching
  the original script's behavior.
- The frontend treats any gap between consecutive points larger than 5 minutes
  (e.g. a restart, a Wi-Fi drop, or the day/night transition) as a break in the
  line rather than interpolating across it.
- **Power Over Time views**: `1H` is a rolling real-time window, `Today` shows
  only the current solar day (sunrise → min(now, sunset), from the backend's
  astral calculation — never yesterday's data or future time), `7D` renders
  the seven days as one sequential timeline of 15-minute averaged buckets
  (nighttime occupies zero horizontal width; missing buckets break the line),
  and `All` shows a long-term average power profile over position within the
  solar day (aggregated server-side). The Daily Energy Log remains the
  date → kWh totals chart.
- **Cumulative Energy chart**: directly below the Daily Energy Log, a line
  chart of the running total of daily kWh (X-axis = date, Y-axis = cumulative
  kWh). It reuses the same aggregated per-day series as the bar chart — no
  extra backend query — with the running total accumulated client-side in one
  pass. A 30D / 90D / All toggle slices the series (All is the default); it
  refreshes on the same cadence as the Daily Energy Log and immediately after
  night mode ends.
- To reset all history, stop the server and delete the SQLite file (`solar_data.db`
  by default).
