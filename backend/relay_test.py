"""Check that a relay channel actually opens, using the current sensor as witness.

    python relay_test.py --relay 1 --channel 1

Plug in a load that draws clearly (a bulb), then run this. It closes the relay,
measures, opens it, measures again, and compares.

Everything happens inside ONE serial connection on purpose. Opening the port
resets the ESP32, and the sketch opens every relay on boot - so checking the
relay state with a second connection would always report "open" regardless of
what the contacts were really doing.

A mechanical relay can fail closed: contacts weld together after switching an
inductive or high-inrush load, and the coil then releases with the contacts
still bridged. Since a stuck-closed relay means a socket you cannot turn off,
this is worth knowing about a demo rig before it matters.
"""

from __future__ import annotations

import argparse
import sys
import time

import numpy as np

PREFIX = "WFCSV,"
HEADER_FIELDS = 7


def read_amplitudes(port, count: int, timeout_s: float) -> list[float]:
    values: list[float] = []
    deadline = time.time() + timeout_s
    while len(values) < count and time.time() < deadline:
        raw = port.readline().decode("utf-8", errors="replace")
        if not raw.startswith(PREFIX):
            continue
        parts = raw.strip().split(",")
        if len(parts) < HEADER_FIELDS:
            continue
        try:
            values.append(float(parts[2]))
        except ValueError:
            continue
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", default=None)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--relay", type=int, default=1)
    parser.add_argument("--channel", type=int, default=1)
    parser.add_argument("--samples", type=int, default=6)
    args = parser.parse_args()

    try:
        import serial
        import serial.tools.list_ports
    except ImportError:
        print("pyserial is required:  pip install pyserial", file=sys.stderr)
        return 1

    port_name = args.port
    if port_name is None:
        for candidate in serial.tools.list_ports.comports():
            if "bluetooth" not in (candidate.description or "").lower():
                port_name = candidate.device
                break
    if port_name is None:
        print("No serial port found.", file=sys.stderr)
        return 1
    print(f"Using {port_name}\n")

    with serial.Serial(port_name, args.baud, timeout=1) as port:
        time.sleep(2.0)
        port.reset_input_buffer()

        def send(command: str) -> None:
            port.write((command + "\n").encode())
            time.sleep(0.3)

        send(f"ch {args.channel}")

        print(f"Closing relay {args.relay} - socket goes live...")
        send(f"on {args.relay}")
        time.sleep(1.0)
        send("log TEST")
        closed = read_amplitudes(port, args.samples, 20)
        send("stop")

        print(f"Opening relay {args.relay} - socket should go dead...")
        send(f"off {args.relay}")
        time.sleep(1.0)
        send("log TEST")
        opened = read_amplitudes(port, args.samples, 20)
        send("stop")
        send(f"off {args.relay}")   # leave it open whatever the outcome

    if not closed or not opened:
        print("Not enough data - is the sketch running and a load plugged in?", file=sys.stderr)
        return 1

    closed_mean = float(np.mean(closed))
    opened_mean = float(np.mean(opened))
    print(f"\n  relay CLOSED : {closed_mean:6.1f} ADC RMS   {[round(v, 1) for v in closed]}")
    print(f"  relay OPEN   : {opened_mean:6.1f} ADC RMS   {[round(v, 1) for v in opened]}")

    if closed_mean < 5.0:
        print("\n  INCONCLUSIVE - nothing was drawing even with the relay closed.")
        print("  Plug in a bulb and switch it on, then run this again.")
        return 1

    if opened_mean < 3.0:
        print(f"\n  PASS - current fell from {closed_mean:.1f} to {opened_mean:.1f}, "
              "down to the noise floor.")
        print("  The relay opens properly. A socket staying live after a capture was "
              "the script not sending 'off', not a hardware fault.")
        return 0

    ratio = opened_mean / closed_mean
    print(f"\n  FAIL - current only fell to {opened_mean:.1f} ({ratio:.0%} of the closed "
          "reading). The contacts are not opening.")
    print("  Likely causes, cheapest first:")
    print("    - relay board powered from the ESP32's 3.3V rail instead of 5V, so the")
    print("      coil never fully releases. Feed the board 5V (VIN/USB), grounds common.")
    print("    - JD-VCC jumper missing or set wrong on an opto-isolated board.")
    print("    - welded contacts from switching an inrush load; the channel is damaged.")
    print("  Treat that socket as permanently live until this is resolved.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
