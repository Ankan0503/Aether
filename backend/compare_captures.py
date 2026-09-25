"""Draw every captured device side by side from captures/captures.csv.

    python compare_captures.py
    python compare_captures.py --only BULB-100W CHARGER-BARREL-LONG CHARGER-USBC-100W

One row per device: the measured waveform against a pure sine of the same RMS,
with the shape features underneath. Rows are ordered by crest factor, so the
progression from resistive to switching reads left to right down the page.

This is the figure to put in a pitch: it shows three devices that no wattage
reading could tell apart being separated by shape alone.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

import numpy as np

from load_signature import BINS, classify_by_rule, extract_features

COLOR_MEASURED = "#2a78d6"
COLOR_REFERENCE = "#eb6834"
COLOR_INK = "#1a1a1a"
COLOR_MUTED = "#6b7280"
COLOR_GRID = "#e5e7eb"

# Captures whose label marks them as diagnostics rather than devices.
SKIP_PREFIXES = ("BASELINE", "ISOLATION", "TEST")

PRETTY = {
    "RESISTIVE": "RESISTIVE",
    "SMPS": "SWITCHING SUPPLY",
    "MIXED": "MIXED / PARTIAL PFC",
    "NONE": "NOTHING DETECTED",
}


def load_rows(csv_path: Path, only: list[str] | None) -> list[tuple[str, np.ndarray]]:
    rows: dict[str, np.ndarray] = {}
    with csv_path.open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            label = row["label"]
            if only and label not in only:
                continue
            if not only and label.upper().startswith(SKIP_PREFIXES):
                continue
            try:
                cycle = np.array([float(row[f"s{i}"]) for i in range(BINS)])
            except (KeyError, TypeError, ValueError):
                continue
            rows[label] = cycle - cycle.mean()   # last capture of each label wins
    return list(rows.items())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", type=Path, default=Path("captures/captures.csv"))
    parser.add_argument("--only", nargs="*", default=None, help="labels to include, in any order")
    parser.add_argument("--out", type=Path, default=Path("captures/comparison.png"))
    args = parser.parse_args()

    if not args.csv.exists():
        print(f"{args.csv} not found - run capture_once.py first", file=sys.stderr)
        return 1

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib is required:  pip install matplotlib", file=sys.stderr)
        return 1

    entries = load_rows(args.csv, args.only)
    if not entries:
        print("No device captures found.", file=sys.stderr)
        return 1

    scored = []
    for label, cycle in entries:
        features = extract_features(cycle)
        verdict, _confidence, _reason = classify_by_rule(features)
        scored.append((features["crest"], label, cycle, features, verdict))
    scored.sort()   # most sine-like first

    time_ms = np.linspace(0, 20, BINS, endpoint=False)
    figure, axes_list = plt.subplots(1, len(scored), figsize=(6 * len(scored), 5.2))
    if len(scored) == 1:
        axes_list = [axes_list]

    for axes, (_crest, label, cycle, features, verdict) in zip(axes_list, scored):
        rms = float(np.sqrt(np.mean(cycle ** 2)))
        axes.plot(time_ms, rms * np.sqrt(2) * np.sin(2 * np.pi * time_ms / 20),
                  linewidth=2, color=COLOR_REFERENCE, linestyle="--",
                  label="Pure sine (same RMS)")
        axes.plot(time_ms, cycle, linewidth=2, color=COLOR_MEASURED, label="Measured current")

        axes.set_title(f"{label}\n{PRETTY.get(verdict, verdict)}", color=COLOR_INK,
                       fontsize=12, fontweight="bold", loc="left", linespacing=1.5)
        axes.set_xlim(0, 20)
        span = max(float(np.max(np.abs(cycle))), rms * 1.5, 1.0) * 1.3
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
                  f"crest {features['crest']:.2f}   conduction {features['conduction']*100:.0f}%"
                  f"   THD {features['thd']:.2f}",
                  transform=axes.transAxes, color=COLOR_MUTED, fontsize=9, family="monospace")

    figure.suptitle("Same socket, same sensor - the shape says what is plugged in",
                    color=COLOR_INK, fontsize=14, fontweight="bold", x=0.008, ha="left")
    figure.tight_layout(rect=(0, 0, 1, 0.94))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(args.out, dpi=150, facecolor="white", bbox_inches="tight")
    print(f"Wrote {args.out.resolve()}")
    for _crest, label, _cycle, features, verdict in scored:
        print(f"  {label:<24} crest {features['crest']:5.2f}   THD {features['thd']:5.2f}"
              f"   conduction {features['conduction']*100:3.0f}%   -> {verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
