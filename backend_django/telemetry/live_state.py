"""The most recent reading from each device, held in memory.

Two jobs.

First, it decouples "show me what is happening now" from "what did we store".
The latest-telemetry endpoint used to hit the database on every poll, which
means the dashboard's liveness depended on the storage policy - turn writes off
and the screen goes blank. Live state and history are different concerns and
should not share a mechanism.

Second, it makes TELEMETRY_PERSIST=False useful. With persistence off, telemetry
still arrives, still drives socket predictions and still reaches the frontend;
it simply leaves no trace in the database. That is the right behaviour for
watching the pipeline work without spending storage on it.

This is deliberately not Django's cache framework: the data is small, per
process, and worthless after a restart - there is nothing to gain from a round
trip to an external store, and a stale entry surviving a restart would be worse
than an empty one. Under multiple workers each holds its own view, so a poll may
land on a worker that has not seen the newest payload; entries carry their
timestamp so a stale one can be recognised rather than trusted.
"""

from __future__ import annotations

import threading
from typing import Any

from django.utils import timezone


_live: dict[str, Any] = {}
_lock = threading.Lock()


def record(reading) -> None:
    """Remember this reading as the newest for its device.

    Accepts saved and unsaved TelemetryReading instances alike - when
    persistence is off the instance never reaches the database, and it is still
    exactly what the dashboard should display.
    """
    key = reading.device_id
    if not key:
        return
    with _lock:
        _live[key] = reading


def latest_for(*keys: str, max_age_seconds: float | None = None):
    """Newest reading matching any of these device identifiers, or None.

    Several keys because a device can be addressed by MAC or by primary key,
    which is the same lookup the telemetry view does against the database.
    """
    now = timezone.now()
    best = None
    with _lock:
        for key in keys:
            reading = _live.get(str(key)) if key is not None else None
            if reading is None:
                continue
            if max_age_seconds is not None:
                age = (now - reading.timestamp).total_seconds()
                if age > max_age_seconds:
                    continue
            if best is None or reading.timestamp > best.timestamp:
                best = reading
    return best


def snapshot() -> dict[str, Any]:
    with _lock:
        return dict(_live)


def clear() -> None:
    with _lock:
        _live.clear()
