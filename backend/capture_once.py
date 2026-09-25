"""Grab a waveform from the ESP32 and write it out as a PNG and a CSV row.

    python capture_once.py --label CHARGER --relay 1

Headless, so it can be run over a terminal session and the resulting image
looked at afterwards - unlike live_plot.py, which needs a desktop window.

It finds the board's serial port by itself, drives the sketch (`ch`, `on`,
`log`), collects several captures, averages them, and saves the result.

Averaging across captures is valid because the firmware anchors every capture to
a rising zero crossing, so they are all in the same phase. Each capture is
already 16 mains cycles averaged; stacking 8 captures on top of that takes the
effective count to 128 cycles, which is what makes a small load legible on a
30A ACS712. It only holds for a steady load - if the device changes state
mid-run (a laptop finishing its charge, say) the average smears, which the
spread figure in the output will show.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from load_signature import BINS, classify_by_rule, extract_features

PREFIX = "WFCSV,"
HEADER_FIELDS = 7

COLOR_MEASURED = "#2a78d6"
COLOR_REFERENCE = "#eb6834"
COLOR_INK = "#1a1a1a"
COLOR_MUTED = "#6b7280"
COLOR_GRID = "#e5e7eb"

VERDICT = {
    "RESISTIVE": "RESISTIVE  -  filament bulb, heater, iron",
    "SMPS": "SWITCHING SUPPLY  -  laptop / phone charger, LED driver, TV",
    "MIXED": "MIXED  -  active-PFC supply, or two loads on one socket",
    "NONE": "NOTHING DETECTED  -  relay open, or load below the noise floor",
}


def find_port(explicit: str | None) -> str | None:
    """Pick the USB-serial bridge, not a Bluetooth virtual port."""
    if explicit:
        return explicit
    import serial.tools.list_ports

    candidates = []
    for port in serial.tools.list_ports.comports():
        description = (port.description or "").lower()
        if "bluetooth" in description:
            continue
        score = 2 if any(chip in description for chip in
                         ("cp210", "ch340", "ch910", "ftdi", "usb serial", "usb-serial")) else 1
        candidates.append((score, port.device, port.description))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    best = candidates[0]
    print(f"Using {best[1]}  ({best[2]})")
    return best[1]


def collect(port_name: str, baud: int, channel: int, relay: int | None,
            wanted: int, timeout_s: float, keep_on: bool) -> tuple[list[np.ndarray], list[float], list[str]]:
    import serial

    cycles: list[np.ndarray] = []
    amplitudes: list[float] = []
    chatter: list[str] = []

    with serial.Serial(port_name, baud, timeout=1) as port:
        time.sleep(2.0)          # ESP32 resets when the port opens; wait for boot
        port.reset_input_buffer()

        def send(command: str) -> None:
            port.write((command + "\n").encode())
            time.sleep(0.25)

        send(f"ch {channel}")
        if relay is not None:
            send(f"on {relay}")
            time.sleep(0.6)      # let the load settle after the contact closes
        send("log CAPTURE")
        # NOTE: whatever happens below, the relay is opened again in the
        # finally block. Leaving a mains socket energised because a capture
        # finished, errored or was interrupted is not acceptable.

        deadline = time.time() + timeout_s
        try:
            while len(cycles) < wanted and time.time() < deadline:
                raw = port.readline().decode("utf-8", errors="replace")
                if not raw.strip():
                    continue
                if not raw.startswith(PREFIX):
                    chatter.append(raw.strip())
                    continue
                parts = raw.strip().split(",")
                if len(parts) < HEADER_FIELDS + BINS:
                    continue
                try:
                    amplitude = float(parts[2])
                    cycle = np.array(
                        [float(v) for v in parts[HEADER_FIELDS:HEADER_FIELDS + BINS]])
                except ValueError:
                    continue
                cycles.append(cycle - cycle.mean())
                amplitudes.append(amplitude)
                print(f"  capture {len(cycles)}/{wanted}   amplitude {amplitude:.1f} ADC RMS")
        finally:
            send("stop")
            if relay is not None and not keep_on:
                send(f"off {relay}")
                print(f"  relay {relay} opened - socket is dead again")

    return cycles, amplitudes, chatter


def render(cycle: np.ndarray, features: dict, label: str, amplitude: float,
           heading: str, spread: float, out_path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    time_ms = np.linspace(0, 20, BINS, endpoint=False)
    rms = float(np.sqrt(np.mean(cycle ** 2)))

    figure, axes = plt.subplots(figsize=(11, 5.5))
    axes.plot(time_ms, rms * np.sqrt(2) * np.sin(2 * np.pi * time_ms / 20),
              linewidth=2, color=COLOR_REFERENCE, linestyle="--", label="Pure sine (same RMS)")
    axes.plot(time_ms, cycle, linewidth=2, color=COLOR_MEASURED, label="Measured current")

    axes.set_title(f"{heading}\n{VERDICT.get(label, label)}", color=COLOR_INK,
                   fontsize=13, fontweight="bold", loc="left", linespacing=1.6)
    axes.set_xlim(0, 20)
    span = max(float(np.max(np.abs(cycle))), rms * 1.5, 1.0) * 1.25
    axes.set_ylim(-span, span)
    axes.set_xlabel("Time within one mains cycle (ms)", color=COLOR_MUTED)
    axes.set_ylabel("Current (ADC steps, zero-centred)", color=COLOR_MUTED)
    axes.axhline(0, color=COLOR_GRID, linewidth=1)
    axes.grid(True, color=COLOR_GRID, linewidth=0.8)
    axes.set_axisbelow(True)
    for side in ("top", "right"):
        axes.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        axes.spines[side].set_color(COLOR_GRID)
    axes.tick_params(colors=COLOR_MUTED)
    axes.legend(loc="upper right", frameon=False, labelcolor=COLOR_MUTED)

    figure.text(0.015, 0.02,
                f"crest {features['crest']:.2f}   form {features['form_factor']:.2f}   "
                f"conduction {features['conduction']*100:.0f}%   THD {features['thd']:.2f}   "
                f"h3 {features['h3']:.2f}   h5 {features['h5']:.2f}   "
                f"amplitude {amplitude:.1f} ADC RMS   spread {spread:.3f}      "
                f"[pure sine: crest 1.41, form 1.11, THD 0.00]",
                color=COLOR_MUTED, fontsize=8.5, family="monospace")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(out_path, dpi=150, facecolor="white", bbox_inches="tight")
    plt.close(figure)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", default=None, help="serial port; auto-detected if omitted")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--label", default="DEVICE", help="what is plugged in, e.g. BULB")
    parser.add_argument("--channel", type=int, default=1, help="sensor channel 1-4")
    parser.add_argument("--relay", type=int, default=None, help="close this relay first (1-4)")
    parser.add_argument("--captures", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=25.0)
    parser.add_argument("--out-dir", type=Path, default=Path("captures"))
    parser.add_argument("--keep-on", action="store_true",
                        help="leave the relay closed afterwards; off by default so a "
                             "finished capture never leaves mains live")
    args = parser.parse_args()

    try:
        import serial  # noqa: F401
    except ImportError:
        print("pyserial is required:  pip install pyserial", file=sys.stderr)
        return 1

    port_name = find_port(args.port)
    if port_name is None:
        print("No serial port found. Is the ESP32 plugged in?", file=sys.stderr)
        return 1

    print(f"Collecting {args.captures} captures from channel {args.channel}...")
    try:
        cycles, amplitudes, chatter = collect(
            port_name, args.baud, args.channel, args.relay, args.captures,
            args.timeout, args.keep_on)
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"Serial error: {exc}", file=sys.stderr)
        print("If a Serial Monitor is open in the Arduino IDE, close it first - "
              "only one program can hold the port.", file=sys.stderr)
        return 1

    if not cycles:
        print("\nNo waveform data arrived.", file=sys.stderr)
        if chatter:
            print("The board said:", file=sys.stderr)
            for line in chatter[-12:]:
                print("  ", line, file=sys.stderr)
        return 1

    # Drop captures that are far below the run's typical amplitude. The first
    # capture after the relay closes often catches the load before it starts
    # drawing (a charger takes a moment to come up), and a loose plug can drop
    # contact mid-run. Either way those are not the device, and averaging them
    # in drags the shape toward noise.
    amplitude_array = np.array(amplitudes)
    typical = float(np.median(amplitude_array))
    keep = amplitude_array > max(typical * 0.5, 3.0)
    dropped = int((~keep).sum())
    if dropped and keep.sum() >= 2:
        print(f"  (discarded {dropped} capture(s) below half the typical amplitude "
              f"- load not drawing yet, or contact lost)")
        cycles = [c for c, k in zip(cycles, keep) if k]
        amplitudes = [a for a, k in zip(amplitudes, keep) if k]

    stack = np.vstack(cycles)
    amplitude = float(np.mean(amplitudes))

    # Normalise each capture to its own peak before averaging and before
    # measuring agreement. A loose plug makes the amplitude wander while the
    # waveform SHAPE stays the same, and shape is the only thing classified -
    # so comparing raw captures would report instability that does not matter.
    peaks = np.max(np.abs(stack), axis=1, keepdims=True)
    peaks[peaks == 0] = 1.0
    normalised = stack / peaks

    # Re-align the captures against each other before averaging. The firmware
    # anchors each capture on a rising zero crossing, which is unambiguous for a
    # sine but not for a switching supply that sits at zero for most of the
    # cycle - so the anchor lands a sample or two differently each time. Summing
    # misaligned captures smears the current spikes flat and drops the measured
    # crest factor well below the truth (seen on a real charger: 2.95 per
    # capture, 1.76 after a naive average). Circular cross-correlation against
    # the first capture puts them back in phase; the cycle is periodic, so
    # rolling it is exact rather than an approximation.
    reference = normalised[0]
    for index in range(1, len(normalised)):
        correlation = np.fft.irfft(
            np.fft.rfft(reference) * np.conj(np.fft.rfft(normalised[index])), n=BINS)
        normalised[index] = np.roll(normalised[index], int(np.argmax(correlation)))
    averaged = normalised.mean(axis=0) * float(np.mean(peaks))

    # Disagreement in shape, not in size.
    signal = float(np.max(np.abs(averaged))) or 1.0
    spread = float(np.mean(np.std(normalised, axis=0))) * float(np.mean(peaks)) / signal

    # Per-capture features, so a wandering amplitude can be told apart from a
    # wandering shape. If crest is steady across captures the reading is good
    # however much the amplitude moved.
    per_capture = [extract_features(c) for c in cycles]
    crest_values = np.array([f["crest"] for f in per_capture])
    thd_values = np.array([f["thd"] for f in per_capture])

    features = extract_features(averaged)
    label, confidence, reason = classify_by_rule(features)
    if amplitude <= 0:
        label = "NONE"

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    png_path = args.out_dir / f"{args.label}-{stamp}.png"
    csv_path = args.out_dir / "captures.csv"

    render(averaged, features, label, amplitude,
           f"{args.label}   ({len(cycles)} captures averaged, {len(cycles) * 16} mains cycles)",
           spread, png_path)

    is_new = not csv_path.exists()
    with csv_path.open("a", encoding="utf-8") as handle:
        if is_new:
            handle.write("label," + ",".join(f"s{i}" for i in range(BINS)) + "\n")
        handle.write(args.label + "," + ",".join(f"{v:.3f}" for v in averaged) + "\n")

    print(f"\n  amplitude    {amplitude:7.1f} ADC RMS")
    print(f"  crest factor {features['crest']:7.2f}   (1.41 = pure sine)")
    print(f"  form factor  {features['form_factor']:7.2f}   (1.11 = pure sine)")
    print(f"  conduction   {features['conduction']*100:6.0f}%")
    print(f"  THD          {features['thd']:7.2f}   (0 = pure sine)")
    print(f"  harmonics    h3 {features['h3']:.2f}  h5 {features['h5']:.2f}  h7 {features['h7']:.2f}")
    print(f"  amplitude spread {np.std(amplitudes) / (amplitude or 1):7.3f}   "
          f"(how much the SIZE moved - a loose plug shows up here and is harmless)")
    print(f"  shape spread {spread:7.3f}   (how much the SHAPE moved - this is the one "
          f"that matters; {'steady' if spread < 0.15 else 'UNSTABLE, treat the verdict with care'})")
    print(f"  crest across captures  {crest_values.mean():.2f} +/- {crest_values.std():.2f}"
          f"   THD  {thd_values.mean():.2f} +/- {thd_values.std():.2f}")
    print(f"\n  VERDICT: {label}  ({confidence:.0%})")
    print(f"  {reason}")
    print(f"\nSaved {png_path}")
    print(f"Appended a row to {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
