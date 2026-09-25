import hashlib
import json
from datetime import datetime

from django.conf import settings
from django.utils import timezone

from anomaly.ml.socket_state import predict_socket_log_and_act
from devices.models import Device

from .models import TelemetryReading
from .live_state import record as record_live
from .store_policy import should_store


SOCKET_HARDWARE_MAP = {
    1: {'current_key': 'c1', 'relay_key': 'r1', 'hardware_channel': 1},
    2: {'current_key': 'c2', 'relay_key': 'r2', 'hardware_channel': 2},
    3: {'current_key': 'c4', 'relay_key': 'r4', 'hardware_channel': 4},
}


def _float_value(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int_value(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _bool_value(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {'1', 'true', 'on', 'yes'}


def payload_hash(payload: dict) -> str:
    normalized = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(normalized.encode('utf-8')).hexdigest()


def ingest_telemetry_payload(data: dict) -> tuple[TelemetryReading, object | None]:
    mac = data.get('mac') or data.get('device_id') or data.get('device')
    if not mac:
        raise ValueError('Telemetry payload requires mac or device_id.')

    # Trust the node's own declaration when it makes one. The gateway sends
    # role="gateway", and without this it was classified by the heuristic below
    # as a plain sensor - it carries no c1-c4, so it looked like one. It then
    # appeared in the dashboard as "Unassigned Sensor Node", which is wrong and
    # also hides the one device that can actually measure power factor.
    declared = str(data.get("role") or "").strip().lower()
    ROLE_NAMES = {
        "gateway": "Aether Gateway",
        "relay": "ESP32 Relay Node",
        "sensor": "Sensor Node",
    }
    if declared in ROLE_NAMES:
        role, name = declared, ROLE_NAMES[declared]
    else:
        # Fall back to the old heuristic for nodes that declare nothing: a
        # payload carrying per-socket currents can only be a relay node.
        # The hardcoded MAC is a leftover from one specific Aether board.
        role = "sensor"
        name = "Sensor Node"
        if "c1" in data or "c2" in data or "c3" in data or "c4" in data or mac == "70:4B:CA:27:78:84":
            role = "relay"
            name = "ESP32 Relay Node"

    device, _ = Device.objects.get_or_create(
        mac_address=mac,
        defaults={
            'name': f'Unassigned {name}',
            'role': role,
            'is_paired': False,
        },
    )
    
    if device.role != role:
        device.role = role
        device.name = f"Unassigned {name}"
    device.save()

    # Auto-create 3 default appliance sockets for relay nodes if missing.
    if device.role == 'relay':
        from devices.models import Appliance
        default_names = ["Socket 1", "Socket 2", "Socket 3"]
        default_types = ["Appliance", "Appliance", "Appliance"]
        default_consumptions = [100, 100, 100]
        for ch in range(1, 4):
            Appliance.objects.get_or_create(
                device=device,
                channel=ch,
                defaults={
                    "name": default_names[ch - 1],
                    "type": default_types[ch - 1],
                    "nominal_consumption": default_consumptions[ch - 1]
                }
            )

    voltage = _float_value(data.get('voltage'), getattr(settings, 'APPLIANCE_DEFAULT_VOLTAGE', 230.0))
    timestamp = data.get('timestamp')

    c1 = _float_value(data.get("c1"), 0.0)
    c2 = _float_value(data.get("c2"), 0.0)
    c3 = _float_value(data.get("c3"), 0.0)
    c4 = _float_value(data.get("c4"), 0.0)

    # Channel 3 pins are unused on this hardware, so logical socket 3 uses c4/r4.
    if device.role == 'relay':
        current = c1 + c2 + c4
    else:
        current = _float_value(data.get('current'), 0.0)
        
    power = current * voltage

    # 1. The overall/combined device telemetry reading.
    #
    # Stored only if something changed or a heartbeat is due - see
    # telemetry/store_policy.py. The gateway publishes every 2 seconds and most
    # of those samples are identical to the one before, so writing all of them
    # fills a managed database in a fortnight and adds no information. Live
    # decisions below (appliance state, socket predictions) still run on every
    # payload; it is only the history that is thinned.
    reading_fields = dict(
        device_ref=device,
        device_id=mac,
        appliance_id=None,
        channel=None,
        socket_id=None,
        gas=_int_value(data.get('gas'), 0),
        current=current,
        power=power,
        pir=1 if _int_value(data.get('pir'), 1) else 0,
        flame=_int_value(data.get('flame'), 1),
        status=str(data.get('status') or 'SAFE')[:50],
        c1=c1,
        c2=c2,
        c3=c3,
        c4=c4,
    )
    parsed = None
    if timestamp:
        parsed = datetime.fromisoformat(str(timestamp).replace('Z', '+00:00'))

    store_it, _reason = should_store(
        mac, None,
        current=current,
        gas=reading_fields['gas'],
        status=reading_fields['status'],
        flame=reading_fields['flame'],
        pir=reading_fields['pir'],
    )

    if store_it:
        reading = TelemetryReading.objects.create(**reading_fields)
        if parsed:
            reading.timestamp = parsed
            reading.save(update_fields=['timestamp'])
    else:
        # Unsaved instance, so callers still get the current values to act on.
        reading = TelemetryReading(**reading_fields)
        reading.timestamp = parsed or timezone.now()

    # Always publish to live state, whether or not the row was persisted - the
    # dashboard shows what is happening now, which is a separate concern from
    # what history we chose to keep.
    record_live(reading)

    # 2. Save individual telemetry readings for each socket on the relay node.
    socket_prediction = None
    if device.role == 'relay':
        from devices.models import Appliance
        appliances = Appliance.objects.filter(device=device, channel__in=SOCKET_HARDWARE_MAP.keys())
        for app in appliances:
            socket_config = SOCKET_HARDWARE_MAP[app.channel]
            app_current = _float_value(data.get(socket_config['current_key']), 0.0)
            relay_state_key = socket_config['relay_key']
            relay_is_on = app.active
            if relay_state_key in data:
                relay_is_on = _bool_value(data.get(relay_state_key), app.active)
                app.active = relay_is_on
                app.save(update_fields=['active'])
            elif app_current > 0.0 and not app.active:
                relay_is_on = True
                app.active = True
                app.save(update_fields=['active'])

            # Each socket is its own stream, so a change on socket 1 does not
            # force a write for sockets 2 and 3. Relay state is folded into
            # `status`, which the policy always treats as a change - switching a
            # socket is recorded the instant it happens.
            socket_store, _socket_reason = should_store(
                mac, app.channel,
                current=app_current,
                gas=_int_value(data.get('gas'), 0),
                status=('ON' if relay_is_on else 'OFF'),
                flame=_int_value(data.get('flame'), 1),
                pir=1 if _int_value(data.get('pir'), 1) else 0,
            )
            if socket_store:
                app_reading = TelemetryReading.objects.create(
                    device_ref=device,
                    device_id=mac,
                    appliance_id=app.id,
                    channel=socket_config['hardware_channel'],
                    socket_id=app.channel,
                    gas=_int_value(data.get('gas'), 0),
                    current=app_current,  # Mapped individual current
                    power=app_current * voltage,
                    pir=1 if _int_value(data.get('pir'), 1) else 0,
                    flame=_int_value(data.get('flame'), 1),
                    status=('ON' if relay_is_on else 'OFF'),
                    c1=c1,
                    c2=c2,
                    c3=c3,
                    c4=c4,
                )
                if parsed:
                    app_reading.timestamp = parsed
                    app_reading.save(update_fields=['timestamp'])
            
            if relay_is_on:
                # A prediction is an enhancement, not a precondition for
                # recording telemetry. It reads back recent history, so it
                # raises whenever there is none - a brand-new socket, or any
                # time TELEMETRY_PERSIST is off. Letting that propagate would
                # abort the whole ingest and drop the payload, so a relay node
                # would silently stop reporting the moment storage was paused.
                try:
                    socket_prediction = predict_socket_log_and_act(mac, app.channel)
                except TelemetryReading.DoesNotExist:
                    socket_prediction = None
                except Exception as exc:  # noqa: BLE001 - never lose telemetry to a model
                    print(f'Socket prediction failed for {mac} socket {app.channel}: {exc}')
                    socket_prediction = None

    return reading, socket_prediction
