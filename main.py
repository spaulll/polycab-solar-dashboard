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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

import config
import database
import inverter


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

            # Successful reading after errors -> reset glitch counting and
            # close any open powercut row.
            latest_state["consecutive_error_count"] = 0
            database.close_open_powercut()

            latest_state["night_mode"] = False
            latest_state["last_reading"] = reading
            latest_state["last_error"] = None
            latest_state["status"] = "online"
            latest_state["offline_since"] = None
            latest_state["last_successful_reading_at"] = now_iso

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
            # last_error but never flip the status or open a DB row.
            if (
                latest_state["status"] != "offline"
                and latest_state["consecutive_error_count"] == config.POWERCUT_ERROR_THRESHOLD
            ):
                if config.POWERCUT_CHECK_IP and await _ping(config.POWERCUT_CHECK_IP):
                    # The rest of the circuit still has power: inverter/dongle
                    # glitch, not a powercut.
                    print(f"[{now_iso}] {config.POWERCUT_CHECK_IP} reachable "
                          f"-- not recording powercut")
                else:
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
async def api_history(range: str = Query("24h", description="1h | 24h | 7d | all")):
    try:
        rows = await asyncio.to_thread(database.get_history, range)
    except ValueError as e:
        return {"error": str(e)}
    return {"range": range, "count": len(rows), "readings": rows}


@app.get("/api/daily-summary")
async def api_daily_summary():
    rows = await asyncio.to_thread(database.get_daily_summary)
    return {"days": rows}


@app.get("/api/db-status")
async def api_db_status():
    """Database health: file size, row counts, last maintenance, retention."""
    return await asyncio.to_thread(database.get_db_status)


@app.get("/api/export")
async def api_export(range: str = Query("all", description="1h | 24h | 7d | all")):
    try:
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


# ---------------------------------------------------------------------------
# Serve the frontend
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=config.HOST, port=config.PORT)
