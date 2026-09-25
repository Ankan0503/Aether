from datetime import timedelta

import pandas as pd
from django.conf import settings
from django.utils import timezone

from telemetry.models import TelemetryReading


def readings_from_database(days: int = 30, user=None, device_id=None) -> pd.DataFrame:
    """
    Load recent telemetry into a pandas DataFrame for lightweight analytics.

    The telemetry table stores current, PIR, device and timestamp so occupancy
    waste can be detected from live history as well as posted payloads.
    """
    since = timezone.now() - timedelta(days=days)
    queryset = (
        TelemetryReading.objects
        .select_related('device_ref')
        .filter(timestamp__gte=since)
        .order_by('timestamp')
    )

    from devices.models import Device
    if user is not None:
        user_devices = Device.objects.filter(owner=user, is_paired=True)
        legacy_ids = [str(d.id) for d in user_devices]
        mac_ids = [d.mac_address for d in user_devices]
        queryset = queryset.filter(
            device_ref__in=user_devices
        ) | queryset.filter(
            device_id__in=legacy_ids + mac_ids
        )
    if device_id:
        queryset = queryset.filter(device_id=str(device_id))

    # Pre-fetch user devices to avoid N+1 query issue in Python
    all_user_devices = {}
    if user:
        for device in Device.objects.filter(owner=user):
            all_user_devices[str(device.id)] = device
            all_user_devices[device.mac_address] = device

    rows = []
    for reading in queryset:
        dev = all_user_devices.get(str(reading.device_id))
        device_name = reading.device_ref.name if reading.device_ref else (dev.name if dev else 'Unknown appliance')
        rows.append({
            'timestamp': reading.timestamp,
            'appliance': device_name,
            'device_id': reading.device_id,
            'current': float(reading.current or 0),
            'pir': 1 if int(reading.pir or 0) else 0,
            'power_watts': float(reading.power or 0),
        })

    return pd.DataFrame(rows)


def readings_from_payload(readings: list[dict]) -> pd.DataFrame:
    """Convert posted sensor history into the normalized analytics frame."""
    return pd.DataFrame(readings or [])
