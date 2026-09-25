from functools import lru_cache
from pathlib import Path
from typing import Any
from datetime import timedelta
import json

import joblib
import pandas as pd
from django.conf import settings
from django.db.models import Avg, Max
from django.utils import timezone
from paho.mqtt import publish as mqtt_publish

from telemetry.models import ApplianceStatePrediction, TelemetryReading

# In-memory store for tracking when each appliance channel was turned ON (active)
_ACTIVATION_TIMES = {}

def record_activation(appliance_id: int, timestamp=None):
    _ACTIVATION_TIMES[appliance_id] = timestamp or timezone.now()

def get_activation_time(appliance_id: int):
    return _ACTIVATION_TIMES.get(appliance_id)

def clear_activation(appliance_id: int):
    _ACTIVATION_TIMES.pop(appliance_id, None)


def clear_activation_times():
    _ACTIVATION_TIMES.clear()


STATE_ACTIVE = 'ACTIVE'
STATE_IDLE = 'IDLE'
STATE_PHANTOM_LOAD = 'PHANTOM_LOAD'
STATE_ABNORMAL = 'ABNORMAL'
STATE_ORDER = [STATE_ACTIVE, STATE_IDLE, STATE_PHANTOM_LOAD, STATE_ABNORMAL]
FEATURE_COLUMNS = [
    'current',
    'power',
    'hour_of_day',
    'day_of_week',
    'device_avg_power',
    'device_max_power',
    'power_to_avg_ratio',
    'appliance_channel',
    'channel_key',
]


class ApplianceModelNotReady(RuntimeError):
    pass


def model_path() -> Path:
    return Path(getattr(settings, 'APPLIANCE_STATE_MODEL_PATH'))


def reading_channel(reading: TelemetryReading) -> int | None:
    if reading.channel:
        return int(reading.channel)
    if reading.appliance:
        return int(reading.appliance.channel)
    return None


def reading_channel_key(reading: TelemetryReading) -> str:
    channel = reading_channel(reading)
    return f'{reading.device_id}:ch{channel}' if channel else f'{reading.device_id}:global'


def channel_history(reading: TelemetryReading):
    queryset = TelemetryReading.objects.filter(device_id=reading.device_id)
    channel = reading_channel(reading)
    if channel:
        return queryset.filter(channel=channel)
    return queryset.filter(appliance_id__isnull=True)


def telemetry_to_features(reading: TelemetryReading) -> pd.DataFrame:
    ts = timezone.localtime(reading.timestamp)
    stats = channel_history(reading).exclude(pk=reading.pk).aggregate(
        avg_power=Avg('power'),
        max_power=Max('power'),
    )
    avg_power = float(stats['avg_power'] or reading.power or 0.0)
    max_power = float(stats['max_power'] or reading.power or 0.0)
    ratio = float(reading.power or 0.0) / max(avg_power, 1e-6)

    return pd.DataFrame([{
        'current': float(reading.current or 0.0),
        'power': float(reading.power or 0.0),
        'hour_of_day': int(ts.hour),
        'day_of_week': int(ts.weekday()),
        'device_avg_power': avg_power,
        'device_max_power': max_power,
        'power_to_avg_ratio': ratio,
        'appliance_channel': int(reading_channel(reading) or 0),
        'channel_key': reading_channel_key(reading),
    }], columns=FEATURE_COLUMNS)


@lru_cache(maxsize=1)
def load_appliance_model() -> dict:
    path = model_path()
    if not path.exists():
        raise ApplianceModelNotReady(f'Appliance state model not found at {path}')
    bundle = joblib.load(path)
    if not isinstance(bundle, dict) or 'pipeline' not in bundle or 'features' not in bundle:
        raise ApplianceModelNotReady('Invalid appliance state model artifact.')
    if list(bundle['features']) != FEATURE_COLUMNS:
        raise ApplianceModelNotReady('Appliance state model feature schema mismatch.')
    return bundle


def clear_appliance_model_cache():
    load_appliance_model.cache_clear()


def appliance_model_status() -> dict:
    path = model_path()
    status = {'ready': False, 'model_path': str(path), 'exists': path.exists()}
    try:
        bundle = load_appliance_model()
    except ApplianceModelNotReady as exc:
        status['error'] = str(exc)
        return status
    status.update({
        'ready': True,
        'model_version': bundle.get('model_version'),
        'trained_at': bundle.get('trained_at'),
        'training_rows': bundle.get('training_rows'),
        'features': bundle.get('features'),
    })
    return status



def predict_appliance_state(reading: TelemetryReading) -> dict[str, Any]:
    features = telemetry_to_features(reading)
    try:
        bundle = load_appliance_model()
        pipeline = bundle['pipeline']
        predicted_state = str(pipeline.predict(features)[0])
        confidence = 0.0
        if hasattr(pipeline, 'predict_proba'):
            probabilities = pipeline.predict_proba(features)[0]
            confidence = float(max(probabilities))
        reason = 'RandomForest appliance behavior model prediction.'
        model_version = bundle.get('model_version', 'unknown')
    except ApplianceModelNotReady as exc:
        predicted_state, confidence, reason = fallback_prediction(reading)
        model_version = 'fallback'
        reason = f'{reason} {exc}'

    power = float(reading.power or 0.0)
    idle_power_watts = float(getattr(settings, 'APPLIANCE_IDLE_POWER_THRESHOLD_WATTS', 2.0))
    idle_current_amps = float(getattr(settings, 'APPLIANCE_IDLE_CURRENT_THRESHOLD_AMPS', 0.02))
    phantom_power_watts = float(getattr(settings, 'APPLIANCE_PHANTOM_CUTOFF_POWER_WATTS', 25.0))

    if power <= idle_power_watts and float(reading.current or 0.0) <= idle_current_amps:
        predicted_state = STATE_IDLE
        confidence = max(float(confidence), 0.92)
        reason = (
            f'{reason} Low-load override: {power:.1f}W is below the idle threshold.'
        )
    elif 3.0 <= power <= phantom_power_watts:
        predicted_state = STATE_PHANTOM_LOAD
        confidence = max(float(confidence), 0.88)
        reason = (
            f'{reason} Standby override: {power:.1f}W is inside the phantom cutoff band.'
        )

    prior_max = float(features.loc[0, 'device_max_power'] or 0.0)
    prior_avg = float(features.loc[0, 'device_avg_power'] or 0.0)
    has_prior_history = channel_history(reading).exclude(pk=reading.pk).count() >= 5
    abnormal_floor = max(60.0, prior_max * 1.35, prior_avg * 2.5)
    if has_prior_history and power > abnormal_floor:
        predicted_state = STATE_ABNORMAL
        confidence = max(float(confidence), 0.9)
        reason = (
            f'{reason} Channel-specific deviation: {power:.1f}W exceeds learned '
            f'normal max {prior_max:.1f}W.'
        )

    return {
        'predicted_state': predicted_state,
        'confidence_score': round(confidence, 4),
        'reason': reason,
        'features': features.iloc[0].to_dict(),
        'model_version': model_version,
    }


def fallback_prediction(reading: TelemetryReading) -> tuple[str, float, str]:
    current = float(reading.current or 0.0)
    power = float(reading.power or 0.0)
    ts = timezone.localtime(reading.timestamp)
    hour = ts.hour

    # 1. Peak Surge / Overcurrent Anomaly
    if power > 2300 or current > 10.0:
        return STATE_ABNORMAL, 0.95, 'Overcurrent surge: unsafe heavy load limit breached.'
    
    # 2. Time-of-day Standby Load (1:00 AM - 5:00 AM)
    if (1 <= hour <= 5) and (3.0 <= power <= 25.0):
        return STATE_PHANTOM_LOAD, 0.88, 'Time-of-day anomaly: standby power drawn during sleeping hours.'
        
    # 3. Active Load
    if power > 25.0:
        return STATE_ACTIVE, 0.85, 'Normal active appliance consumption.'

    # 4. Low Standby / Idle State
    if 3.0 <= power <= 25.0:
        return STATE_PHANTOM_LOAD, 0.75, 'Standby idle state.'
        
    return STATE_IDLE, 0.62, 'Device turned off.'


def consecutive_state_hits(reading: TelemetryReading, predicted_state: str, required_hits: int) -> int:
    if required_hits <= 1:
        return 1

    hits = 1
    prior_predictions = ApplianceStatePrediction.objects.filter(
        device_id=reading.device_id,
        appliance_channel=reading_channel(reading),
        telemetry__timestamp__lte=reading.timestamp,
    ).exclude(
        telemetry_id=reading.pk,
    ).order_by('-telemetry__timestamp', '-id')[:required_hits - 1]

    for prediction in prior_predictions:
        if prediction.predicted_state != predicted_state:
            break
        hits += 1
    return hits


def should_cutoff(reading: TelemetryReading, predicted_state: str) -> tuple[bool, str]:
    if not getattr(settings, 'APPLIANCE_CUTOFF_ENABLED', True):
        return False, 'Automatic cutoff disabled.'
    if predicted_state not in {STATE_IDLE, STATE_PHANTOM_LOAD}:
        return False, 'Only idle or confirmed phantom sockets are eligible for automatic cutoff.'
    if not reading.appliance:
        return False, 'Global telemetry reading does not trigger cutoff.'
    if not reading.appliance.active:
        return False, 'Appliance is already turned off.'

    power = float(reading.power or 0.0)
    current = float(reading.current or 0.0)

    cutoff_seconds = int(getattr(settings, 'APPLIANCE_IDLE_CUTOFF_SECONDS', 8))

    # Check activation safety window to prevent immediately shutting off a newly turned on relay
    activation_time = get_activation_time(reading.appliance_id)
    if not activation_time:
        # If active in DB but no record in memory, initialize it now with current timestamp
        record_activation(reading.appliance_id, reading.timestamp)
        activation_time = reading.timestamp

    time_since_activation = (reading.timestamp - activation_time).total_seconds()
    if time_since_activation < cutoff_seconds:
        return False, f'Appliance was recently turned on ({int(time_since_activation)}s ago).'
    
    if predicted_state == STATE_PHANTOM_LOAD:
        required_hits = int(getattr(settings, 'APPLIANCE_PHANTOM_CUTOFF_HITS', 3))
        hits = consecutive_state_hits(reading, predicted_state, required_hits)
        if hits < required_hits:
            return False, (
                f'Phantom load needs {required_hits} consecutive confirmations; '
                f'currently {hits}.'
            )

        phantom_power_watts = float(getattr(settings, 'APPLIANCE_PHANTOM_CUTOFF_POWER_WATTS', 25.0))
        if power > phantom_power_watts:
            return False, (
                f'Phantom prediction is above the standby cutoff ceiling '
                f'({power:.1f}W > {phantom_power_watts:.1f}W).'
            )

    confirmation_readings = max(1, int(getattr(settings, 'APPLIANCE_CUTOFF_CONFIRMATION_READINGS', 3)))
    recent = list(TelemetryReading.objects.filter(
        device_id=reading.device_id,
        channel=reading_channel(reading),
        timestamp__lte=reading.timestamp,
    ).order_by('-timestamp', '-id')[:confirmation_readings])
    if len(recent) < confirmation_readings:
        return False, (
            f'Need {confirmation_readings} recent telemetry readings; '
            f'currently {len(recent)}.'
        )
        
    idle_power_watts = float(getattr(settings, 'APPLIANCE_IDLE_POWER_THRESHOLD_WATTS', 2.0))
    idle_current_amps = float(getattr(settings, 'APPLIANCE_IDLE_CURRENT_THRESHOLD_AMPS', 0.02))
    if predicted_state == STATE_IDLE:
        has_load = any(
            float(sample.power or 0.0) > idle_power_watts or
            float(sample.current or 0.0) > idle_current_amps
            for sample in recent
        )
        if has_load:
            return False, 'Latest telemetry still has measurable load.'
    elif any(float(sample.power or 0.0) > phantom_power_watts for sample in recent):
        return False, 'Latest telemetry exceeded the phantom standby ceiling.'

    if predicted_state == STATE_PHANTOM_LOAD:
        return True, (
            f'Channel {reading_channel(reading)} has shown phantom standby for '
            f'{hits} consecutive windows at {power:.1f}W/{current:.3f}A.'
        )
    return True, f'Channel {reading_channel(reading)} has been idle continuously for {cutoff_seconds} seconds.'


def publish_cutoff_command(reading: TelemetryReading) -> str:
    import os
    import ssl

    broker = os.getenv('MQTT_BROKER', 'broker.hivemq.com')
    port = int(os.getenv('MQTT_PORT', 1883))
    username = os.getenv('MQTT_USER')
    password = os.getenv('MQTT_PASSWORD')
    
    topic = getattr(settings, 'APPLIANCE_CUTOFF_COMMAND_TOPIC', 'aether/pairing/command')

    auth = {'username': username, 'password': password} if username and password else None
    tls = {'ca_certs': None, 'cert_reqs': ssl.CERT_NONE, 'tls_version': ssl.PROTOCOL_TLS} if port == 8883 else None
    
    # Resolve channel ID and MAC for the subnode relay control
    payload = {
        'mac': reading.device.mac_address if reading.device else reading.device_id,
        'action': 'CONTROL_RELAY',
        'channel': reading_channel(reading) or 1,
        'state': False  # Turn OFF
    }
    
    mqtt_publish.single(topic, payload=json.dumps(payload), hostname=broker, port=port, auth=auth, tls=tls)
    print(f"Dynamic Auto-Cutoff published to MQTT: {payload}")
    return topic


def predict_log_and_act(reading: TelemetryReading) -> ApplianceStatePrediction:
    if hasattr(reading, 'prediction'):
        return reading.prediction

    result = predict_appliance_state(reading)
    predicted_state = result['predicted_state']
    action_taken = ''
    cutoff, cutoff_reason = should_cutoff(reading, predicted_state)
    reason = f"{result['reason']} {cutoff_reason}".strip()

    if cutoff:
        try:
            topic = publish_cutoff_command(reading)
            action_taken = f'RELAY_OFF:{topic}'
            reason = f'{reason} Automatic power cutoff executed.'
            # Mark the appliance channel as inactive in the database
            if reading.appliance:
                reading.appliance.active = False
                reading.appliance.save()
                clear_activation(reading.appliance_id)
        except Exception as exc:
            action_taken = 'CUTOFF_FAILED'
            reason = f'{reason} MQTT cutoff failed: {exc}'

    return ApplianceStatePrediction.objects.create(
        telemetry=reading,
        device_ref=reading.device_ref,
        device_id=reading.device_id,
        appliance_id=reading.appliance_id,
        appliance_channel=reading_channel(reading),
        channel_key=reading_channel_key(reading),
        predicted_state=predicted_state,
        confidence_score=result['confidence_score'],
        action_taken=action_taken,
        reason=reason,
    )
