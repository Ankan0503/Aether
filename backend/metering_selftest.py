"""Validate the gateway metering maths with no hardware attached.

    python metering_selftest.py

Ports the algorithm from firmware/AetherGateway/Metering.h and checks it against
loads whose answers are known analytically:

  - a resistive load must give power factor 1.0 and active power equal to
    apparent power
  - a load whose current lags by 60 degrees must give power factor 0.5, and its
    active power must be HALF its apparent power - the case that makes the
    difference between an honest savings figure and an inflated one
  - a distorted but in-phase load (a switching supply) must give a power factor
    below 1 even with zero phase shift, because distortion costs power factor
    too

It also checks that the measured-bias approach survives an offset that is not
half rail, which is the usual cause of a meter reading a steady phantom load
with nothing plugged in.
"""

from __future__ import annotations

import numpy as np

MAINS_HZ = 50
SAMPLE_PAIRS = 1600
CYCLES = 20
PAIRS_PER_CYCLE = SAMPLE_PAIRS // MAINS_HZ
WINDOW = PAIRS_PER_CYCLE * CYCLES

VOLT_CAL = 0.45
CURR_CAL = 0.0122
PHASE_SHIFT = 1.08


def measure(v_raw: np.ndarray, i_raw: np.ndarray, phase_shift: float = PHASE_SHIFT) -> dict:
    """The same arithmetic mtMeasure() performs on the ESP32."""
    v_bias = float(v_raw.mean())
    i_bias = float(i_raw.mean())
    v = v_raw - v_bias
    i = i_raw - i_bias

    # Interpolate voltage forward toward the current sample, as the firmware does.
    previous = np.concatenate(([v[0]], v[:-1]))
    v_aligned = previous + phase_shift * (v - previous)

    v_rms_adc = float(np.sqrt(np.mean(v ** 2)))
    i_rms_adc = float(np.sqrt(np.mean(i ** 2)))
    active = float(np.mean(v_aligned * i)) * VOLT_CAL * CURR_CAL

    v_rms = v_rms_adc * VOLT_CAL
    i_rms = i_rms_adc * CURR_CAL
    apparent = v_rms * i_rms
    pf = active / apparent if apparent > 0.5 else 0.0

    return {
        "v_rms": v_rms, "i_rms": i_rms, "active": active,
        "apparent": apparent, "pf": float(np.clip(pf, -1, 1)),
        "v_rms_adc": v_rms_adc, "i_rms_adc": i_rms_adc,
    }


def build(v_peak_adc: float, i_peak_adc: float, phase_deg: float = 0.0,
          bias: float = 2048.0, distort: bool = False,
          noise: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    t = np.arange(WINDOW) / SAMPLE_PAIRS
    omega = 2 * np.pi * MAINS_HZ
    v = v_peak_adc * np.sin(omega * t)

    if distort:
        # Switch-mode draw: current only flows near the voltage peaks.
        shape = np.where(np.abs(np.sin(omega * t)) > 0.88,
                         np.abs(np.sin(omega * t)) - 0.88, 0.0) * np.sign(np.sin(omega * t))
        i = i_peak_adc * shape / (np.max(np.abs(shape)) or 1.0)
    else:
        i = i_peak_adc * np.sin(omega * t - np.deg2rad(phase_deg))

    rng = np.random.default_rng(3)
    if noise:
        v = v + rng.normal(0, noise, WINDOW)
        i = i + rng.normal(0, noise, WINDOW)
    return v + bias, i + bias


def check(name: str, got: float, expected: float, tolerance: float, unit: str = "") -> bool:
    ok = abs(got - expected) <= tolerance
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {got:.3f}{unit} "
          f"(expected {expected:.3f}{unit} +/- {tolerance}{unit})")
    return ok


def main() -> int:
    results = []
    print("Metering maths, checked against analytically known loads.\n")

    # --- Resistive: current in phase with voltage. PF must be 1. -------------
    print("Resistive load (filament bulb) - current in phase")
    v, i = build(1500, 300, phase_deg=0)
    r = measure(v, i, phase_shift=1.0)   # 1.0 = no correction on this scale
    results.append(check("  power factor", r["pf"], 1.0, 0.01))
    results.append(check("  active vs apparent", r["active"], r["apparent"], 0.5, " W"))
    print()

    # --- Reactive: 60 degrees lag. PF must be cos(60) = 0.5. ----------------
    # This is the case that matters commercially: apparent power is double the
    # active power, so billing from Vrms x Irms would overstate by 100%.
    print("Reactive load (motor) - current lagging 60 degrees")
    v, i = build(1500, 300, phase_deg=60)
    r = measure(v, i, phase_shift=1.0)
    results.append(check("  power factor", r["pf"], 0.5, 0.01))
    ratio = r["active"] / r["apparent"]
    results.append(check("  active/apparent ratio", ratio, 0.5, 0.01))
    print(f"      apparent {r['apparent']:.1f} VA vs active {r['active']:.1f} W - "
          f"billing on VA would overstate by {(r['apparent']/r['active'] - 1) * 100:.0f}%\n")

    # --- Distorted but in phase: PF below 1 from harmonics alone. -----------
    print("Switching supply - in phase, but distorted")
    v, i = build(1500, 300, distort=True)
    r = measure(v, i, phase_shift=1.0)
    distortion_pf_ok = 0.4 < r["pf"] < 0.95
    print(f"{'PASS' if distortion_pf_ok else 'FAIL'}  power factor {r['pf']:.3f} "
          "(must be below 1 despite zero phase shift - distortion costs PF too)")
    results.append(distortion_pf_ok)
    print()

    # --- Bias that is not half rail, which is the real-world case. ----------
    print("Off-centre bias (trim pot not at half rail)")
    v, i = build(1500, 300, phase_deg=0, bias=1750.0)
    r = measure(v, i, phase_shift=1.0)
    results.append(check("  power factor still correct", r["pf"], 1.0, 0.01))
    v_ref, i_ref = build(1500, 300, phase_deg=0, bias=2048.0)
    r_ref = measure(v_ref, i_ref, phase_shift=1.0)
    results.append(check("  active power unchanged by bias",
                         r["active"], r_ref["active"], 0.5, " W"))
    print()

    # --- No load: power and PF must read zero, not noise. -------------------
    print("No load - only sensor noise on the current channel")
    v, i = build(1500, 0, phase_deg=0, noise=3.0)
    r = measure(v, i, phase_shift=1.0)
    floor_ok = r["i_rms_adc"] < 6.0
    print(f"{'PASS' if floor_ok else 'FAIL'}  current reads {r['i_rms_adc']:.2f} ADC rms "
          "- below MT_NOISE_FLOOR_ADC, so the firmware reports zero power")
    results.append(floor_ok)
    print()

    # --- The phase correction must not distort an already-aligned pair much. -
    print("Phase-shift correction sanity")
    v, i = build(1500, 300, phase_deg=0)
    corrected = measure(v, i, phase_shift=PHASE_SHIFT)["pf"]
    penalty = 1.0 - corrected
    ok = penalty < 0.01
    print(f"{'PASS' if ok else 'FAIL'}  applying MT_PHASE_SHIFT={PHASE_SHIFT} to an "
          f"already-aligned pair costs {penalty * 100:.2f}% of PF")
    print("      (it corrects the ADC multiplexing gap on real hardware; on a")
    print("       synthetic simultaneous pair it should cost almost nothing)")
    results.append(ok)
    print()

    passed = sum(1 for r in results if r)
    print(f"{passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
