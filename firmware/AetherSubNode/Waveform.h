#ifndef AETHER_WAVEFORM_H
#define AETHER_WAVEFORM_H

// ============================================================================
// AC current waveform capture and load-type signature extraction (ESP32)
// ============================================================================
// Purpose: identify WHAT is plugged into a socket by the SHAPE of its current
// waveform, not by how many watts it draws.
//
// Why shape instead of magnitude:
//   A filament bulb is a resistive load, so its current is a clean sine.
//   A laptop/phone charger is a switch-mode supply (SMPS) with no active PFC,
//   so it pulls current in two narrow spikes near the voltage peaks and draws
//   nothing in between.
//   Those two shapes are unmistakable even when the amplitude calibration is
//   wrong, because every feature below is normalised by the waveform's own RMS.
//   That makes classification immune to ACS712 zero-offset drift, to a wrong
//   SENSITIVITY constant, and to the fixed-230V power assumption - the three
//   things that make a raw wattage reading on a 30A ACS712 unusable.
//
// Noise handling: the ACS712-30A resolves ~12mA per ADC step and its own noise
// is several steps wide, so a single cycle of a 0.2A bulb is mostly noise.
// We therefore capture WF_CYCLES consecutive mains cycles and coherently
// average them into one cycle. Mains-synchronous signal adds linearly while
// noise adds as sqrt(N), improving SNR by sqrt(WF_CYCLES) - a factor of 4 at
// 16 cycles. That is what makes the shape legible on this hardware.
// ============================================================================

#include <Arduino.h>
#include <math.h>

#define WF_MAINS_HZ        50      // set to 60 outside India/EU
#define WF_BINS            64      // samples per mains cycle (also the DFT size)
#define WF_CYCLES          16      // cycles coherently averaged per capture
#define WF_RAW_N           (WF_BINS * WF_CYCLES)
#define WF_SAMPLE_RATE_HZ  (WF_BINS * WF_MAINS_HZ)   // 3200 Hz -> 312 us/sample

// Captures are only meaningful above the sensor's noise floor. Measure this
// once with the relay ON and nothing plugged in (see wfMeasureNoiseFloor) and
// paste the value here. Expressed in raw ADC RMS steps, not amps, so it stays
// valid regardless of how the amp calibration is set.
// Measured on the real rig (ESP32 + 30A ACS712, channel 1, empty live socket):
// 8 captures read 1.3-1.9 ADC RMS steps, so 3.0 is the worst case plus ~50%.
// The default 6.0 was a guess and would have thrown away small real loads.
#define WF_NOISE_FLOOR_ADC 3.0f

// Classification labels
#define WF_CLASS_NONE      "NONE"        // below noise floor - nothing drawing
#define WF_CLASS_RESISTIVE "RESISTIVE"   // filament/halogen bulb, heater, iron
#define WF_CLASS_SMPS      "SMPS"        // laptop/phone charger, LED driver, TV
#define WF_CLASS_MIXED     "MIXED"       // partially corrected, or several loads

struct WfSignature {
    float cycle[WF_BINS];  // coherently averaged single cycle, DC removed, ADC steps
    float rmsAdc;          // RMS of that cycle in ADC steps (amplitude, uncalibrated)
    float crest;           // peak / RMS    -> 1.41 pure sine, 2.5-3.5 non-PFC SMPS
    float formFactor;      // RMS / mean|i| -> 1.11 pure sine, much higher for SMPS
    float conduction;      // fraction of the cycle spent above 25% of peak
    float thd;             // total harmonic distortion vs the 50Hz fundamental
    float h3, h5, h7;      // 3rd/5th/7th harmonic amplitude relative to fundamental
    const char* label;     // on-device verdict, see wfClassify()
    bool valid;            // false if the capture was below the noise floor
};

static uint16_t wfRaw[WF_RAW_N];

// ---------------------------------------------------------------------------
// Step 1: sample one pin at a fixed rate. Pacing is done with micros() rather
// than delayMicroseconds() so that the time analogRead() itself takes does not
// stretch the sample interval - an uneven sample rate smears the harmonics and
// is the usual reason a home-made oscilloscope trace looks like noise.
// ---------------------------------------------------------------------------
inline void wfSampleRaw(int sensorPin) {
    const uint32_t dt = 1000000UL / WF_SAMPLE_RATE_HZ;  // 312 us
    uint32_t next = micros();
    for (int i = 0; i < WF_RAW_N; i++) {
        while ((int32_t)(micros() - next) < 0) { /* spin until the slot opens */ }
        wfRaw[i] = analogRead(sensorPin);
        next += dt;
    }
}

// ---------------------------------------------------------------------------
// Step 2: fold WF_CYCLES cycles onto each other, anchored to a rising zero
// crossing so every cycle is added in the same phase.
// ---------------------------------------------------------------------------
inline void wfFold(WfSignature& sig) {
    double sum = 0;
    for (int i = 0; i < WF_RAW_N; i++) sum += wfRaw[i];
    const float dc = (float)(sum / WF_RAW_N);   // measured bias, never assumed

    // First upward crossing of the bias line, within the first two cycles.
    int anchor = 0;
    for (int i = 1; i < 2 * WF_BINS; i++) {
        if (wfRaw[i - 1] < dc && wfRaw[i] >= dc) { anchor = i; break; }
    }

    float acc[WF_BINS] = {0};
    int folded = 0;
    for (int c = 0; anchor + (c + 1) * WF_BINS <= WF_RAW_N; c++) {
        for (int b = 0; b < WF_BINS; b++) {
            acc[b] += (float)wfRaw[anchor + c * WF_BINS + b] - dc;
        }
        folded++;
    }
    if (folded == 0) folded = 1;
    for (int b = 0; b < WF_BINS; b++) sig.cycle[b] = acc[b] / folded;
}

// ---------------------------------------------------------------------------
// Step 3: shape features. The averaged cycle is exactly one mains period long,
// so DFT bin k lands precisely on the k-th harmonic - no windowing needed.
// ---------------------------------------------------------------------------
inline float wfHarmonic(const float* cyc, int k) {
    float re = 0, im = 0;
    for (int n = 0; n < WF_BINS; n++) {
        const float a = 2.0f * PI * k * n / WF_BINS;
        re += cyc[n] * cosf(a);
        im -= cyc[n] * sinf(a);
    }
    return sqrtf(re * re + im * im) * 2.0f / WF_BINS;
}

inline void wfFeatures(WfSignature& sig) {
    float sq = 0, absSum = 0, peak = 0;
    for (int n = 0; n < WF_BINS; n++) {
        const float v = sig.cycle[n];
        sq += v * v;
        absSum += fabsf(v);
        if (fabsf(v) > peak) peak = fabsf(v);
    }
    sig.rmsAdc = sqrtf(sq / WF_BINS);
    const float meanAbs = absSum / WF_BINS;

    sig.crest      = sig.rmsAdc > 0 ? peak / sig.rmsAdc : 0;
    sig.formFactor = meanAbs > 0 ? sig.rmsAdc / meanAbs : 0;

    int above = 0;
    for (int n = 0; n < WF_BINS; n++) if (fabsf(sig.cycle[n]) > 0.25f * peak) above++;
    sig.conduction = (float)above / WF_BINS;

    const float f1 = wfHarmonic(sig.cycle, 1);
    float harmSq = 0;
    for (int k = 2; k <= WF_BINS / 4; k++) {
        const float m = wfHarmonic(sig.cycle, k);
        harmSq += m * m;
    }
    sig.thd = f1 > 0 ? sqrtf(harmSq) / f1 : 0;
    sig.h3  = f1 > 0 ? wfHarmonic(sig.cycle, 3) / f1 : 0;
    sig.h5  = f1 > 0 ? wfHarmonic(sig.cycle, 5) / f1 : 0;
    sig.h7  = f1 > 0 ? wfHarmonic(sig.cycle, 7) / f1 : 0;
}

// ---------------------------------------------------------------------------
// Step 4: on-device verdict. Deliberately a small explainable rule rather than
// a model - it keeps working if the backend is offline, and the backend
// classifier (backend/load_signature.py) refines it from the same features.
// Thresholds sit between the theoretical values for a pure sine (crest 1.414,
// form 1.111, THD 0) and a measured non-PFC SMPS.
// ---------------------------------------------------------------------------
inline const char* wfClassify(const WfSignature& sig) {
    if (!sig.valid) return WF_CLASS_NONE;
    if (sig.crest < 1.75f && sig.thd < 0.30f && sig.conduction > 0.55f) return WF_CLASS_RESISTIVE;
    if (sig.crest > 2.20f || sig.thd > 0.60f || sig.conduction < 0.40f)  return WF_CLASS_SMPS;
    return WF_CLASS_MIXED;
}

inline WfSignature wfCapture(int sensorPin) {
    WfSignature sig = {};
    wfSampleRaw(sensorPin);
    wfFold(sig);
    wfFeatures(sig);
    sig.valid = sig.rmsAdc >= WF_NOISE_FLOOR_ADC;
    sig.label = wfClassify(sig);
    return sig;
}

// ---------------------------------------------------------------------------
// Run once from setup() with the relay ON and nothing plugged in, then copy the
// printed value into WF_NOISE_FLOOR_ADC above.
// ---------------------------------------------------------------------------
inline void wfMeasureNoiseFloor(int sensorPin) {
    float worst = 0;
    for (int i = 0; i < 20; i++) {
        WfSignature s = {};
        wfSampleRaw(sensorPin);
        wfFold(s);
        wfFeatures(s);
        if (s.rmsAdc > worst) worst = s.rmsAdc;
    }
    Serial.printf("[WF] pin %d idle noise floor: %.2f ADC RMS steps -> set WF_NOISE_FLOOR_ADC to %.1f\n",
                  sensorPin, worst, worst * 1.5f);
}

// ---------------------------------------------------------------------------
// Dump one capture as CSV on the serial monitor. Use this to collect labelled
// training data with backend/collect_samples.py before any wireless work.
// ---------------------------------------------------------------------------
inline void wfPrintCsv(const WfSignature& sig, const char* labelOverride) {
    Serial.print("WFCSV,");
    Serial.print(labelOverride ? labelOverride : sig.label);
    Serial.printf(",%.2f,%.3f,%.3f,%.3f,%.3f", sig.rmsAdc, sig.crest, sig.formFactor,
                  sig.conduction, sig.thd);
    for (int n = 0; n < WF_BINS; n++) Serial.printf(",%.2f", sig.cycle[n]);
    Serial.println();
}

// ---------------------------------------------------------------------------
// Step 5: transport. ESP-NOW caps a message at 250 bytes, so the waveform is
// normalised to its own peak, quantised to 64 signed bytes and base64'd (88
// chars). Keys are short to stay inside the cap; the whole frame lands near
// 230 bytes. Send it as its own message, not merged into TELEMETRY.
// ---------------------------------------------------------------------------
inline int wfBase64(const int8_t* in, int len, char* out, int outSize) {
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int o = 0;
    for (int i = 0; i < len; i += 3) {
        const uint32_t b0 = (uint8_t)in[i];
        const uint32_t b1 = (i + 1 < len) ? (uint8_t)in[i + 1] : 0;
        const uint32_t b2 = (i + 2 < len) ? (uint8_t)in[i + 2] : 0;
        const uint32_t trip = (b0 << 16) | (b1 << 8) | b2;
        if (o + 4 >= outSize) break;
        out[o++] = T[(trip >> 18) & 0x3F];
        out[o++] = T[(trip >> 12) & 0x3F];
        out[o++] = (i + 1 < len) ? T[(trip >> 6) & 0x3F] : '=';
        out[o++] = (i + 2 < len) ? T[trip & 0x3F] : '=';
    }
    out[o] = '\0';
    return o;
}

inline int wfBuildPayload(const WfSignature& sig, int channel, const String& mac,
                          char* out, size_t outSize) {
    float peak = 0;
    for (int n = 0; n < WF_BINS; n++) if (fabsf(sig.cycle[n]) > peak) peak = fabsf(sig.cycle[n]);
    if (peak <= 0) peak = 1;

    int8_t q[WF_BINS];
    for (int n = 0; n < WF_BINS; n++) {
        const float s = sig.cycle[n] / peak * 127.0f;
        q[n] = (int8_t)constrain((int)lroundf(s), -127, 127);
    }
    char b64[96];
    wfBase64(q, WF_BINS, b64, sizeof(b64));

    return snprintf(out, outSize,
        "{\"action\":\"WF\",\"mac\":\"%s\",\"ch\":%d,\"rms\":%.1f,\"cr\":%.2f,"
        "\"ff\":%.2f,\"cd\":%.2f,\"thd\":%.2f,\"h3\":%.2f,\"h5\":%.2f,"
        "\"cls\":\"%s\",\"w\":\"%s\"}",
        mac.c_str(), channel, sig.rmsAdc, sig.crest, sig.formFactor,
        sig.conduction, sig.thd, sig.h3, sig.h5, sig.label, b64);
}

#endif  // AETHER_WAVEFORM_H
