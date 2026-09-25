#ifndef AETHER_METERING_H
#define AETHER_METERING_H

// ============================================================================
// Aether gateway - true power metering from a ZMPT101B and an ACS712
// ============================================================================
// The gateway is the only node where voltage and current are measured on the
// same circuit at the same moment, so it is the only place that can compute
// ACTIVE power rather than guess at it.
//
// Why that distinction matters for this project:
//   Vrms x Irms is APPARENT power (VA). It is what you get when you assume a
//   voltage and multiply - which is what the subnodes have to do.
//   mean(v[n] * i[n]) is ACTIVE power (W). It is what the electricity meter
//   bills, and the only honest basis for a rupee figure.
//   Their ratio is the power factor. A laptop charger drawing 60 VA may only
//   consume 35 W; quoting the 60 would overstate savings by 70%.
//
// Every number here is therefore computed from instantaneous sample pairs, not
// from RMS shortcuts.
// ============================================================================

#include <Arduino.h>
#include <math.h>

#define MT_MAINS_HZ        50      // set to 60 outside India/EU
#define MT_SAMPLE_PAIRS    1600    // voltage+current pairs per second, ~32/cycle
#define MT_CYCLES          20      // cycles per measurement window (0.4s at 50Hz)
#define MT_PAIRS_PER_CYCLE (MT_SAMPLE_PAIRS / MT_MAINS_HZ)
#define MT_WINDOW_PAIRS    (MT_PAIRS_PER_CYCLE * MT_CYCLES)

// --- Calibration -----------------------------------------------------------
// Both MUST be set against a known reference before any reading is trustworthy.
// See mtCalibrationHelp() for the procedure.
//
// MT_VOLT_CAL: mains volts per ADC step of the zero-centred ZMPT signal.
// MT_CURR_CAL: amps per ADC step of the zero-centred ACS712 signal.
//   For a 30A ACS712 at 66 mV/A on a 3.3V 12-bit ADC the theoretical value is
//   (3300/4095) / 66 = 0.0122 A per step. Theory is a starting point only -
//   module tolerances are wide, so trim it against a real meter.
#define MT_VOLT_CAL 0.4500f
#define MT_CURR_CAL 0.0122f

// Corrects the small phase error introduced by reading voltage and current a
// few tens of microseconds apart rather than simultaneously. The ESP32 has one
// multiplexed ADC, so the pair is never truly instantaneous.
//
// READ THE SCALE CAREFULLY - it is not a fraction:
//   1.0  = no correction, use the voltage sample as taken
//   >1.0 = advance the voltage, extrapolating past the current sample
//   <1.0 = retard it toward the previous sample
// This is EmonLib's PHASECAL convention. Setting it to a small fraction like
// 0.3 does not mean "a small correction" - it means "use almost the whole
// previous sample", a full sample of lag. At 32 samples per cycle that is
// 11.25 degrees, which turns a true power factor of 0.5 into a reported 0.66.
//
// The default advances by roughly 0.08 of a sample interval (about 50 us at
// 1600 pairs/s), which is the measured gap between the two analogRead() calls.
// Tune it against a filament bulb: a purely resistive load must read a power
// factor above 0.95, and metering_selftest.py asserts this scale.
#define MT_PHASE_SHIFT 1.08f

// Readings below this are noise, not load. In ADC RMS steps, so it stays valid
// whatever the calibration constants are set to. Measure it with the main relay
// closed and no load, exactly as with the subnode's waveform capture.
#define MT_NOISE_FLOOR_ADC 3.0f

struct MtReading {
    float vRms;          // volts
    float iRms;          // amps
    float activePower;   // watts - mean(v*i), what the meter bills
    float apparentPower; // VA - vRms * iRms
    float powerFactor;   // activePower / apparentPower, 0..1
    float frequency;     // Hz, from zero crossings
    float vRmsAdc;       // raw amplitudes, for noise-floor checks
    float iRmsAdc;
    bool valid;          // false when current is below the noise floor
};

// Running energy total. Survives as long as the sketch runs; the backend is
// responsible for persisting it.
struct MtEnergy {
    double wattHours = 0.0;
    uint32_t lastUpdateMs = 0;
};

// ---------------------------------------------------------------------------
// One measurement window. Samples voltage and current alternately, removes the
// measured DC bias from each, and accumulates the three sums that everything
// else derives from.
//
// The bias is measured per window rather than assumed to be Vcc/2. Both modules
// centre their output with a trim pot and a divider, neither lands exactly at
// half rail, and both drift with temperature and supply voltage. Assuming the
// midpoint is the single most common cause of a meter that reads a steady
// phantom load with nothing connected.
// ---------------------------------------------------------------------------
inline MtReading mtMeasure(int voltagePin, int currentPin) {
    static float vSamples[MT_WINDOW_PAIRS];
    static float iSamples[MT_WINDOW_PAIRS];

    const uint32_t dt = 1000000UL / MT_SAMPLE_PAIRS;   // 625 us per pair
    uint32_t next = micros();
    double vSum = 0, iSum = 0;

    for (int n = 0; n < MT_WINDOW_PAIRS; n++) {
        while ((int32_t)(micros() - next) < 0) { /* hold the sample interval */ }
        // Voltage first, then current: the phase correction below assumes this
        // order, so do not swap them.
        const float v = (float)analogRead(voltagePin);
        const float i = (float)analogRead(currentPin);
        vSamples[n] = v;
        iSamples[n] = i;
        vSum += v;
        iSum += i;
        next += dt;
    }

    const float vBias = (float)(vSum / MT_WINDOW_PAIRS);
    const float iBias = (float)(iSum / MT_WINDOW_PAIRS);

    double vSquared = 0, iSquared = 0, instantPower = 0;
    float previousV = vSamples[0] - vBias;

    for (int n = 0; n < MT_WINDOW_PAIRS; n++) {
        const float v = vSamples[n] - vBias;
        const float i = iSamples[n] - iBias;

        // Interpolate the voltage forward toward the moment the current was
        // sampled, closing the multiplexing gap.
        const float vAligned = previousV + MT_PHASE_SHIFT * (v - previousV);
        previousV = v;

        vSquared += (double)v * v;
        iSquared += (double)i * i;
        instantPower += (double)vAligned * i;
    }

    MtReading reading = {};
    reading.vRmsAdc = sqrtf((float)(vSquared / MT_WINDOW_PAIRS));
    reading.iRmsAdc = sqrtf((float)(iSquared / MT_WINDOW_PAIRS));

    reading.vRms = reading.vRmsAdc * MT_VOLT_CAL;
    reading.iRms = reading.iRmsAdc * MT_CURR_CAL;
    reading.activePower = (float)(instantPower / MT_WINDOW_PAIRS) * MT_VOLT_CAL * MT_CURR_CAL;
    reading.apparentPower = reading.vRms * reading.iRms;

    // Power factor is undefined with no load, and the ratio of two noise
    // figures is meaningless - report zero rather than a plausible number.
    reading.powerFactor = (reading.apparentPower > 0.5f)
        ? reading.activePower / reading.apparentPower
        : 0.0f;
    if (reading.powerFactor > 1.0f) reading.powerFactor = 1.0f;   // rounding guard
    if (reading.powerFactor < -1.0f) reading.powerFactor = -1.0f;

    // Frequency from upward zero crossings of the voltage waveform. A real
    // check, not decoration: a reading far from 50 Hz means the ZMPT is not
    // seeing mains at all, which otherwise looks like a plausible low voltage.
    int crossings = 0;
    int firstCross = -1, lastCross = -1;
    for (int n = 1; n < MT_WINDOW_PAIRS; n++) {
        const float previous = vSamples[n - 1] - vBias;
        const float current = vSamples[n] - vBias;
        if (previous < 0 && current >= 0) {
            if (firstCross < 0) firstCross = n;
            lastCross = n;
            crossings++;
        }
    }
    reading.frequency = (crossings > 1 && lastCross > firstCross)
        ? (float)(crossings - 1) * MT_SAMPLE_PAIRS / (lastCross - firstCross)
        : 0.0f;

    reading.valid = reading.iRmsAdc >= MT_NOISE_FLOOR_ADC;
    if (!reading.valid) {
        // Current is in the noise. Voltage is still real and worth reporting,
        // but power and power factor are not.
        reading.iRms = 0;
        reading.activePower = 0;
        reading.apparentPower = 0;
        reading.powerFactor = 0;
    }
    return reading;
}

// ---------------------------------------------------------------------------
// Accumulate energy. Integrates whatever power was measured across the real
// elapsed time, so an irregular call interval does not skew the total.
// ---------------------------------------------------------------------------
inline void mtAccumulate(MtEnergy& energy, const MtReading& reading) {
    const uint32_t now = millis();
    if (energy.lastUpdateMs != 0) {
        const uint32_t elapsed = now - energy.lastUpdateMs;   // wrap-safe on uint32
        energy.wattHours += (double)reading.activePower * elapsed / 3600000.0;
    }
    energy.lastUpdateMs = now;
}

inline float mtCostRupees(const MtEnergy& energy, float rupeesPerKwh) {
    return (float)(energy.wattHours / 1000.0) * rupeesPerKwh;
}

// ---------------------------------------------------------------------------
// A load's character, from power factor alone. The gateway sees the whole house
// summed together, so this describes the aggregate rather than any one device -
// per-socket identification is the subnode's job, from waveform shape.
// ---------------------------------------------------------------------------
inline const char* mtLoadCharacter(const MtReading& reading) {
    if (!reading.valid) return "IDLE";
    if (reading.powerFactor > 0.95f) return "RESISTIVE";
    if (reading.powerFactor > 0.80f) return "MOSTLY_RESISTIVE";
    if (reading.powerFactor > 0.60f) return "MIXED";
    return "REACTIVE_OR_SWITCHING";
}

inline void mtCalibrationHelp() {
    Serial.println();
    Serial.println("Calibration - do this once, in order:");
    Serial.println();
    Serial.println("1. NOISE FLOOR. Main relay closed, nothing drawing. Run 'n'.");
    Serial.println("   Put the printed value in MT_NOISE_FLOOR_ADC and reflash.");
    Serial.println();
    Serial.println("2. VOLTAGE. Trim the ZMPT pot until the trace is not clipped,");
    Serial.println("   then compare the reported Vrms against a multimeter on the");
    Serial.println("   same outlet. Scale MT_VOLT_CAL by (meter / reported).");
    Serial.println();
    Serial.println("3. CURRENT. Plug in a load of known wattage - an incandescent");
    Serial.println("   bulb is ideal, being purely resistive, so its VA equals its");
    Serial.println("   watts. Scale MT_CURR_CAL by (rated W / reported W).");
    Serial.println();
    Serial.println("Check: a filament bulb must read power factor above 0.95. If it");
    Serial.println("does not, voltage and current are out of phase - either they are");
    Serial.println("on different circuits, or MT_PHASE_SHIFT needs adjusting.");
    Serial.println();
}

#endif  // AETHER_METERING_H
