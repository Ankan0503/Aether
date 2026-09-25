# Aether pin map

Three ESP32 node types. Wire to this and the firmware in this repo matches
without edits.

## ESP32 rules these maps obey

Getting these wrong produces faults that look like sensor problems, so they are
worth stating once:

- **Analog inputs must be on ADC1** — GPIO 32, 33, 34, 35, 36, 39. ADC2 (GPIO 0,
  2, 4, 12–15, 25–27) stops working the moment Wi-Fi is enabled, and every node
  here uses Wi-Fi or ESP-NOW.
- **GPIO 34, 35, 36, 39 are input-only.** No output, no internal pull-up. Ideal
  for sensors, useless for relays.
- **Strapping pins decide boot mode**: GPIO 0 (must be high at boot), 2 (must be
  low), 12 (must be low), 15. Nothing that can be pulled the wrong way at power-up.
- **GPIO 6–11 are wired to the flash chip.** Unusable.
- **GPIO 1 and 3 are UART0** — the programming port. Leave them alone.
- **Relay boards here are active LOW.** Drive the pin HIGH *before* `pinMode()`
  makes it an output, or the relay clicks on during boot.

---

## 1. Gateway — the meter and the bridge

Sits at the incoming mains, before the rooms. The only node where voltage and
current are measured together, so the only place true power and power factor
can be computed.

| Function | GPIO | Type | Notes |
|---|---|---|---|
| ACS712 current | **34** | ADC1, input-only | Mains current, in series with live |
| ZMPT101B voltage | **35** | ADC1, input-only | **New.** Across live and neutral |
| Main relay | **23** | Digital out | Active LOW, whole-supply cutoff |
| Buzzer | **25** | Digital out | ADC2 pin, but fine as a digital output |
| Status LED | **2** | Digital out | Onboard blue LED |
| Reset button | **0** | Input, pull-up | Onboard BOOT button |

Current and relay pins are unchanged from the existing Aether gateway, so only
the ZMPT is new.

### Wiring the ZMPT101B

Two sides, and the mains side is dangerous:

- **Mains side** — the two screw terminals go across **live and neutral**. This
  is a direct mains connection through the module's onboard transformer. Enclose
  it; do not probe it live.
- **Logic side** — VCC to **5V**, GND to GND, OUT to **GPIO 35**.

The module has a **trim pot** on the output amplifier. Before trusting any
reading: with mains connected, adjust it until the output sits near **half of
3.3 V (~1.65 V) at rest** and the peaks stay inside 0–3.3 V. Too high and the
waveform clips flat at the top, which silently corrupts both RMS voltage and
power factor while still producing plausible-looking numbers.

Powering it at 5 V while feeding a 3.3 V ADC is the usual trap here — the swing
must be trimmed down, not assumed safe.

### The one thing that must be true

The ACS712 and the ZMPT must be on the **same circuit, same phase**. Power
factor is the phase angle between them; measure them on different branches and
the number is meaningless.

---

## 2. Automation subnode — sockets and occupancy

**This is the node already built.** Three sockets, though the relay board has
four channels.

| Function | GPIO | Type | Notes |
|---|---|---|---|
| Socket 1 relay | **18** | Digital out | → relay board IN1 |
| Socket 2 relay | **22** | Digital out | → relay board IN2 |
| Socket 3 relay | **21** | Digital out | → relay board **IN4** (see below) |
| Socket 1 current | **32** | ADC1 | ACS712 #1 |
| Socket 2 current | **35** | ADC1, input-only | ACS712 #2 |
| Socket 3 current | **34** | ADC1, input-only | ACS712 #3 |
| PIR occupancy | **19** | Digital in | **New.** Freed when socket 3 moved to IN4 |
| Status LED | **2** | Digital out | Onboard; solid when occupied, blinks when empty |

**Socket 3 runs through the relay board's channel 4.** Channel 3 kept sticking
closed when switching a 100 W USB-C charger — a capacitor-input supply draws
tens of amps of inrush for the first few milliseconds, against a steady draw
under half an amp. Only two wires moved: the socket's NO lead, and the ESP32's
control lead from IN3 to IN4. GPIO 21 still means "socket 3", so no firmware
change was needed — and GPIO 19 became free, which is where the PIR now goes.

### Wiring the PIR (HC-SR501)

VCC to **5V**, GND to GND, OUT to **GPIO 19**. Three wires, one `digitalRead()`,
no library. Its OUT idles at 3.3 V logic even on 5 V power, so it is ESP32-safe.

Set the two trim pots and the jumper:

- **Time delay** — turn it fully **down**. The "no motion for N minutes" timing
  belongs in software, where it can be changed without a screwdriver.
- **Sensitivity** — start mid-range, adjust to cover the room.
- **Trigger jumper** — set to **repeatable (H)**, so continuous motion holds the
  output high instead of pulsing.

PIR reports *motion*, not presence — someone sitting still reads as absent
within a minute or two. That is why the cutoff rule requires low current **and**
no motion: the current reading confirms the load is only idling, so a device
actually in use is never cut regardless of what the PIR thinks.

---

## 3. Kitchen safety subnode — gas and fire

Not built yet.

| Function | GPIO | Type | Notes |
|---|---|---|---|
| MQ-2 gas (analog) | **35** | ADC1, input-only | Analog out of the MQ-2 |
| Flame sensor | **32** | Digital in | Digital out of the IR flame module |
| Buzzer | **25** | Digital out | Local alarm |
| Status LED | **2** | Digital out | Onboard |
| Reset button | **0** | Input, pull-up | Onboard BOOT |

No PIR on this node — occupancy is handled by the automation subnode, in the
room where the sockets it controls actually are.

This node's critical path does not involve the internet: on gas or flame it
broadcasts a trip directly to the relay subnode over ESP-NOW, so cutoff still
works with Wi-Fi down.

---

## Pin conflicts to watch

GPIO 34 and 35 appear on more than one node, which is fine — they are different
boards. Within any single node, no pin is used twice.

If a fourth socket is ever added to the automation subnode, GPIO 19 is no longer
free, and the PIR would move to GPIO 23 or 5.
