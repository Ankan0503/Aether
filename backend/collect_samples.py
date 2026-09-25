"""Capture labelled waveform samples from the WaveformBench sketch over serial.

Usage:
    python collect_samples.py COM5 --out samples.csv

Then, in the serial session the sketch is running:
    1. type   on 1        close the relay so the socket is live
    2. plug in one load
    3. type   log BULB    (or CHARGER, PHONE_CHARGER, FAN, ...)
    4. leave it for ~2 minutes
    5. type   stop
    6. type   off 1, swap the load and repeat

Two minutes at two captures a second is ~240 rows per load, which is plenty for
a decision tree - the signature is stable, so more data buys very little.

The sketch prints lines shaped:
    WFCSV,<label>,<rms>,<crest>,<form>,<conduction>,<thd>,<64 cycle samples>
Only the label and the 64 raw cycle samples are stored. Features are recomputed
in Python at training time so that firmware and backend can never drift apart.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

BINS = 64
PREFIX = "WFCSV,"
HEADER_FIELDS = 7  # WFCSV, label, rms, crest, form, conduction, thd


def parse_line(line: str) -> tuple[str, list[float]] | None:
    if not line.startswith(PREFIX):
        return None
    parts = line.strip().split(",")
    if len(parts) < HEADER_FIELDS + BINS:
        return None
    label = parts[1].strip().upper()
    try:
        cycle = [float(v) for v in parts[HEADER_FIELDS:HEADER_FIELDS + BINS]]
    except ValueError:
        return None
    if not label or label == "UNLABELLED":
        return None
    return label, cycle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("port", help="serial port, e.g. COM5 or /dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--out", default="samples.csv", help="CSV to append to")
    args = parser.parse_args()

    try:
        import serial  # pyserial
    except ImportError:
        print("pyserial is required:  pip install pyserial", file=sys.stderr)
        return 1

    out_path = Path(args.out)
    is_new = not out_path.exists()

    counts: Counter[str] = Counter()
    try:
        with serial.Serial(args.port, args.baud, timeout=1) as port, \
                out_path.open("a", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            if is_new:
                writer.writerow(["label"] + [f"s{i}" for i in range(BINS)])

            print(f"Listening on {args.port}. Drive the sketch with 'log <LABEL>' / 'stop'.")
            print("Ctrl-C when you are done.\n")

            while True:
                raw = port.readline().decode("utf-8", errors="replace")
                if not raw:
                    continue
                parsed = parse_line(raw)
                if parsed is None:
                    # Pass the sketch's own chatter through so the session is usable.
                    if raw.strip():
                        print(raw.rstrip())
                    continue
                label, cycle = parsed
                writer.writerow([label] + [f"{v:.3f}" for v in cycle])
                handle.flush()
                counts[label] += 1
                print(f"\r{dict(counts)}   ", end="", flush=True)
    except KeyboardInterrupt:
        print("\n\nStopped.")
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"\nSerial error: {exc}", file=sys.stderr)
        return 1

    if not counts:
        print("No labelled samples captured - did you type 'log <LABEL>' in the sketch?")
        return 1

    print(f"Wrote {sum(counts.values())} rows to {out_path}")
    for label, count in counts.most_common():
        print(f"  {label:<16} {count}")
    print("\nNext:  python train_classifier.py", out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
