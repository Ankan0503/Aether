"""Load-type classification from AC current waveform shape.

The firmware (firmware/Waveform.h) coherently averages 16 mains cycles into one
64-bin cycle, normalises it to its own peak, and ships it base64-encoded as an
action="WF" frame.

This module turns that cycle back into features and a label. Every feature is
scale-invariant - computed on the shape after normalisation - so the classifier
is unaffected by ACS712 zero-offset drift, by a mis-set sensitivity constant, or
by a fixed-230V power assumption. Shape survives what magnitude does not.

Reference values for a single cycle:

    load                     crest   form   conduction   THD
    pure sine (theoretical)  1.414   1.111     0.71      0.00
    filament bulb, measured  1.4-1.6 1.1-1.2   0.6-0.75  0.05-0.2
    non-PFC SMPS charger     2.5-3.5 1.5-2.2   0.2-0.35  0.7-1.3
    active-PFC USB-C brick   1.5-1.8 1.15-1.3  0.55-0.7  0.1-0.3

Note the last row: a laptop charger with active PFC deliberately looks like a
resistive load, so it will classify as RESISTIVE or MIXED. That is the sensor
telling the truth, not a bug - claim "load type" in a demo, never "laptop".

No Django import here on purpose: it runs standalone against CSV captured from
the bench sketch, and drops into a Django app later by passing model_dir in.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np


CLASS_NONE = "NONE"
CLASS_RESISTIVE = "RESISTIVE"
CLASS_SMPS = "SMPS"
CLASS_MIXED = "MIXED"
CLASS_ORDER = [CLASS_RESISTIVE, CLASS_SMPS, CLASS_MIXED, CLASS_NONE]

# Order matters: it is the column order the trained model expects.
FEATURE_COLUMNS = [
    "crest",
    "form_factor",
    "conduction",
    "thd",
    "h3",
    "h5",
    "h7",
    "h9",
    "odd_even_ratio",
]

BINS = 64
MODEL_FILENAME = "load_signature_classifier.joblib"
DEFAULT_MODEL_DIR = Path(__file__).resolve().parent / "models"


class WaveformDecodeError(ValueError):
    pass


def decode_waveform(encoded: str, bins: int = BINS) -> np.ndarray:
    """Decode the firmware's base64 int8 cycle into a float array in [-1, 1]."""
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as exc:  # noqa: BLE001 - surfaced as a clean domain error
        raise WaveformDecodeError(f"waveform is not valid base64: {exc}") from exc
    if len(raw) < bins:
        raise WaveformDecodeError(f"expected {bins} samples, decoded {len(raw)}")
    cycle = np.frombuffer(raw[:bins], dtype=np.int8).astype(np.float64) / 127.0
    # The firmware removes DC before sending, but re-centre defensively: a
    # residual offset would inflate RMS and drag crest factor toward 1.
    return cycle - cycle.mean()


def extract_features(cycle: Sequence[float]) -> dict[str, float]:
    """Shape-only features. Amplitude is deliberately not among them."""
    cycle = np.asarray(cycle, dtype=np.float64)
    cycle = cycle - cycle.mean()

    rms = float(np.sqrt(np.mean(cycle ** 2)))
    if rms <= 0:
        return {name: 0.0 for name in FEATURE_COLUMNS}

    peak = float(np.max(np.abs(cycle)))
    mean_abs = float(np.mean(np.abs(cycle)))

    # The window is exactly one mains period, so rfft bin k is harmonic k with
    # no spectral leakage and no windowing required.
    spectrum = np.abs(np.fft.rfft(cycle)) * 2.0 / len(cycle)
    fundamental = float(spectrum[1]) if len(spectrum) > 1 else 0.0
    top = len(cycle) // 4 + 1  # harmonics up to the 16th; above that is ADC noise

    def ratio(k: int) -> float:
        if fundamental <= 0 or k >= len(spectrum):
            return 0.0
        return float(spectrum[k]) / fundamental

    harmonics = spectrum[2:top]
    thd = float(np.sqrt(np.sum(harmonics ** 2)) / fundamental) if fundamental > 0 else 0.0

    # Switch-mode supplies are strongly odd-harmonic; a clean sine and most
    # symmetric loads have almost no even content. The ratio separates genuine
    # SMPS distortion from asymmetry caused by a drifting ADC bias.
    odd = float(np.sum(spectrum[3:top:2] ** 2))
    even = float(np.sum(spectrum[2:top:2] ** 2))
    odd_even = odd / even if even > 1e-12 else (10.0 if odd > 0 else 0.0)

    return {
        "crest": peak / rms,
        "form_factor": rms / mean_abs if mean_abs > 0 else 0.0,
        "conduction": float(np.mean(np.abs(cycle) > 0.25 * peak)),
        "thd": thd,
        "h3": ratio(3),
        "h5": ratio(5),
        "h7": ratio(7),
        "h9": ratio(9),
        "odd_even_ratio": min(odd_even, 10.0),
    }


def classify_by_rule(features: dict[str, float]) -> tuple[str, float, str]:
    """Explainable fallback used until a model is trained, and as the sanity
    check behind the trained model. Returns (label, confidence, reason)."""
    crest = features.get("crest", 0.0)
    thd = features.get("thd", 0.0)
    conduction = features.get("conduction", 0.0)

    if crest < 1.75 and thd < 0.30 and conduction > 0.55:
        return CLASS_RESISTIVE, min(1.0, 0.6 + (0.30 - thd)), (
            f"clean sine: crest {crest:.2f} near 1.41, THD {thd:.2f}, "
            f"conducting {conduction:.0%} of the cycle"
        )

    if crest > 2.20 or thd > 0.60 or conduction < 0.40:
        return CLASS_SMPS, min(1.0, 0.5 + min(thd, 1.0) * 0.4), (
            f"peaky non-sinusoidal draw: crest {crest:.2f}, THD {thd:.2f}, "
            f"conducting only {conduction:.0%} of the cycle"
        )

    return CLASS_MIXED, 0.4, (
        f"between a sine and a switching supply (crest {crest:.2f}, THD {thd:.2f}) - "
        "typical of an active-PFC supply or two loads sharing one socket"
    )


_MODEL_CACHE: dict[str, Any] = {}


def load_model(model_dir: Path | str | None = None) -> dict[str, Any] | None:
    """Load the trained bundle, or None to fall back to the rule."""
    directory = Path(model_dir or DEFAULT_MODEL_DIR)
    path = directory / MODEL_FILENAME
    key = str(path)
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    bundle = None
    if path.exists():
        import joblib

        candidate = joblib.load(path)
        # Refuse a model trained on a different feature set rather than
        # silently feeding it columns in the wrong order.
        if isinstance(candidate, dict) and "model" in candidate:
            if list(candidate.get("features", [])) == FEATURE_COLUMNS:
                bundle = candidate

    _MODEL_CACHE[key] = bundle
    return bundle


def reset_model_cache() -> None:
    _MODEL_CACHE.clear()


def classify(
    cycle: Sequence[float],
    *,
    above_noise_floor: bool = True,
    model_dir: Path | str | None = None,
) -> dict[str, Any]:
    """Full verdict for one captured cycle."""
    if not above_noise_floor:
        return {
            "label": CLASS_NONE,
            "confidence": 1.0,
            "source": "noise_floor",
            "reason": "capture amplitude was below the sensor noise floor",
            "features": {name: 0.0 for name in FEATURE_COLUMNS},
        }

    features = extract_features(cycle)
    rule_label, rule_confidence, reason = classify_by_rule(features)

    bundle = load_model(model_dir)
    if bundle is None:
        return {
            "label": rule_label,
            "confidence": rule_confidence,
            "source": "rule",
            "reason": reason,
            "features": features,
        }

    model = bundle["model"]
    vector = np.array([[features[name] for name in FEATURE_COLUMNS]])
    label = str(model.predict(vector)[0])
    confidence = rule_confidence
    if hasattr(model, "predict_proba"):
        confidence = float(np.max(model.predict_proba(vector)))

    return {
        "label": label,
        "confidence": confidence,
        "source": "model",
        "reason": reason if label == rule_label else f"{reason}; rule disagreed ({rule_label})",
        "features": features,
    }


def classify_payload(payload: dict[str, Any], model_dir: Path | str | None = None) -> dict[str, Any]:
    """Classify a raw action="WF" frame from the node.

    Expects the short keys the firmware emits to stay inside ESP-NOW's 250-byte
    limit: w (base64 cycle), rms (ADC RMS steps), ch (channel), cls (on-device
    label). The device label is kept for comparison but never trusted over the
    server's own recomputed features.
    """
    encoded = payload.get("w")
    if not encoded:
        raise WaveformDecodeError('payload has no "w" waveform field')

    cycle = decode_waveform(encoded)
    above_floor = float(payload.get("rms", 0.0)) > 0.0 and payload.get("cls") != CLASS_NONE
    result = classify(cycle, above_noise_floor=above_floor, model_dir=model_dir)
    result["channel"] = int(payload.get("ch", 0))
    result["device_label"] = payload.get("cls")
    result["rms_adc"] = float(payload.get("rms", 0.0))
    result["cycle"] = cycle.tolist()
    return result


def build_training_frame(samples: Iterable[tuple[Sequence[float], str]]):
    """Turn (cycle, label) pairs into the DataFrame train_classifier.py expects."""
    import pandas as pd

    rows = []
    for cycle, label in samples:
        row = extract_features(cycle)
        row["label"] = label
        rows.append(row)
    return pd.DataFrame(rows, columns=FEATURE_COLUMNS + ["label"])
