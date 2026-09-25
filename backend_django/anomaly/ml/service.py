from functools import lru_cache
from pathlib import Path

import joblib
import pandas as pd
from django.conf import settings


FEATURE_COLUMNS = ['current', 'hour_of_day']
REQUIRED_ARTIFACT_KEYS = ['pipeline', 'features', 'score_reference', 'model_version']


class ModelNotReadyError(RuntimeError):
    """Raised when the trained IsolationForest artifact has not been created yet."""


class InvalidModelArtifactError(ModelNotReadyError):
    """Raised when the artifact exists but cannot safely serve predictions."""


def default_model_path() -> Path:
    return Path(
        getattr(
            settings,
            'ANOMALY_MODEL_PATH',
            Path(settings.BASE_DIR) / 'anomaly' / 'models' / 'phantom_current_iforest.joblib',
        )
    )


def validate_model_bundle(bundle: dict) -> dict:
    if not isinstance(bundle, dict):
        raise InvalidModelArtifactError('Model artifact must be a dictionary bundle.')

    missing = [key for key in REQUIRED_ARTIFACT_KEYS if key not in bundle]
    if missing:
        raise InvalidModelArtifactError(f'Model artifact is missing required key(s): {", ".join(missing)}')

    features = list(bundle.get('features') or [])
    if features != FEATURE_COLUMNS:
        raise InvalidModelArtifactError(
            f'Model artifact features must be {FEATURE_COLUMNS}; got {features}'
        )

    pipeline = bundle['pipeline']
    for method_name in ['predict', 'decision_function']:
        if not hasattr(pipeline, method_name):
            raise InvalidModelArtifactError(f'Model pipeline does not implement {method_name}().')

    score_reference = bundle.get('score_reference', 0.05)
    try:
        score_reference = float(score_reference)
    except (ValueError, TypeError):
        score_reference = 0.05
    if score_reference <= 0:
        raise InvalidModelArtifactError('Model score_reference must be greater than 0.')

    return bundle


@lru_cache(maxsize=1)
def load_model_bundle():
    """
    Load the model once per Django process.

    Real-time predictions should not touch disk on every request, so this cached loader
    keeps the fitted preprocessing pipeline and IsolationForest warm in memory.
    """
    model_path = default_model_path()
    if not model_path.exists():
        raise ModelNotReadyError(f'Model artifact not found at {model_path}')
    return validate_model_bundle(joblib.load(model_path))


def clear_model_cache():
    """Useful after retraining in a long-running process or during tests."""
    load_model_bundle.cache_clear()


def model_status() -> dict:
    model_path = default_model_path()
    status = {
        'ready': False,
        'production_ready': False,
        'model_path': str(model_path),
        'exists': model_path.exists(),
    }

    try:
        bundle = load_model_bundle()
    except ModelNotReadyError as exc:
        status['error'] = str(exc)
        return status

    training_source = bundle.get('training_source', 'unknown')
    status.update({
        'ready': True,
        'production_ready': training_source == 'database',
        'model_version': bundle.get('model_version', 'unknown'),
        'trained_at': bundle.get('trained_at'),
        'training_rows': bundle.get('training_rows'),
        'training_source': training_source,
        'artifact_schema_version': bundle.get('artifact_schema_version', 1),
        'features': bundle.get('features'),
    })

    if training_source != 'database':
        status['warning'] = 'This model was not trained from production database telemetry.'

    return status


def normalize_features(payload: dict) -> pd.DataFrame:
    """
    Convert API JSON into the exact feature frame expected by the sklearn pipeline.
    """
    missing = [name for name in FEATURE_COLUMNS if name not in payload]
    if missing:
        raise ValueError(f'Missing required feature(s): {", ".join(missing)}')

    current = float(payload['current'])
    hour = int(payload['hour_of_day'])

    if current < 0:
        raise ValueError('current must be greater than or equal to 0')
    if hour < 0 or hour > 23:
        raise ValueError('hour_of_day must be between 0 and 23')

    return pd.DataFrame([{
        'current': current,
        'hour_of_day': hour,
    }], columns=FEATURE_COLUMNS)


def _score_to_confidence(score: float, score_reference: float) -> float:
    """
    Convert IsolationForest distance from the decision boundary into 0-1 confidence.
    """
    reference = max(float(score_reference), 1e-6)
    confidence = min(abs(score) / reference, 1.0)
    return round(float(confidence), 4)


def _estimate_energy_waste(current: float, is_anomaly: bool, payload: dict) -> dict:
    """
    Estimate phantom energy for the provided reading window.
    """
    voltage = float(payload.get('voltage', getattr(settings, 'ANOMALY_DEFAULT_VOLTAGE', 230.0)))
    window_minutes = float(payload.get('sample_window_minutes', 1.0))
    baseline = float(payload.get('baseline_current', getattr(settings, 'PHANTOM_BASELINE_CURRENT', 0.0)))

    phantom_current = max(current - baseline, 0.0) if is_anomaly else 0.0
    watts = phantom_current * voltage
    watt_hours = watts * (window_minutes / 60.0)

    return {
        'phantom_current': round(phantom_current, 4),
        'estimated_waste_watts': round(watts, 4),
        'estimated_waste_wh': round(watt_hours, 6),
    }


def predict_phantom_current(payload: dict) -> dict:
    """
    Run a single optimized prediction for the smart home API.
    """
    features = normalize_features(payload)
    current = float(features.loc[0, 'current'])
    hour = int(features.loc[0, 'hour_of_day'])
    voltage = float(payload.get('voltage', getattr(settings, 'ANOMALY_DEFAULT_VOLTAGE', 230.0)))
    power = current * voltage

    try:
        bundle = load_model_bundle()
        pipeline = bundle['pipeline']
        score_reference = bundle.get('score_reference', 0.05)

        raw_prediction = int(pipeline.predict(features)[0])
        decision_score = float(pipeline.decision_function(features)[0])

        is_model_outlier = raw_prediction == -1
        is_phantom_current = bool(is_model_outlier and current > 0)
        confidence = _score_to_confidence(decision_score, score_reference)
        model_version = bundle.get('model_version', 'unknown')
        training_source = bundle.get('training_source', 'unknown')
    except ModelNotReadyError:
        # Fallback to rule-based logic if model isn't trained
        # Standby/phantom load defined as 3.0W - 25.0W
        is_phantom_current = (3.0 <= power <= 25.0)
        decision_score = -0.15 if is_phantom_current else 0.15
        confidence = 0.85 if is_phantom_current else 0.75
        model_version = 'fallback'
        training_source = 'rules'

    waste = _estimate_energy_waste(current, is_phantom_current, payload)

    return {
        'anomaly': is_phantom_current,
        'anomaly_type': 'PHANTOM_CURRENT' if is_phantom_current else 'NORMAL',
        'confidence_score': confidence,
        'decision_score': round(decision_score, 6),
        'estimated_energy_waste': waste,
        'features': {
            'current': current,
            'hour_of_day': hour,
        },
        'model_version': model_version,
        'training_source': training_source,
    }
