"""Live oscilloscope for the current waveform coming off the ESP32.

    python live_plot.py COM5

Opens a window showing one mains cycle of current as the ESP32 measures it,
updating about twice a second, with a perfect sine drawn behind it at the same
RMS for comparison. The gap between the two lines IS the classification: a
filament bulb sits on top of the reference sine, a non-PFC charger collapses
into two narrow spikes and leaves it entirely.

The script drives the sketch for you - it sends "log LIVE" on connect and
"stop" on exit. You still need to close the relay yourself first (type "on 1"
in a serial monitor, or pass --relay 1 to have this do it).

Press "s" in the window to save a PNG of the current trace.
"""

from __future__ import annotations

import argparse
import sys
import threading
from collections import deque
from datetime import datetime
from pathlib import Path

import numpy as np

from load_signature import BINS, classify_by_rule, extract_features

PREFIX = "WFCSV,"
HEADER_FIELDS = 7  # WFCSV, label, rms, crest, form, conduction, thd

# Categorical slots 1 and 2 of the validated palette. Blue is the measured
# signal, orange the reference - an adjacent pair chosen because it stays
# separable under colour-vision deficiency, not because it looks nice.
COLOR_MEASURED = "#2a78d6"
COLOR_REFERENCE = "#eb6834"
COLOR_INK = "#1a1a1a"
COLOR_MUTED = "#6b7280"
COLOR_GRID = "#e5e7eb"

VERDICT_TEXT = {
    "RESISTIVE": "RESISTIVE\nfilament bulb, heater",
    "SMPS": "SWITCHING SUPPLY\nlaptop / phone charger",
    "MIXED": "MIXED\nPFC supply, or two loads",
    "NONE": "NOTHING DETECTED\nrelay off, or too small",
}


class SerialReader(threading.Thread):
    """Reads WFCSV lines in the background so the plot never blocks on serial."""

    def __init__(self, port: str, baud: int):
        super().__init__(daemon=True)
        self.port = port
        self.baud = baud
        self.latest: tuple[np.ndarray, float] | None = None
        self.messages: deque[str] = deque(maxlen=20)
        self.error: str | None = None
        self._serial = None
        self._stop = threading.Event()

    def open(self) -> bool:
        try:
            import serial
        except ImportError:
            self.error = "pyserial is required:  pip install pyserial"
            return False
        try:
            self._serial = serial.Serial(self.port, self.baud, timeout=1)
        except Exception as exc:  # noqa: BLE001 - surfaced to the user
            self.error = f"could not open {self.port}: {exc}"
            return False
        return True

    def send(self, command: str) -> None:
        if self._serial is not None:
            self._serial.write((command + "\n").encode())

    def run(self) -> None:
        while not self._stop.is_set() and self._serial is not None:
            try:
                raw = self._serial.readline().decode("utf-8", errors="replace")
            except Exception as exc:  # noqa: BLE001 - port unplugged mid-run
                self.error = str(exc)
                return
            if not raw.strip():
                continue
            if not raw.startswith(PREFIX):
                self.messages.append(raw.strip())
                continue
            parts = raw.strip().split(",")
            if len(parts) < HEADER_FIELDS + BINS:
                continue
            try:
                rms = float(parts[2])
                cycle = np.array([float(v) for v in parts[HEADER_FIELDS:HEADER_FIELDS + BINS]])
            except ValueError:
                continue
            self.latest = (cycle - cycle.mean(), rms)

    def close(self) -> None:
        self._stop.set()
        if self._serial is not None:
            try:
                self.send("stop")
                self._serial.close()
            except Exception:  # noqa: BLE001 - best effort on the way out
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("port", help="serial port, e.g. COM5 or /dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--channel", type=int, default=1, help="sensor channel to watch (1-4)")
    parser.add_argument("--relay", type=int, default=None,
                        help="close this relay on start (1-4). Omit to leave the relays alone.")
    parser.add_argument("--save-dir", type=Path, default=Path("captures"))
    args = parser.parse_args()

    try:
        import matplotlib.pyplot as plt
        from matplotlib.animation import FuncAnimation
    except ImportError:
        print("matplotlib is required:  pip install matplotlib", file=sys.stderr)
        return 1

    reader = SerialReader(args.port, args.baud)
    if not reader.open():
        print(reader.error, file=sys.stderr)
        return 1
    reader.start()

    if args.relay is not None:
        reader.send(f"on {args.relay}")
    reader.send(f"ch {args.channel}")
    reader.send("log LIVE")
    print(f"Connected to {args.port}. Close the window to stop.")

    # One cycle of 50Hz mains is 20ms; the x axis is time within that cycle.
    time_ms = np.linspace(0, 20, BINS, endpoint=False)

    figure, axes = plt.subplots(figsize=(11, 5.5))
    figure.canvas.manager.set_window_title("Aether - live load signature")

    reference_line, = axes.plot([], [], linewidth=2, color=COLOR_REFERENCE,
                                linestyle="--", label="Pure sine (same RMS)")
    measured_line, = axes.plot([], [], linewidth=2, color=COLOR_MEASURED,
                               label="Measured current")

    axes.set_xlim(0, 20)
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

    title = axes.set_title("Waiting for data...", color=COLOR_INK,
                           fontsize=14, fontweight="bold", loc="left")
    readout = figure.text(0.015, 0.02, "", color=COLOR_MUTED, fontsize=9, family="monospace")

    state: dict[str, object] = {"features": None, "label": "NONE"}

    def update(_frame):
        if reader.error:
            title.set_text(f"Serial error: {reader.error}")
            return measured_line, reference_line, title, readout
        if reader.latest is None:
            return measured_line, reference_line, title, readout

        cycle, rms_adc = reader.latest
        features = extract_features(cycle)
        label, confidence, _reason = classify_by_rule(features)
        if rms_adc <= 0:
            label = "NONE"
        state["features"], state["label"] = features, label

        measured_line.set_data(time_ms, cycle)

        # A sine at the same RMS as the measurement. Equal area under the curve,
        # so any visible difference is shape alone - which is what we classify on.
        rms = float(np.sqrt(np.mean(cycle ** 2)))
        reference_line.set_data(time_ms, rms * np.sqrt(2) * np.sin(2 * np.pi * time_ms / 20))

        span = max(float(np.max(np.abs(cycle))), rms * 1.5, 1.0) * 1.25
        axes.set_ylim(-span, span)

        title.set_text(VERDICT_TEXT.get(label, label).replace("\n", "  -  ")
                       + f"   ({confidence:.0%} confident)")
        title.set_color(COLOR_MEASURED if label == "RESISTIVE" else
                        COLOR_REFERENCE if label == "SMPS" else COLOR_MUTED)
        readout.set_text(
            f"crest {features['crest']:5.2f}   form {features['form_factor']:5.2f}   "
            f"conduction {features['conduction']*100:3.0f}%   THD {features['thd']:5.2f}   "
            f"h3 {features['h3']:4.2f}   amplitude {rms_adc:.1f} ADC RMS      "
            f"[pure sine: crest 1.41, form 1.11, THD 0.00]"
        )
        return measured_line, reference_line, title, readout

    def on_key(event):
        if event.key != "s":
            return
        args.save_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = args.save_dir / f"{state['label']}-{stamp}.png"
        figure.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
        print(f"Saved {path}")

    figure.canvas.mpl_connect("key_press_event", on_key)
    animation = FuncAnimation(figure, update, interval=250, blit=False, cache_frame_data=False)

    try:
        plt.show()
    finally:
        del animation
        reader.close()
        if reader.messages:
            print("\nLast messages from the board:")
            for message in list(reader.messages)[-5:]:
                print("  ", message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
