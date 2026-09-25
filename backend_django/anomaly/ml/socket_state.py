from __future__ import annotations

import json
import os
import ssl
from datetime import timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
from django.conf import settings
from django.db.models import Q
from django.utils import timezone
from paho.mqtt import publish as mqtt_publish

from telemetry.models import MLPrediction, TelemetryReading


STATE_ACTIVE = 'ACTIVE'
STATE_CHARGING_COMPLETE = 'CHARGING_COMPLETE'
STATE_IDLE = 'IDLE'
STATE_EMPTY_SOCKET = 'EMPTY_SOCKET'
STATE_ORDER = [STATE_ACTIVE, STATE_CHARGING_COMPLETE, STATE_IDLE, STATE_EMPTY_SOCKET]
SOCKET_TO_RELAY_CHANNEL = {
    1: 1,
    2: 2,
    3: 4,
    4: 3,
}
FEATURE_COLUMNS = [
    'current',
    'power',
    'rolling_avg_power_5min',
    'rolling_avg_current_5min',
    'power_std_5min',
    'current_std_5min',
    'power_slope',
    'hour_of_day',
    'day_of_week',
]


class SocketModelNotReady(RuntimeError):
    pass


def normalize_socket_id(value: Any) -> int:
    socket_id = int(value)
    if socket_id not in SOCKET_TO_RELAY_CHANNEL:
        raise ValueError('socket_id must be one of 1, 2, 3, or 4.')
    return socket_id


def relay_channel_for_socket(socket_id: int) -> int:
    return SOCKET_TO_RELAY_CHANNEL[normalize_socket_id(socket_id)]


def socket_model_dir() -> Path:
    return Path(getattr(settings, 'SOCKET_MODEL_DIR'))


def safe_device_id(device_id: str) -> str:
    return ''.join(char if char.isalnum() or char in {'-', '_', '.'} else '_' for char in str(device_id))


def socket_model_path(device_id: str, socket_id: int) -> Path:
    return socket_model_dir() / f'device_{safe_device_id(device_id)}' / f'socket_{socket_id}.pkl'


def socket_queryset(device_id: str, socket_id: int):
    socket_id = normalize_socket_id(socket_id)
    relay_channel = relay_channel_for_socket(socket_id)
    return TelemetryReading.objects.filter(
        Q(socket_id=socket_id, channel=relay_channel) |
        Q(socket_id=socket_id, channel__isnull=True) |
        Q(socket_id__isnull=True, channel=relay_channel),
        device_id=device_id,
    ).exclude(status__iexact='OFF')


def _rows_to_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    frame = pd.DataFrame(rows)
    if frame.empty:
        return pd.DataFrame(columns=['timestamp', *FEATURE_COLUMNS])

    frame['timestamp'] = pd.to_datetime(frame['timestamp'], utc=True)
    frame['current'] = pd.to_numeric(frame['current'], errors='coerce').fillna(0.0)
    frame['power'] = pd.to_numeric(frame['power'], errors='coerce').fillna(0.0)
    frame = frame.sort_values('timestamp').drop_duplicates(subset=['id'], keep='last')
    indexed = frame.set_index('timestamp')

    rolling = indexed[['power', 'current']].rolling('5min', min_periods=1)
    frame['rolling_avg_power_5min'] = rolling['power'].mean().to_numpy()
    frame['rolling_avg_current_5min'] = rolling['current'].mean().to_numpy()
    frame['power_std_5min'] = rolling['power'].std().fillna(0.0).to_numpy()
    frame['current_std_5min'] = rolling['current'].std().fillna(0.0).to_numpy()
    frame['power_slope'] = frame['power'].diff().fillna(0.0)
    frame['hour_of_day'] = frame['timestamp'].dt.hour
    frame['day_of_week'] = frame['timestamp'].dt.dayofweek
    return frame


def build_feature_frame(readings: list[TelemetryReading]) -> pd.DataFrame:
    rows = [
        {
            'id': reading.id,
            'timestamp': reading.timestamp,
            'current': float(reading.current or 0.0),
            'power': float(reading.power or 0.0),
        }
        for reading in readings
    ]
    return _rows_to_frame(rows)


def latest_socket_features(device_id: str, socket_id: int) -> tuple[TelemetryReading, pd.DataFrame]:
    socket_id = normalize_socket_id(socket_id)
    latest = socket_queryset(device_id, socket_id).order_by('-timestamp', '-id').first()
    if latest is None:
        raise TelemetryReading.DoesNotExist(
            f'No telemetry found for device {device_id} socket {socket_id}.'
        )

    since = latest.timestamp - timedelta(minutes=5)
    readings = list(
        socket_queryset(device_id, socket_id)
        .filter(timestamp__gte=since, timestamp__lte=latest.timestamp)
        .order_by('timestamp', 'id')
    )
    frame = build_feature_frame(readings)
    return latest, frame.tail(1)[FEATURE_COLUMNS]


@lru_cache(maxsize=256)
def load_socket_model(path: str, modified_time: float) -> dict[str, Any]:
    del modified_time
    bundle = joblib.load(path)
    if not isinstance(bundle, dict) or 'model' not in bundle or 'features' not in bundle:
        raise SocketModelNotReady('Invalid socket model artifact.')
    if list(bundle['features']) != FEATURE_COLUMNS:
        raise SocketModelNotReady('Socket model feature schema mismatch.')
    return bundle


def get_socket_model(device_id: str, socket_id: int) -> dict[str, Any]:
    path = socket_model_path(device_id, socket_id)
    if not path.exists():
        raise SocketModelNotReady(f'Socket model not found at {path}')
    return load_socket_model(str(path), path.stat().st_mtime)


def clear_socket_model_cache():
    load_socket_model.cache_clear()


def _fallback_state(reading: TelemetryReading) -> tuple[str, float]:
    power = float(reading.power or 0.0)
    current = float(reading.current or 0.0)
    if power < 1.0 and current < 0.02:
        return STATE_EMPTY_SOCKET, 0.0
    if power > 15.0:
        return STATE_ACTIVE, 0.0
    if power < 5.0:
        return STATE_CHARGING_COMPLETE, 0.0
    return STATE_IDLE, 0.0


def predict_socket_state(device_id: str, socket_id: int) -> dict[str, Any]:
    socket_id = normalize_socket_id(socket_id)
    reading, features = latest_socket_features(device_id, socket_id)
    try:
        bundle = get_socket_model(device_id, socket_id)
        model = bundle['model']
        predicted_state = str(model.predict(features)[0])
        confidence = 0.0
        if hasattr(model, 'predict_proba'):
            probabilities = model.predict_proba(features)[0]
            confidence = float(max(probabilities)) * 100.0
        model_version = bundle.get('model_version', 'unknown')
        if not bundle.get('cutoff_ready', False):
            confidence = min(confidence, float(getattr(settings, 'SOCKET_BOOTSTRAP_CONFIDENCE_CAP', 89.0)))
    except SocketModelNotReady:
        predicted_state, confidence = _fallback_state(reading)
        model_version = 'fallback'

    return {
        'device_id': device_id,
        'socket_id': socket_id,
        'state': predicted_state,
        'predicted_state': predicted_state,
        'confidence': round(confidence, 2),
        'telemetry_id': reading.id,
        'model_version': model_version,
        'features': features.iloc[0].to_dict(),
    }


def should_cut_socket_power(device_id: str, socket_id: int, state: str, confidence: float, now=None) -> tuple[bool, str]:
    if not getattr(settings, 'SOCKET_AUTO_CUTOFF_ENABLED', True):
        return False, 'Automatic socket cutoff disabled.'
    if state != STATE_CHARGING_COMPLETE:
        return False, 'Only charging-complete sockets are eligible for automatic cutoff.'
    threshold = float(getattr(settings, 'SOCKET_CUTOFF_CONFIDENCE_THRESHOLD', 90.0))
    if float(confidence) <= threshold:
        return False, f'Confidence {confidence:.1f}% does not exceed {threshold:.1f}%.'

    now = now or timezone.now()
    duration = timedelta(minutes=int(getattr(settings, 'SOCKET_CUTOFF_CONFIRMATION_MINUTES', 10)))
    window_start = now - duration
    bad_prediction = MLPrediction.objects.filter(
        device_id=device_id,
        socket_id=socket_id,
        created_at__gt=window_start,
    ).exclude(
        predicted_state=STATE_CHARGING_COMPLETE,
        confidence__gt=threshold,
    ).exists()
    if bad_prediction:
        return False, 'Socket has not been continuously charging-complete during the safety window.'

    confirmed_for_window = MLPrediction.objects.filter(
        device_id=device_id,
        socket_id=socket_id,
        predicted_state=STATE_CHARGING_COMPLETE,
        confidence__gt=threshold,
        created_at__lte=window_start,
    ).exists()
    if not confirmed_for_window:
        return False, 'Waiting for 10 consecutive minutes of high-confidence charging-complete predictions.'

    return True, 'Charging-complete state confirmed for at least 10 consecutive minutes.'


def publish_socket_cutoff(device_id: str, socket_id: int) -> str:
    broker = getattr(settings, 'MQTT_BROKER', None) or os.getenv('MQTT_BROKER', 'broker.hivemq.com')
    port = int(getattr(settings, 'MQTT_PORT', 0) or os.getenv('MQTT_PORT', 1883))
    username = getattr(settings, 'MQTT_USER', None) or os.getenv('MQTT_USER')
    password = getattr(settings, 'MQTT_PASSWORD', None) or os.getenv('MQTT_PASSWORD')
    topic = getattr(settings, 'SOCKET_CUTOFF_COMMAND_TOPIC', 'aether/pairing/command')

    auth = {'username': username, 'password': password} if username and password else None
    tls = {'ca_certs': None, 'cert_reqs': ssl.CERT_NONE, 'tls_version': ssl.PROTOCOL_TLS} if port == 8883 else None
    payload = {
        'mac': device_id,
        'action': 'CONTROL_RELAY',
        'channel': relay_channel_for_socket(socket_id),
        'state': False,
    }
    mqtt_publish.single(topic, payload=json.dumps(payload), hostname=broker, port=port, auth=auth, tls=tls)
    return topic


def predict_socket_log_and_act(device_id: str, socket_id: int) -> MLPrediction:
    result = predict_socket_state(device_id, socket_id)
    prediction = MLPrediction.objects.create(
        device_id=device_id,
        socket_id=socket_id,
        predicted_state=result['predicted_state'],
        confidence=result['confidence'],
        action_taken='',
    )
    cutoff, reason = should_cut_socket_power(
        device_id,
        socket_id,
        result['predicted_state'],
        result['confidence'],
        now=prediction.created_at,
    )
    if cutoff:
        try:
            topic = publish_socket_cutoff(device_id, socket_id)
            prediction.action_taken = f'RELAY_OFF:{topic}'
            prediction.save(update_fields=['action_taken'])
        except Exception:
            prediction.action_taken = 'CUTOFF_FAILED'
            prediction.save(update_fields=['action_taken'])
    elif reason:
        prediction.action_taken = ''
    return prediction
