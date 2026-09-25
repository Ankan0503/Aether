"""Ingest action="WF" frames - a socket's current waveform and what it means.

The subnode captures one mains cycle, coherently averaged over 16 cycles,
normalises it to its own peak, quantises to 64 signed bytes and base64-encodes
it. The whole frame fits in ESP-NOW's 250-byte limit, which is why the keys are
so short.

The node also sends its own verdict in `cls`. It is kept for comparison but
never trusted over the server's: the server recomputes every feature from the
waveform itself, so a firmware with stale thresholds cannot quietly skew the
history, and improving the classifier does not require reflashing anything.
"""

from __future__ import annotations

from devices.models import Device

from .load_signature import WaveformDecodeError, classify_payload
from .models import LoadSignature


# The same deadband thinking as telemetry: a load's shape only changes when the
# device does, so storing an identical signature every 15 seconds is waste.
# Stored when the label changes, or when the shape moves meaningfully, or after
# this long regardless.
SIGNATURE_HEARTBEAT_SECONDS = 600
CREST_DEADBAND = 0.15


def is_waveform_payload(data: dict) -> bool:
    return str(data.get('action', '')).upper() == 'WF'


def ingest_waveform_payload(data: dict) -> LoadSignature | None:
    """Classify a WF frame and store it if it tells us something new."""
    mac = data.get('mac') or data.get('device_id')
    if not mac:
        raise ValueError('Waveform payload requires mac.')

    try:
        result = classify_payload(data)
    except WaveformDecodeError as exc:
        raise ValueError(f'Malformed waveform frame: {exc}') from exc

    socket_id = int(result.get('channel') or 0)
    if socket_id <= 0:
        raise ValueError('Waveform payload requires a socket channel.')

    device = Device.objects.filter(mac_address=mac).first()
    features = result['features']

    previous = (
        LoadSignature.objects
        .filter(device_id=mac, socket_id=socket_id)
        .order_by('-timestamp')
        .first()
    )

    if previous is not None and not _worth_storing(previous, result, features):
        return None

    return LoadSignature.objects.create(
        device_ref=device,
        device_id=mac,
        socket_id=socket_id,
        label=result['label'],
        confidence=float(result.get('confidence') or 0.0),
        source=result.get('source', 'rule'),
        reason=result.get('reason', ''),
        crest=features.get('crest', 0.0),
        form_factor=features.get('form_factor', 0.0),
        conduction=features.get('conduction', 0.0),
        thd=features.get('thd', 0.0),
        h3=features.get('h3', 0.0),
        h5=features.get('h5', 0.0),
        rms_adc=float(result.get('rms_adc') or 0.0),
        cycle=[round(v, 4) for v in result.get('cycle', [])],
        device_label=str(result.get('device_label') or '')[:16],
    )


def _worth_storing(previous: LoadSignature, result: dict, features: dict) -> bool:
    from django.utils import timezone

    if previous.label != result['label']:
        return True

    age = (timezone.now() - previous.timestamp).total_seconds()
    if age >= SIGNATURE_HEARTBEAT_SECONDS:
        return True

    # Crest factor is the feature that most separates load types, so a real
    # move in it means the load genuinely changed even if the label has not
    # crossed a threshold yet.
    return abs(features.get('crest', 0.0) - previous.crest) > CREST_DEADBAND


def latest_signatures(device_ids: list[str]) -> dict[tuple[str, int], LoadSignature]:
    """Newest signature per (device, socket), for the dashboard."""
    latest: dict[tuple[str, int], LoadSignature] = {}
    rows = (
        LoadSignature.objects
        .filter(device_id__in=device_ids)
        .order_by('device_id', 'socket_id', '-timestamp')
    )
    for row in rows:
        key = (row.device_id, row.socket_id)
        if key not in latest:
            latest[key] = row
    return latest
