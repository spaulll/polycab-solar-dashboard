# Solar Dashboard

A local web dashboard for a Modbus TCP solar inverter: live stats via WebSocket,
historical charts, daily energy log, and CSV export. Built for a single home
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
    │   ├── api.js            # REST fetchers (history, daily summary, status, sun, CSV URL)
    │   ├── ws.js             # WebSocket client with auto-reconnect
    │   ├── charts.js         # Chart.js setup, gap-breaking, live-point appending
    │   ├── insights.js       # Conversion loss / peak / average computations
    │   ├── sun.js            # Sunrise/sunset strip + countdown ticker
    │   ├── ui.js             # Status pills, night banner, stat cards
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
- **Powercut tracking**: the first Modbus error after a successful reading
  opens a row in the `powercuts` table; the next successful reading closes it
  with a computed duration. Errors during night mode are ignored, and an open
  row survives app/host restarts — so offline episodes are recorded even when
  the dashboard machine itself loses power. The Inverter Status card shows the
  live state (Online / Unreachable + offline timer / Night mode) and a
  powercut count per selected range.
- **Historical/aggregate/CSV endpoints** query SQLite directly and are safe to
  call anytime, independent of the live polling loop.

## REST API

| Endpoint | Description |
|---|---|
| `GET /api/history?range=1h\|24h\|7d\|all` | Raw readings in the given range |
| `GET /api/daily-summary` | Max `E_Today` per calendar day (for the bar chart) |
| `GET /api/export?range=...` | CSV download of the given range |
| `GET /api/status` | Current inverter status (`online`/`offline`/`night`), offline-since, last reading/error, sun info |
| `GET /api/powercuts?range=today\|7d\|30d\|lifetime` | Number of recorded powercut events in the given window |
| `GET /api/sun` | Next sunrise/sunset times and countdowns |
| `WS /ws` | Live reading/status broadcast |

## Notes

- If the inverter is unreachable, the backend logs the error, broadcasts an
  `error` message over the WebSocket, records a powercut event (see above),
  and retries after `ERROR_RETRY_DELAY` seconds — it never crashes, matching
  the original script's behavior.
- The frontend treats any gap between consecutive points larger than 5 minutes
  (e.g. a restart, a Wi-Fi drop, or the day/night transition) as a break in the
  line rather than interpolating across it.
- To reset all history, stop the server and delete the SQLite file (`solar_data.db`
  by default).
