# Measured waveforms

Current waveforms captured on the real rig — ESP32, 30A ACS712, mains — on
2026-09-25. Not simulated, except where noted.

In every plot the blue line is the measured current and the orange dashed line
is a pure sine at the **same RMS**. Equal area under the curve, so any visible
difference is shape alone. That is what the classifier decides on, so the plot
shows the reasoning rather than only the result.

| file | what it shows |
|---|---|
| `01-filament-bulb-100w.png` | Resistive load. Current tracks the mains voltage, so it sits on the sine. |
| `02-laptop-charger-barrel-no-pfc.png` | Switching supply with no power factor correction. Flat near zero most of the cycle, then two sharp spikes at the voltage peaks. |
| `03-usbc-charger-100w-partial-pfc.png` | Partially corrected supply. Follows the sine for part of the cycle, then still spikes — it lands between the other two. |
| `04-all-three-compared.png` | All three side by side, ordered by crest factor. **The pitch figure.** |
| `05-noise-floor-empty-socket.png` | Mains live, nothing drawing. Formless noise at 1.5 ADC RMS — what "nothing" looks like. |
| `06-simulated-reference.png` | Simulated bulb and charger at this sensor's noise level, for comparison against a real capture. The only synthetic plot here. |

## The numbers

| load | crest | form | conduction | THD | amplitude |
|---|---|---|---|---|---|
| pure sine (theory) | 1.414 | 1.111 | 71% | 0.00 | — |
| filament bulb, 100 W | 1.38 | 1.11 | 84% | 0.03 | 38.3 |
| USB-C charger, 100 W | 2.34 | 1.36 | 44% | 0.52 | 19.7 |
| barrel charger, no PFC | 2.78 | 1.86 | 23% | 1.08 | 25.5 |
| empty socket (noise) | — | — | — | — | 1.5 |

**Crest factor** — peak divided by RMS — does most of the work. A switching
supply crams its whole draw into a short pulse, so its peak is high while its
RMS stays modest.

Note that the barrel charger draws *less* current than the bulb (25.5 against
38.3) yet peaks higher. Wattage alone could not separate these; shape does it
trivially.

## Why these are legible at all

A 30A ACS712 resolves about 2.8 W per ADC step and its own noise is several
steps wide, so a single mains cycle of a small load is mostly junk. The firmware
coherently averages 16 cycles per capture, anchored to a rising zero crossing:
mains-synchronous signal adds linearly while noise adds as the square root, so
16 cycles buys a 4x improvement. The capture tool then stacks several captures
on top of that — the barrel charger plot is 1,888 mains cycles.

## Honest limits

The USB-C charger is the marginal case: 71% confidence against 90% for the
barrel one, and its signature genuinely moves as USB-PD renegotiates. A fully
corrected brick could read as MIXED. The defensible claim is **load type —
resistive versus switching supply**, never "it detects laptops".

Reproduce any of these with `backend/capture_once.py`, or regenerate the
comparison with `backend/compare_captures.py`.
