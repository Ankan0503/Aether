"""Render what the live graph will look like, without any hardware.

    python preview_graph.py

Draws a filament bulb and a non-PFC charger side by side, using the same
simulation as selftest.py and the same styling as live_plot.py, and writes
captures/reference-traces.png.

Use it as the reference for what a good capture looks like. If your real trace
looks roughly like one of these, the rig is working. If it looks like neither -
formless fuzz - the noise floor is swamping the signal and the load is too small
for the sensor.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

from load_signature import BINS, classify_by_rule, extract_features
from selftest import coherently_averaged, filament_bulb, non_pfc_smps

COLOR_MEASURED = "#2a78d6"
COLOR_REFERENCE = "#eb6834"
COLOR_INK = "#1a1a1a"
COLOR_MUTED = "#6b7280"
COLOR_GRID = "#e5e7eb"


def draw(axes, cycle: np.ndarray, heading: str, subtitle: str) -> None:
    time_ms = np.linspace(0, 20, BINS, endpoint=False)
    rms = float(np.sqrt(np.mean(cycle ** 2)))

    axes.plot(time_ms, rms * np.sqrt(2) * np.sin(2 * np.pi * time_ms / 20),
              linewidth=2, color=COLOR_REFERENCE, linestyle="--",
              label="Pure sine (same RMS)")
    axes.plot(time_ms, cycle, linewidth=2, color=COLOR_MEASURED,
              label="Measured current")

    features = extract_features(cycle)
    label, _confidence, _reason = classify_by_rule(features)

    axes.set_title(f"{heading}\n{subtitle}", color=COLOR_INK, fontsize=12,
                   fontweight="bold", loc="left", linespacing=1.5)
    axes.set_xlim(0, 20)
    span = max(float(np.max(np.abs(cycle))), rms * 1.5) * 1.3
    axes.set_ylim(-span, span)
    axes.set_xlabel("Time within one mains cycle (ms)", color=COLOR_MUTED, fontsize=9)
    axes.axhline(0, color=COLOR_GRID, linewidth=1)
    axes.grid(True, color=COLOR_GRID, linewidth=0.8)
    axes.set_axisbelow(True)
    for side in ("top", "right"):
        axes.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        axes.spines[side].set_color(COLOR_GRID)
    axes.tick_params(colors=COLOR_MUTED, labelsize=8)
    axes.legend(loc="upper right", frameon=False, labelcolor=COLOR_MUTED, fontsize=8)

    axes.text(0.02, 0.03,
              f"crest {features['crest']:.2f}   conduction {features['conduction']*100:.0f}%   "
              f"THD {features['thd']:.2f}   ->  {label}",
              transform=axes.transAxes, color=COLOR_MUTED, fontsize=8.5, family="monospace")


def main() -> int:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib is required:  pip install matplotlib", file=sys.stderr)
        return 1

    figure, (left, right) = plt.subplots(1, 2, figsize=(13, 5))

    draw(left, coherently_averaged(filament_bulb(14.0), 4.0),
         "Filament bulb (~40W)",
         "Resistive: current tracks the mains voltage, so it sits on the sine")
    draw(right, coherently_averaged(non_pfc_smps(24.0), 4.0),
         "Laptop charger, no PFC (~65W)",
         "Switching: current only flows in spikes near the voltage peaks")

    figure.suptitle("What your captures should look like  -  simulated at your sensor's noise level",
                    color=COLOR_INK, fontsize=13, fontweight="bold", x=0.012, ha="left")
    figure.tight_layout(rect=(0, 0, 1, 0.95))

    out_dir = Path("captures")
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "reference-traces.png"
    figure.savefig(path, dpi=150, facecolor="white", bbox_inches="tight")
    print(f"Wrote {path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
