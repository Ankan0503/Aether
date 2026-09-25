"""Identify what is plugged into each socket by matching against known captures.

    python identify.py --sockets 1 2 3

For each socket it closes the relay, captures the waveform, then compares the
shape against every reference in captures/captures.csv and reports the closest
match plus the rule-based load type.

Matching on shape distance rather than on thresholds matters because the two
chargers are much closer to each other than either is to the bulb - a threshold
that splits resistive from switching cannot tell a partially-corrected USB-C
brick from a non-PFC barrel one, but their waveforms are visibly different and
a point-by-point comparison picks that up.

Both the references and the live capture are normalised to their own peak and
phase-aligned by cross-correlation before comparison, so amplitude and the
capture's start phase are irrelevant - only shape counts.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

import numpy as np

from capture_once import collect, find_port
from load_signature import BINS, classify_by_rule, extract_features

SKIP_PREFIXES = ("BASELINE", "ISOLATION", "TEST", "SWEEP", "RELAY")

# Distances measured on this rig: the same device against itself sits near 0.1,
# bulb against charger near 0.5. Half way is a safe "is this anything I know".
CONFIDENT = 0.25
UNSURE = 0.40


def load_references(csv_path: Path) -> dict[str, np.ndarray]:
    references: dict[str, np.ndarray] = {}
    with csv_path.open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            label = row["label"]
            if label.upper().startswith(SKIP_PREFIXES):
                continue
            try:
                cycle = np.array([float(row[f"s{i}"]) for i in range(BINS)])
            except (KeyError, TypeError, ValueError):
                continue
            references[label] = cycle - cycle.mean()
    return references


def normalise(cycle: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(cycle)))
    return cycle / peak if peak > 0 else cycle


def aligned_distance(a: np.ndarray, b: np.ndarray) -> float:
    """RMS difference after normalising both and rolling b into phase with a.

    The firmware anchors each capture on a rising zero crossing, which lands a
    sample or two differently on a waveform that sits at zero for most of the
    cycle - so two captures of the same charger can be offset from each other.
    Without re-aligning, that offset alone would read as a different device.
    """
    a_norm, b_norm = normalise(a), normalise(b)
    correlation = np.fft.irfft(np.fft.rfft(a_norm) * np.conj(np.fft.rfft(b_norm)), n=BINS)
    rolled = np.roll(b_norm, int(np.argmax(correlation)))
    return float(np.sqrt(np.mean((a_norm - rolled) ** 2)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sockets", nargs="+", type=int, default=[1, 2, 3])
    parser.add_argument("--port", default=None)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--captures", type=int, default=15)
    parser.add_argument("--timeout", type=float, default=40.0)
    parser.add_argument("--csv", type=Path, default=Path("captures/captures.csv"))
    args = parser.parse_args()

    if not args.csv.exists():
        print(f"{args.csv} not found - capture some references first", file=sys.stderr)
        return 1
    references = load_references(args.csv)
    if not references:
        print("No reference captures found.", file=sys.stderr)
        return 1
    print(f"Known devices: {', '.join(references)}\n")

    port_name = find_port(args.port)
    if port_name is None:
        print("No serial port found.", file=sys.stderr)
        return 1

    results = []
    for socket in args.sockets:
        print(f"--- socket {socket} ---")
        try:
            cycles, amplitudes, _chatter = collect(
                port_name, args.baud, socket, socket, args.captures, args.timeout, False)
        except Exception as exc:  # noqa: BLE001 - CLI boundary
            print(f"  serial error: {exc}", file=sys.stderr)
            return 1

        if not cycles:
            print("  nothing captured\n")
            results.append((socket, None, None, None, 0.0))
            continue

        amplitude = float(np.mean(amplitudes))
        # Align every capture to the first, then average - same reason as above.
        stack = np.vstack([normalise(c) for c in cycles])
        for index in range(1, len(stack)):
            correlation = np.fft.irfft(
                np.fft.rfft(stack[0]) * np.conj(np.fft.rfft(stack[index])), n=BINS)
            stack[index] = np.roll(stack[index], int(np.argmax(correlation)))
        live = stack.mean(axis=0)

        if amplitude < 3.0:
            print(f"  amplitude {amplitude:.1f} - below the noise floor, nothing drawing\n")
            results.append((socket, None, None, None, amplitude))
            continue

        ranked = sorted((aligned_distance(live, ref), name) for name, ref in references.items())
        features = extract_features(live)
        load_type, _confidence, _reason = classify_by_rule(features)

        best_distance, best_name = ranked[0]
        runner_up = ranked[1] if len(ranked) > 1 else None

        print(f"  amplitude {amplitude:.1f} ADC RMS   crest {features['crest']:.2f}   "
              f"conduction {features['conduction']*100:.0f}%   THD {features['thd']:.2f}")
        for distance, name in ranked[:3]:
            print(f"    {name:<24} distance {distance:.3f}")
        print()
        results.append((socket, best_name, best_distance, load_type, amplitude))
        if runner_up and runner_up[0] - best_distance < 0.05:
            print(f"  (careful: {runner_up[1]} is almost as close)\n")

    print("=" * 62)
    for socket, name, distance, load_type, amplitude in results:
        if name is None:
            print(f"  socket {socket}:  EMPTY / not drawing  ({amplitude:.1f} ADC RMS)")
        elif distance <= CONFIDENT:
            print(f"  socket {socket}:  {name}   [{load_type}]   confident (distance {distance:.3f})")
        elif distance <= UNSURE:
            print(f"  socket {socket}:  probably {name}   [{load_type}]   (distance {distance:.3f})")
        else:
            print(f"  socket {socket}:  UNKNOWN - closest is {name} but only at "
                  f"distance {distance:.3f}   [{load_type}]")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
