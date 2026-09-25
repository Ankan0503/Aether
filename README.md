# Aether

A smart energy and home-safety system built on an ESP32 mesh: a gateway that
meters the incoming mains, and room subnodes that switch sockets, watch for gas
and fire, and work out what is plugged in and whether anyone is there to use it.

Built for HackNex Season 2.

## What is in this repo right now

This repo holds the work that is **built and verified on real hardware**, not
the full system. Today that is load-signature detection plus the dashboard:

- `firmware/` — ESP32 waveform capture and on-device load classification
- `backend/` — feature extraction, classifier, and the capture/plot tooling
- `frontend/` — the Aether dashboard (React 19 + TypeScript + Vite, PWA)

The Django backend, MQTT ingestion and ESP-NOW mesh live in the
Smart-Energy-Saver-and-Home-Safety repo and are being brought over in stages.

---

# Load Signature Detection

Identify **what kind of device** is plugged into a socket by the shape of its AC
current waveform — a filament bulb draws a clean sine, a laptop charger draws
two narrow spikes per cycle.

Verified on real hardware: given three appliances swapped between sockets
without being told which was which, it named each one correctly. See the blind
test below.

```
firmware/
  Waveform.h                  capture + coherent averaging + feature extraction
  WaveformBench/              standalone sketch for testing and data collection
backend/
  load_signature.py           decode, features, rule + trained classifier
  collect_samples.py          serial -> labelled CSV
  train_classifier.py         CSV -> decision tree
  selftest.py                 validates the maths with no hardware attached
  live_plot.py                live graph from the serial port
  preview_graph.py            renders example traces with no hardware
```

## The idea in one line

Every feature is computed **after normalising the waveform by its own RMS**, so
the classifier depends only on shape — not on amplitude. That matters because
amplitude is exactly what is broken on a 30A ACS712, and shape is not.

## Why this works on hardware that can't measure watts

A 30A ACS712 gives 66 mV/A. On the ESP32's 12-bit ADC that is ~12 mA (~2.8 W)
per step, and the sensor's own noise is several steps wide. A 40 W bulb is only
~14 steps of amplitude against ~4 steps of noise — one raw cycle is mostly junk.

So the firmware captures **16 consecutive mains cycles and coherently averages
them**, anchored to a rising zero crossing. Mains-synchronous signal adds
linearly, noise adds as √N, so SNR improves 4×. `selftest.py` asserts this: the
single-cycle case is expected to *fail* classification, and the 16-cycle case to
pass. That contrast is the justification for the whole design.

## Features and what separates the two loads

Measured on this rig (ESP32 + 30A ACS712), 2026-09-25 — not theoretical:

| load | crest | form | conduction | THD | amplitude |
|---|---|---|---|---|---|
| pure sine (theory) | 1.414 | 1.111 | 71% | 0.00 | — |
| **100 W filament bulb** | **1.38** | **1.11** | **84%** | **0.03** | 38.3 |
| **barrel laptop charger** | **2.78** | **1.86** | **23%** | **1.08** | 25.5 |
| empty socket (noise) | — | — | — | — | 1.5 |
| active-PFC USB-C brick | 1.5–1.8 | 1.15–1.3 | 55–70% | 0.10–0.30 | *untested* |

The bulb landed within 3% of the theoretical crest factor and the charger came
in at twice that, with conduction collapsing from 84% to 23%. Signal-to-noise
was 26:1 for the bulb and 17:1 for the charger, so both are comfortably above
the floor rather than scraped off it.

**Blind test, 2026-09-25:** appliances were swapped between sockets without
telling the classifier, and `identify.py` named both correctly — the barrel
charger at shape distance 0.068 and the bulb at 0.027, against 0.39 for the
nearest wrong answer. It also correctly reported the third socket as drawing
nothing rather than guessing. An idle charger sits below this sensor's noise
floor, so "empty" and "plugged in but idling" are genuinely indistinguishable
here; that gap is what PIR occupancy covers in the full system.

**Crest factor** (peak ÷ RMS) does most of the work: an SMPS crams its whole
draw into a short pulse, so its peak is high while its RMS stays modest.

Note the last row. A laptop charger with active PFC deliberately shapes its
current back into a sine and will classify as RESISTIVE or MIXED. That is the
measurement being honest. **Claim "load type — resistive / switching supply",
never "it detects laptops"** — a judge swapping in a PFC brick would otherwise
break your demo live.

## Getting it running

**1. Check the maths (no hardware):**
```bash
cd backend && python selftest.py
```

**2. Flash the bench sketch.** Open `firmware/WaveformBench/WaveformBench.ino`
in the Arduino IDE (`Waveform.h` is already beside it). Serial monitor at
115200, line ending **Newline**. It drives the relays itself — no Wi-Fi, no
mesh, no gateway.

Pin map, matching the Aether subnode so measurements transfer unchanged:

| | GPIO |
|---|---|
| Relays 1–4 (active LOW) | 18, 22, 21, 19 |
| ACS712 1–4 | 32, 35, 34, 33 |

**3. Measure your noise floor.** With **nothing plugged in**, type `n`. Copy the
printed value into `WF_NOISE_FLOOR_ADC` in `Waveform.h` and re-flash. This is
what stops an empty socket reporting phantom load.

**4. Capture one device at a time:**
```
on 1            close relay 1, socket goes live
c               capture and print the trace + features
save BULB       store it to flash (survives a reboot)
off 1           then swap the device and repeat
```
Swap the bulb for a non-PFC laptop charger and type `c` again — the trace should
visibly change from a smooth sine to two spikes per cycle. If it does, the hard
part is done. `match` compares whatever is plugged in now against the stored
profile; `show` prints the stored one.

**5. See the graph.** The sketch draws a rough ASCII trace, but for the real
thing:
```bash
pip install pyserial matplotlib numpy
python live_plot.py COM5 --relay 1
```
A window opens showing one mains cycle of current, updating twice a second,
with a perfect sine drawn behind it at the same RMS. **The gap between the two
lines is the answer**: a bulb sits on the sine, a charger collapses into spikes
and leaves it. Press `s` to save a PNG.

To see what a good capture looks like before the hardware is ready:
```bash
python preview_graph.py
```

**6. Collect training data** (only once you want a trained model rather than the
rule):
```bash
pip install pyserial numpy pandas scikit-learn joblib
python collect_samples.py COM5 --out samples.csv
```
In the serial session: `on 1`, plug in a load, `log BULB`, wait ~2 minutes,
`stop`. Repeat per load. ~240 rows each is plenty — the signature is stable, so
more data buys very little.

**7. Train:**
```bash
python train_classifier.py samples.csv
```
It prints the learned rules in plain text, and prints the hand-written rule's
accuracy next to the model's. **If the gap is small, ship the rule** — it needs
no artefact, cannot rot, and you can read it out loud.

## Wiring notes

- Use **ADC1 pins only** (GPIO32–39). ADC2 stops working the moment Wi-Fi is on.
- Sampling is paced with `micros()`, not `delayMicroseconds()`, so the time
  `analogRead()` itself takes doesn't stretch the interval. An uneven sample
  rate smears the harmonics and is the usual reason a homemade oscilloscope
  trace looks like noise.
- Set `WF_MAINS_HZ` to 60 outside India/EU.

## Demo loads

An **incandescent/halogen bulb** and a **cheap barrel-plug laptop charger** give
the sharpest contrast. Avoid LED bulbs as the hero load: they behave like a mini
SMPS (good talking point) but only draw 5–9 W, which is near the 30A sensor's
noise floor, so the trace will be mush.

## Known limits

- **No voltage reference**, so no phase and no power factor. Motors and
  resistive loads both look sinusoidal, so a fan cannot be told apart from a
  bulb here. That needs a voltage sense channel or a PZEM-004T.
- **Individual device ID is out of scope.** Two switch-mode supplies look alike.
  Type-class is the honest, defensible claim.
- Small standby loads (a few watts) sit below the noise floor and report NONE.
  That is what PIR occupancy is for, not this.

## Merging into Aether later

Nothing here has been added to the Aether repo. When ready:

1. Copy `firmware/Waveform.h` next to `Aether_SubNode.ino` and `#include` it.
2. Add a round-robin capture in the `DEVICE_TYPE_AUTOMATION` loop block,
   `wfBuildPayload()` into a 250-byte buffer, and `esp_now_send` it as its own
   message — **not** merged into TELEMETRY. ESP-NOW caps a frame at 250 bytes
   and the waveform frame already lands near 230.
3. Drop `backend/load_signature.py` into `anomaly/ml/`, swap `DEFAULT_MODEL_DIR`
   for the Django setting, and route `action == "WF"` frames in the MQTT
   ingestion to `classify_payload()`.

Separately, worth checking on the Aether repo when you get to it:
`Aether_SubNode.ino` sets `SENSITIVITY = 185.0` (the 5A value) with a `* 1.5`
fudge factor in `getACCurrent()`, while the hardware is the 30A module (66 mV/A).
That mismatch is a likely contributor to the drifting 13–22 W idle reading. It
does not affect anything in this repo, because shape features ignore scale.
