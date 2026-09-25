"""Validate the feature maths and rule thresholds without any hardware.

    python selftest.py

Synthesises the current waveforms of a filament bulb and a non-PFC charger,
adds ACS712-grade noise, and checks that the features land where theory says
they should and that the rule labels them correctly. Run this after changing
any threshold in load_signature.py or Waveform.h - the two must stay in step.
"""

from __future__ import annotations

import numpy as np

from load_signature import (
    BINS,
    CLASS_MIXED,
    CLASS_RESISTIVE,
    CLASS_SMPS,
    classify,
    classify_by_rule,
    decode_waveform,
    extract_features,
)

RNG = np.random.default_rng(7)


def filament_bulb(amplitude: float = 1.0) -> np.ndarray:
    """Resistive load: current follows voltage exactly, so a clean sine."""
    t = np.arange(BINS) / BINS
    return amplitude * np.sin(2 * np.pi * t)


def non_pfc_smps(amplitude: float = 1.0, threshold: float = 0.88) -> np.ndarray:
    """Switch-mode supply with no PFC: the rectifier only conducts while the
    mains exceeds the reservoir-capacitor voltage, so current appears as a
    narrow pulse near each voltage peak and is zero the rest of the cycle.
    `threshold` is that capacitor voltage as a fraction of the mains peak;
    0.88 gives the ~25% conduction angle typical of a cheap barrel-plug brick."""
    t = np.arange(BINS) / BINS
    voltage = np.sin(2 * np.pi * t)
    pulse = np.where(np.abs(voltage) > threshold, np.abs(voltage) - threshold, 0.0)
    current = pulse * np.sign(voltage)
    peak = np.max(np.abs(current)) or 1.0
    return amplitude * current / peak


def coherently_averaged(wave: np.ndarray, noise_adc: float, cycles: int = 16) -> np.ndarray:
    """Mimic the firmware: add per-cycle noise, then average `cycles` of them."""
    stack = wave[None, :] + RNG.normal(0.0, noise_adc, size=(cycles, BINS))
    return stack.mean(axis=0)


def quantise_roundtrip(wave: np.ndarray) -> np.ndarray:
    """Mimic the int8 + base64 transport to confirm it preserves the shape."""
    import base64

    peak = np.max(np.abs(wave)) or 1.0
    quantised = np.clip(np.round(wave / peak * 127), -127, 127).astype(np.int8)
    return decode_waveform(base64.b64encode(quantised.tobytes()).decode())


def report(name: str, wave: np.ndarray, expected: str) -> bool:
    features = extract_features(wave)
    label, confidence, reason = classify_by_rule(features)
    ok = label == expected
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
    print(f"      crest {features['crest']:.2f}  form {features['form_factor']:.2f}  "
          f"conduction {features['conduction']:.2f}  THD {features['thd']:.2f}  "
          f"h3 {features['h3']:.2f}")
    print(f"      -> {label} ({confidence:.0%})  expected {expected}")
    print(f"      {reason}\n")
    return ok


def main() -> int:
    print("Theoretical reference: pure sine has crest 1.414, form 1.111, THD 0.\n")
    results = []

    # A 40W filament bulb is ~0.17A. On a 30A ACS712 that is ~14 ADC steps of
    # amplitude against ~4 steps of noise - the case that needs the averaging.
    results.append(report(
        "filament bulb, clean", filament_bulb(14.0), CLASS_RESISTIVE))
    # Deliberately expects MIXED, not RESISTIVE: a single raw cycle at this SNR
    # does NOT classify correctly. This is the case that justifies WF_CYCLES -
    # if this ever starts passing as RESISTIVE, the noise model has gone soft.
    results.append(report(
        "filament bulb, 1 raw cycle (must fail - this is why we average)",
        filament_bulb(14.0) + RNG.normal(0, 4.0, BINS), CLASS_MIXED))
    results.append(report(
        "filament bulb, 16 cycles averaged",
        coherently_averaged(filament_bulb(14.0), 4.0), CLASS_RESISTIVE))

    # A 65W charger is ~0.28A but pulls it in short spikes, so its peak is high
    # while its RMS stays modest - exactly what crest factor measures.
    results.append(report(
        "non-PFC charger, clean", non_pfc_smps(24.0), CLASS_SMPS))
    results.append(report(
        "non-PFC charger, 16 cycles averaged",
        coherently_averaged(non_pfc_smps(24.0), 4.0), CLASS_SMPS))

    results.append(report(
        "charger after int8 + base64 transport",
        quantise_roundtrip(coherently_averaged(non_pfc_smps(24.0), 4.0)), CLASS_SMPS))
    results.append(report(
        "bulb after int8 + base64 transport",
        quantise_roundtrip(coherently_averaged(filament_bulb(14.0), 4.0)), CLASS_RESISTIVE))

    # Amplitude invariance is the whole point: the same shape a decade apart in
    # size must classify identically, which is why a broken amp calibration
    # cannot break the classifier.
    small = extract_features(non_pfc_smps(3.0))
    large = extract_features(non_pfc_smps(300.0))
    drift = max(abs(small[k] - large[k]) for k in small)
    scale_ok = drift < 1e-6
    print(f"{'PASS' if scale_ok else 'FAIL'}  scale invariance: "
          f"largest feature drift across a 100x amplitude change = {drift:.2e}\n")
    results.append(scale_ok)

    # Shape distance, mirroring shapeDistance() in WaveformBench.ino. This is
    # what the sketch's "match" command uses to decide whether the thing plugged
    # in now is the same device it has stored. The gap between same-load and
    # different-load distances is what justifies the 0.25 threshold there.
    def shape_distance(a: np.ndarray, b: np.ndarray) -> float:
        a = a / (np.max(np.abs(a)) or 1.0)
        b = b / (np.max(np.abs(b)) or 1.0)
        return float(np.sqrt(np.mean((a - b) ** 2)))

    same_bulb = shape_distance(coherently_averaged(filament_bulb(14.0), 4.0),
                               coherently_averaged(filament_bulb(14.0), 4.0))
    bigger_bulb = shape_distance(coherently_averaged(filament_bulb(14.0), 4.0),
                                 coherently_averaged(filament_bulb(22.0), 4.0))
    same_charger = shape_distance(coherently_averaged(non_pfc_smps(24.0), 4.0),
                                  coherently_averaged(non_pfc_smps(24.0), 4.0))
    across = shape_distance(coherently_averaged(filament_bulb(14.0), 4.0),
                            coherently_averaged(non_pfc_smps(24.0), 4.0))

    print("Shape distance (WaveformBench 'match' uses 0.25 as the cut):")
    print(f"      bulb vs same bulb        {same_bulb:.3f}")
    print(f"      40W bulb vs 60W bulb     {bigger_bulb:.3f}   (size must not matter)")
    print(f"      charger vs same charger  {same_charger:.3f}")
    print(f"      bulb vs charger          {across:.3f}")
    separated = max(same_bulb, bigger_bulb, same_charger) < 0.25 < across
    print(f"{'PASS' if separated else 'FAIL'}  0.25 separates same-device from different-device\n")
    results.append(separated)

    # End-to-end through classify(), which is what the backend actually calls.
    verdict = classify(coherently_averaged(non_pfc_smps(24.0), 4.0))
    end_to_end = verdict["label"] == CLASS_SMPS
    print(f"{'PASS' if end_to_end else 'FAIL'}  classify() end to end -> "
          f"{verdict['label']} via {verdict['source']}\n")
    results.append(end_to_end)

    passed = sum(1 for r in results if r)
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
