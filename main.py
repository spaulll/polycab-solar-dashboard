"""
Solar Dashboard backend.

Run with (serves the frontend and backend together):
    python main.py

or equivalently:
    uvicorn main:app --host 0.0.0.0 --port 8000

This starts:
- A background asyncio task that polls the inverter over Modbus TCP,
  respects sunrise/sunset night mode, writes readings to SQLite, and
  broadcasts each reading to connected WebSocket clients.
- REST endpoints for historical queries, daily summaries, and CSV export.
- A WebSocket endpoint at /ws for live updates.

Local-network-only tool: no auth, no HTTPS, CORS wide open by design.
"""
import asyncio
import datetime
import json
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

import config
import database
import inverter
import solar
import weather


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()

# Both Solar_Input and Inverter_Power at/below this value count as "no
# production". Tunable: raise if your meter reports small noise values.
ZERO_PRODUCTION_THRESHOLD: float = 0.1

# Latest known state, so newly-connecting clients get something immediately
# instead of waiting up to POLL_DELAY seconds for the next tick.
latest_state: dict = {
    "type": "status",
    "night_mode": False,
    "last_reading": None,
    "last_error": None,
    "status": "online",                 # online | offline | night
    "offline_since": None,              # ISO UTC timestamp or None
    "last_successful_reading_at": None,
    "consecutive_error_count": 0,
    "zero_powercut_confirmations": 0,
    "zero_cut_started_at": None,
}


async def _ping(host: str) -> bool:
    """
    True if `host` answers a couple of quick ICMP pings. Used to tell a real
    powercut (the whole circuit is down) apart from an inverter/Wi-Fi-dongle
    glitch (the rest of the network still has power).
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", "-c", "2", "-W", "1", host,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return (await proc.wait()) == 0
    except Exception as e:
        print(f"[PING ERROR] {host}: {e}")
        return False


def status_snapshot() -> dict:
    """The inverter-health fields shared by /api/status and WS messages."""
    return {
        "status": latest_state["status"],
        "offline_since": latest_state["offline_since"],
        "last_error": latest_state["last_error"],
        "last_successful_reading_at": latest_state["last_successful_reading_at"],
    }


# ---------------------------------------------------------------------------
# Background polling loop
# ---------------------------------------------------------------------------
async def polling_loop():
    while True:
        seconds_until_sunrise = await asyncio.to_thread(inverter.get_seconds_until_sunrise)

        if seconds_until_sunrise > 0:
            latest_state["type"] = "status"
            latest_state["night_mode"] = True
            latest_state["last_error"] = None
            # Night mode supersedes the offline display; any open powercut row
            # stays open in the DB and is closed by the first post-sunrise read.
            latest_state["status"] = "night"
            latest_state["offline_since"] = None
            await manager.broadcast({
                "type": "night_mode",
                "night_mode": True,
                "seconds_until_sunrise": seconds_until_sunrise,
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                **status_snapshot(),
            })
            # Close the persistent Modbus connection before a long idle stretch --
            # leaving a socket open for hours risks it going stale, and the
            # inverter itself is asleep anyway. fetch_inverter_data() will
            # transparently reconnect on the first poll after sunrise.
            await asyncio.to_thread(inverter.close_client)
            # Sleep in short increments so we can still react (e.g. if the process
            # needs to shut down) rather than one giant blocking sleep.
            remaining = seconds_until_sunrise
            chunk = 60.0
            while remaining > 0:
                await asyncio.sleep(min(chunk, remaining))
                remaining -= chunk
            latest_state["night_mode"] = False
            if latest_state["status"] == "night":
                # Optimistic: the next poll (seconds away) confirms or corrects.
                latest_state["status"] = "online"
            await manager.broadcast({
                "type": "wake_up",
                "night_mode": False,
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                **status_snapshot(),
            })
            continue

        # --- Day mode: poll the inverter ---
        try:
            data = await asyncio.to_thread(inverter.fetch_inverter_data)
            now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
            reading = {**data, "timestamp": now_iso}

            database.enqueue_reading(reading)

            # A real powercut can show up two ways on a *successful* read:
            # during the inverter's residual-power window Modbus still works
            # but both power values read 0 while everything else looks normal.
            # Only treat that as an outage when the always-on check device is
            # also unreachable (a small non-zero Solar_Input with a zero
            # Inverter_Power -- e.g. low light -- must NOT count here, which is
            # why Active_Power-style OR-sums are deliberately avoided). The
            # condition must hold for POWERCUT_ZERO_THRESHOLD consecutive
            # reads before the cut is recorded, guarding against flaky pings.
            solar_zero = reading.get("Solar_Input", 0.0) <= ZERO_PRODUCTION_THRESHOLD
            inverter_zero = reading.get("Inverter_Power", 0.0) <= ZERO_PRODUCTION_THRESHOLD

            # When True, a successful read must NOT close the open powercut
            # row: the outage looks like it's still in progress.
            zero_production_outage = False
            if solar_zero and inverter_zero and config.POWERCUT_CHECK_IP:
                if await _ping(config.POWERCUT_CHECK_IP):
                    print(f"[{now_iso}] both powers <= {ZERO_PRODUCTION_THRESHOLD} "
                          f"but check IP reachable -> not a powercut")
                else:
                    # Suppress closing regardless of whether this read is
                    # still counting confirmations or already confirmed. The
                    # counter is capped at the threshold so an ongoing cut
                    # logs "ongoing" instead of "4/3".
                    zero_production_outage = True
                    prev = latest_state["zero_powercut_confirmations"]
                    confirmations = min(prev + 1, config.POWERCUT_ZERO_THRESHOLD)
                    latest_state["zero_powercut_confirmations"] = confirmations
                    if confirmations < config.POWERCUT_ZERO_THRESHOLD:
                        print(f"[{now_iso}] both powers <= {ZERO_PRODUCTION_THRESHOLD} "
                              f"+ check IP unreachable ({confirmations}/"
                              f"{config.POWERCUT_ZERO_THRESHOLD}) -> waiting")
                    elif prev < config.POWERCUT_ZERO_THRESHOLD:
                        print(f"[{now_iso}] both powers <= {ZERO_PRODUCTION_THRESHOLD} "
                              f"+ check IP unreachable ({confirmations}/"
                              f"{config.POWERCUT_ZERO_THRESHOLD}) -> recording powercut")
                        database.record_powercut_start(
                            "zero production + check IP unreachable"
                        )
                        latest_state["zero_cut_started_at"] = now_iso
                    else:
                        print(f"[{now_iso}] ongoing powercut: both powers <= "
                              f"{ZERO_PRODUCTION_THRESHOLD} + check IP unreachable")
            elif solar_zero and inverter_zero:
                print(f"[{now_iso}] both powers <= {ZERO_PRODUCTION_THRESHOLD}, "
                      f"no check IP configured -> cannot verify outage")

            # Successful reading after errors -> reset glitch counting and
            # close any open powercut row -- unless this successful read just
            # confirmed/continued an outage (zero powers + dead check IP), in
            # which case the row must stay open until production or the
            # network actually comes back.
            latest_state["consecutive_error_count"] = 0
            if not zero_production_outage:
                database.close_open_powercut()
                latest_state["zero_powercut_confirmations"] = 0
                latest_state["zero_cut_started_at"] = None

            latest_state["night_mode"] = False
            latest_state["last_reading"] = reading
            latest_state["last_error"] = None
            latest_state["status"] = "online"
            latest_state["offline_since"] = None
            latest_state["last_successful_reading_at"] = now_iso
            if (zero_production_outage
                    and latest_state["zero_powercut_confirmations"]
                    >= config.POWERCUT_ZERO_THRESHOLD):
                # Confirmed ongoing outage: keep the offline UI state (the
                # generic "success" assignments above would otherwise clear it).
                latest_state["status"] = "offline"
                latest_state["offline_since"] = (
                    latest_state["zero_cut_started_at"] or now_iso
                )

            await manager.broadcast({
                "type": "reading",
                "night_mode": False,
                "data": reading,
                **status_snapshot(),
            })

        except Exception as e:
            err_msg = str(e)
            now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
            print(f"[{now_iso}] Read Error: {err_msg}")
            latest_state["last_error"] = err_msg
            latest_state["consecutive_error_count"] += 1

            # Only a run of POWERCUT_ERROR_THRESHOLD consecutive daytime
            # errors counts as a powercut; shorter glitches stay visible via
            # last_error but never flip the status or open a DB row. Before
            # recording we ping both the always-on check device and the
            # inverter itself: the check device answers -> mains are fine
            # (glitch); check device down but inverter still answering ->
            # inverter/dongle issue, keep waiting; both down -> real cut.
            # Re-evaluated on every error past the threshold so the "waiting"
            # case can still resolve once the inverter finally dies.
            if latest_state["status"] != "offline" and (
                latest_state["consecutive_error_count"] >= config.POWERCUT_ERROR_THRESHOLD
            ):
                if config.POWERCUT_CHECK_IP and await _ping(config.POWERCUT_CHECK_IP):
                    # The rest of the circuit still has power: inverter/dongle
                    # glitch, not a powercut.
                    print(f"[{now_iso}] Modbus error, check IP reachable "
                          f"-> not a powercut")
                elif config.INVERTER_IP and await _ping(config.INVERTER_IP):
                    print(f"[{now_iso}] Modbus error, check IP down but "
                          f"inverter still reachable -> waiting")
                else:
                    print(f"[{now_iso}] Modbus error, both unreachable "
                          f"-> recording powercut")
                    database.record_powercut_start(err_msg)
                    latest_state["offline_since"] = now_iso
                    latest_state["status"] = "offline"
            await manager.broadcast({
                "type": "error",
                "message": err_msg,
                "timestamp": now_iso,
                **status_snapshot(),
            })
            await asyncio.sleep(config.ERROR_RETRY_DELAY)
            continue

        await asyncio.sleep(config.POLL_DELAY)


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    database.start_writer_thread()
    # If the previous run died mid-powercut (e.g. the host lost power), the
    # open row tells us we were offline; keep that state until a successful
    # reading closes it.
    open_cut = database.get_open_powercut()
    if open_cut:
        latest_state["status"] = "offline"
        latest_state["offline_since"] = open_cut["started_at"]
        latest_state["last_error"] = open_cut["last_error"]
    # Daily maintenance (downsampling + retention + weekly VACUUM) runs on its
    # own daemon thread so it can never block the async polling loop.
    database.start_maintenance_thread()
    task = asyncio.create_task(polling_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await asyncio.to_thread(inverter.close_client)
        database.stop_writer_thread()
        # join() blocks briefly -- keep it off the event loop.
        await asyncio.to_thread(database.stop_maintenance_thread)


app = FastAPI(title="Solar Dashboard", lifespan=lifespan)

# Wide-open CORS: local-network tool, no auth/hardening by design.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send current state immediately on connect
        sun_info = await asyncio.to_thread(inverter.get_sun_info)
        await websocket.send_json({
            "type": "init",
            "night_mode": latest_state["night_mode"],
            "last_reading": latest_state["last_reading"],
            "last_error": latest_state["last_error"],
            "sun": sun_info,
            **status_snapshot(),
        })
        while True:
            # We don't expect incoming messages, but keep the connection alive
            # and detect disconnects promptly.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.get("/api/history")
async def api_history(
    range: str = Query("24h", description="1h | today | 24h | 7d | all"),
):
    try:
        if range == "today":
            # Current solar day (sunrise -> now/sunset), not a rolling 24h.
            # The sun window is included so the frontend can bound the chart
            # axis without duplicating sunrise/sunset logic client-side.
            sun_info = await asyncio.to_thread(solar.get_today_window)
            rows = await asyncio.to_thread(
                database.get_history_between, sun_info["since"], None
            )
            return {
                "range": range,
                "count": len(rows),
                "readings": rows,
                "sun": sun_info,
            }
        rows = await asyncio.to_thread(database.get_history, range)
    except ValueError as e:
        return {"error": str(e)}
    return {"range": range, "count": len(rows), "readings": rows}


@app.get("/api/history/solar-sessions")
async def api_solar_sessions(
    days: int = Query(7, ge=1, le=30),
    bin: int = Query(60, description="Bucket width in seconds: 60 | 300 | 900"),
):
    """
    Daylight sessions for the last N local dates, each normalized to its own
    sunrise. Powers the 7D solar-day view; days without data come back with
    an empty bucket list rather than fabricated values. `bin` selects the
    aggregation width (900 = 15-minute buckets for the sequential timeline);
    buckets failing the minimum-coverage rule are omitted.
    """
    try:
        return await asyncio.to_thread(solar.get_solar_sessions, days, bin)
    except ValueError as e:
        return {"error": str(e)}


@app.get("/api/history/solar-profile")
async def api_solar_profile(bin_minutes: int = Query(5, ge=1, le=30)):
    """
    Long-term average power vs position within the solar day, aggregated
    server-side over all historical daylight readings. Deliberately distinct
    from /api/daily-summary (date -> kWh totals).
    """
    return await asyncio.to_thread(solar.get_solar_profile, bin_minutes)


@app.get("/api/insights/peak")
async def api_insights_peak(
    range: str = Query("all", description="today | 7d | all"),
):
    """
    Peak Production insight, computed server-side as MAX(raw solar_input)
    over the full-resolution readings table -- never from chart aggregates.

    today -> today's solar-session window (sunrise onward)
    7d    -> the last 7 local calendar days
    all   -> entire raw history

    The returned timestamp is the original record time of the maximum row.
    """
    if range == "today":
        since = (await asyncio.to_thread(solar.get_today_window))["since"]
    elif range == "7d":
        # The 7D view covers the last 7 local dates; start at their midnight.
        since = await asyncio.to_thread(database.local_days_ago_start_utc, 6)
    elif range == "all":
        since = None
    else:
        return {"error": f"Unknown range '{range}'. Use one of: today, 7d, all."}
    peak = await asyncio.to_thread(database.get_peak_solar_input, since)
    return {"range": range, **(peak or {})}


@app.get("/api/daily-summary")
async def api_daily_summary():
    rows = await asyncio.to_thread(database.get_daily_summary)
    return {"days": rows}


@app.get("/api/generation/summary")
async def api_generation_summary():
    """
    Generation KPI strip: kWh totals for today / yesterday / this week
    (Monday-today) / this month / this year, plus both lifetime figures --
    `calculated_total` (sum of stored daily energy) and `inverter_lifetime`
    (the inverter's own e_total counter), which can differ slightly.

    Also carries an `impact` block for the Savings & Impact panel: lifetime
    savings/CO2 follow the inverter's own e_total counter (Inverter
    Lifetime), month/year use the stored day buckets, and all money figures
    apply ELECTRICITY_TARIFF live (CO2 uses GRID_CO2_KG_PER_KWH). When the
    tariff is unset or <= 0 it degrades to `{"enabled": false}` so the UI
    can hide the panel.
    """
    return await asyncio.to_thread(database.get_generation_summary)


@app.get("/api/generation/stats")
async def api_generation_stats(
    from_: Optional[str] = Query(None, alias="from", description="YYYY-MM-DD"),
    to_: Optional[str] = Query(None, alias="to", description="YYYY-MM-DD"),
):
    """
    Range-selectable yield stats: total kWh, average per day and best/worst
    day over [from, to]. Only days that actually have generation data count.
    `to` must be <= today (local) and `from` >= the first day in the
    database; when omitted, the last 30 days ending today are used. Every
    response echoes min_date/max_date -- the full available range -- so the
    frontend can constrain its date pickers.
    """
    try:
        return await asyncio.to_thread(database.get_generation_stats, from_, to_)
    except ValueError as e:
        return {"error": str(e)}


@app.get("/api/db-status")
async def api_db_status():
    """Database health: file size, row counts, last maintenance, retention."""
    return await asyncio.to_thread(database.get_db_status)


@app.get("/api/export")
async def api_export(
    range: str = Query("all", description="1h | today | 24h | 7d | all"),
):
    try:
        if range == "today":
            sun_info = await asyncio.to_thread(solar.get_today_window)
            rows = await asyncio.to_thread(
                database.get_history_between, sun_info["since"], None
            )
            csv_text = await asyncio.to_thread(database.export_rows_to_csv, rows)
        else:
            csv_text = await asyncio.to_thread(database.export_csv, range)
    except ValueError as e:
        return {"error": str(e)}
    filename = f"solar_export_{range}.csv"
    return StreamingResponse(
        iter([csv_text]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.get("/api/status")
async def api_status():
    sun_info = await asyncio.to_thread(inverter.get_sun_info)
    return {
        "night_mode": latest_state["night_mode"],
        "last_reading": latest_state["last_reading"],
        "last_error": latest_state["last_error"],
        **status_snapshot(),
        "connected_clients": len(manager.active),
        "sun": sun_info,
    }


@app.get("/api/powercuts")
async def api_powercuts(
    range: str = Query("lifetime", description="today | 7d | 30d | lifetime"),
):
    """Number of powercut events in the requested window."""
    try:
        count = await asyncio.to_thread(database.get_powercut_count, range)
    except ValueError as e:
        return {"error": str(e)}
    return {"range": range, "count": count}


@app.get("/api/sun")
async def api_sun():
    """Next sunrise/sunset times and countdowns for the configured location."""
    return await asyncio.to_thread(inverter.get_sun_info)


@app.get("/api/weather")
async def api_weather():
    """
    Current weather + a short forecast for the configured location, from a
    normalized provider chain: OpenWeatherMap when OPENWEATHER_API_KEY is
    set (primary), otherwise/automatically Open-Meteo (no key). Cached
    server-side for a few minutes. 502 when every provider fails.
    """
    try:
        return await asyncio.to_thread(weather.get_weather)
    except weather.WeatherUnavailableError as e:
        raise HTTPException(status_code=502, detail=f"Weather unavailable: {e}")


# ---------------------------------------------------------------------------
# Serve the frontend
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=config.HOST, port=config.PORT)
