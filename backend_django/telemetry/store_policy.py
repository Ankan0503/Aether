"""Decide whether an incoming telemetry sample is worth storing.

The gateway publishes every 2 seconds, and a relay node with three sockets
writes four rows per payload - the combined reading plus one per socket. That is
roughly 172,800 rows a day, near 50 MB, which exhausts a small managed database
in a fortnight and buys nothing: almost every one of those rows is identical to
the one before it.

So this applies the standard deadband-plus-heartbeat rule used in industrial
telemetry:

  store a sample if something actually CHANGED, or if it has been long enough
  since the last one that we owe a heartbeat

That cuts a steady load from 43,200 rows a day per stream to 1,440, while
keeping every transition at full fidelity. A socket switching on is recorded the
instant it happens, not at the next scheduled sample.

Safety is never throttled. A change in status, flame or a gas reading crossing
its threshold is always stored immediately, whatever the heartbeat says - a
deduplication rule must never be the reason a hazard went unrecorded.

The consequence for querying: samples are now irregularly spaced, so a plain
avg() over a time bucket would be biased toward whichever state happened to
produce more rows. The continuous aggregate in migration 0009 uses time_weight()
instead, which weights each sample by how long it held.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

from django.conf import settings


def _setting(name: str, default):
    return getattr(settings, name, default)


# Seconds after which a sample is stored even if nothing changed. Sets the
# coarsest resolution the history will ever have.
def heartbeat_seconds() -> float:
    return float(_setting('TELEMETRY_HEARTBEAT_SECONDS', 60))


# A current change smaller than BOTH of these is treated as noise. The absolute
# floor matters most: a 30A ACS712 idles around 0.02 A of noise, so without it
# every sample would look like a change and nothing would be suppressed.
def current_deadband_abs() -> float:
    return float(_setting('TELEMETRY_CURRENT_DEADBAND_A', 0.05))


def current_deadband_frac() -> float:
    return float(_setting('TELEMETRY_CURRENT_DEADBAND_FRACTION', 0.10))


def gas_deadband() -> int:
    return int(_setting('TELEMETRY_GAS_DEADBAND', 150))


@dataclass
class _LastStored:
    at: float
    current: float
    gas: int
    status: str
    flame: int
    pir: int


# Keyed by (device_id, socket_id). In memory rather than in the database: the
# point is to avoid a round trip per sample, and a lookup would reintroduce one.
# Under multiple worker processes each keeps its own view, so the worst case is
# one extra heartbeat per worker - bounded, and still far below storing
# everything. State is rebuilt on restart by storing the first sample seen.
_last: dict[tuple[str, Any], _LastStored] = {}
_lock = threading.Lock()


def should_store(
    device_id: str,
    socket_id: Any,
    *,
    current: float,
    gas: int = 0,
    status: str = 'SAFE',
    flame: int = 1,
    pir: int = 1,
    now: float | None = None,
) -> tuple[bool, str]:
    """Return (store_it, why). `why` is for logging and for explaining the rule."""
    # Master switch. With persistence off, telemetry still arrives, still drives
    # predictions and still reaches the frontend through live_state - it just
    # leaves nothing behind. For watching the pipeline without spending storage.
    if not _setting('TELEMETRY_PERSIST', True):
        return False, 'persistence disabled (TELEMETRY_PERSIST=False)'

    now = time.time() if now is None else now
    key = (device_id, socket_id)

    with _lock:
        previous = _last.get(key)

        def remember(reason: str) -> tuple[bool, str]:
            _last[key] = _LastStored(now, current, gas, status, flame, pir)
            return True, reason

        if previous is None:
            return remember('first sample for this stream')

        # --- safety first: these bypass the deadband entirely ---------------
        if status != previous.status:
            return remember(f'status {previous.status} -> {status}')
        if flame != previous.flame:
            return remember('flame state changed')
        threshold = int(_setting('GAS_ALERT_THRESHOLD', 3500))
        if (gas >= threshold) != (previous.gas >= threshold):
            return remember('gas crossed the alert threshold')

        # --- heartbeat --------------------------------------------------------
        elapsed = now - previous.at
        if elapsed >= heartbeat_seconds():
            return remember(f'heartbeat after {elapsed:.0f}s')

        # --- real change ------------------------------------------------------
        delta = abs(current - previous.current)
        if delta > current_deadband_abs() and delta > previous.current * current_deadband_frac():
            return remember(f'current {previous.current:.3f} -> {current:.3f} A')

        if abs(gas - previous.gas) > gas_deadband():
            return remember(f'gas {previous.gas} -> {gas}')

        if pir != previous.pir:
            return remember('occupancy changed')

        return False, f'unchanged, {elapsed:.0f}s since last stored'


def reset_state() -> None:
    """Clear the cache. For tests, and after a bulk import."""
    with _lock:
        _last.clear()


def stream_count() -> int:
    with _lock:
        return len(_last)
