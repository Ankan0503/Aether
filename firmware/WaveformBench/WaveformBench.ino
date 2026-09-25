// ============================================================================
// WaveformBench - single ESP32, 4-channel relay + 4x ACS712.
//
// Switch a socket on, capture the current waveform through it, work out what
// KIND of device is plugged in from the shape of that waveform, and save one
// device profile to flash so it survives a reboot.
//
// Standalone on purpose: no Wi-Fi, no ESP-NOW, no MQTT, no gateway. Just the
// ESP32, the relay board and the current sensors, so the measurement can be
// proven before any of the mesh is involved.
//
// Workflow - one device at a time:
//   1. type  n            measure the noise floor with NOTHING plugged in
//   2. plug in ONE device (filament bulb, say) and type  on 1
//   3. type  c            capture and look at the trace and the numbers
//   4. type  save BULB    store it as the reference profile in flash
//   5. type  off 1        then swap the device and repeat
//   6. type  match        compare whatever is plugged in now to the saved one
//
// Serial: 115200 baud, line ending "Newline" or "Both NL & CR".
// ============================================================================

#include <Preferences.h>
#include "Waveform.h"

// --- Pin map -------------------------------------------------------------
// Relays are ACTIVE LOW: writing LOW closes the contact and powers the socket.
const int RELAY_PINS[4]   = {18, 22, 21, 19};
// ADC1 pins only. ADC2 (GPIO 0/2/4/12-15/25-27) stops working once Wi-Fi is
// enabled, so even though this sketch has no Wi-Fi, staying on ADC1 means the
// readings transfer unchanged when this moves into the Aether subnode.
const int CURRENT_PINS[4] = {32, 35, 34, 33};

const int RELAY_ON  = LOW;
const int RELAY_OFF = HIGH;

// --- State ---------------------------------------------------------------
Preferences prefs;
int activeChannel = 0;            // 0-3, the channel commands act on
bool relayState[4] = {false, false, false, false};

WfSignature savedProfile;         // the one stored device profile
char savedLabel[24] = "";
bool hasSavedProfile = false;

bool streaming = false;           // continuous capture for logging to a PC
char streamLabel[24] = "UNLABELLED";
unsigned long lastStream = 0;
const unsigned long streamIntervalMs = 500;

// --- Relay control -------------------------------------------------------
void setRelay(int channel, bool on) {
    if (channel < 0 || channel > 3) return;
    digitalWrite(RELAY_PINS[channel], on ? RELAY_ON : RELAY_OFF);
    relayState[channel] = on;
    Serial.printf("Relay %d (GPIO %d) -> %s\n", channel + 1, RELAY_PINS[channel],
                  on ? "ON  (socket live)" : "OFF (socket dead)");
}

// --- Display -------------------------------------------------------------
void printTrace(const WfSignature& sig) {
    float peak = 0;
    for (int n = 0; n < WF_BINS; n++) if (fabsf(sig.cycle[n]) > peak) peak = fabsf(sig.cycle[n]);
    if (peak <= 0) { Serial.println("  (flat - no current)"); return; }

    for (int row = 8; row >= -8; row--) {
        Serial.print("  ");
        for (int n = 0; n < WF_BINS; n++) {
            int level = (int)roundf(sig.cycle[n] / peak * 8.0f);
            Serial.print(level == row ? '*' : (row == 0 ? '-' : ' '));
        }
        Serial.println();
    }
    Serial.println("  |<---------------------- one mains cycle (20ms) ---------------------->|");
}

void explainVerdict(const WfSignature& sig) {
    if (!sig.valid) {
        Serial.println("  Nothing detected. Either the relay is off, nothing is plugged in,");
        Serial.println("  or the load is too small for this sensor to see.");
        return;
    }
    if (strcmp(sig.label, WF_CLASS_RESISTIVE) == 0) {
        Serial.println("  RESISTIVE - current is a clean sine that follows the mains voltage.");
        Serial.println("  Consistent with a filament/halogen bulb, a heater or a soldering iron.");
    } else if (strcmp(sig.label, WF_CLASS_SMPS) == 0) {
        Serial.println("  SWITCHING SUPPLY - current is drawn in narrow spikes near the voltage");
        Serial.println("  peaks and is near zero in between. Consistent with a laptop or phone");
        Serial.println("  charger without power factor correction, an LED driver or a TV.");
    } else {
        Serial.println("  MIXED - between a clean sine and a spiky switching draw. Typical of a");
        Serial.println("  charger WITH active PFC, or of two different loads sharing the socket.");
    }
}

void printSignature(const WfSignature& sig) {
    Serial.println();
    Serial.println("=====================================================================");
    Serial.printf("Channel %d  (relay GPIO %d %s, sensor GPIO %d)\n",
                  activeChannel + 1, RELAY_PINS[activeChannel],
                  relayState[activeChannel] ? "ON" : "OFF", CURRENT_PINS[activeChannel]);
    Serial.println("---------------------------------------------------------------------");
    printTrace(sig);
    Serial.println("---------------------------------------------------------------------");
    Serial.printf("  amplitude    %7.2f ADC RMS steps%s\n", sig.rmsAdc,
                  sig.valid ? "" : "   <-- BELOW NOISE FLOOR");
    Serial.printf("  crest factor %7.2f   (1.41 = pure sine, 2.5-3.5 = non-PFC charger)\n", sig.crest);
    Serial.printf("  form factor  %7.2f   (1.11 = pure sine)\n", sig.formFactor);
    Serial.printf("  conduction   %6.0f%%    (how much of the cycle draws current)\n", sig.conduction * 100);
    Serial.printf("  THD          %7.2f   (0 = pure sine)\n", sig.thd);
    Serial.printf("  harmonics    h3 %.2f   h5 %.2f   h7 %.2f\n", sig.h3, sig.h5, sig.h7);
    Serial.println("---------------------------------------------------------------------");
    Serial.printf("  VERDICT: %s\n", sig.label);
    explainVerdict(sig);
    Serial.println("=====================================================================\n");
}

// --- Profile storage -----------------------------------------------------
// One profile, kept in NVS so it is still there after a power cycle.
void saveProfile(const WfSignature& sig, const char* label) {
    if (!sig.valid) {
        Serial.println("Refusing to save: that capture was below the noise floor.");
        Serial.println("Switch the relay on and make sure the device is actually drawing.");
        return;
    }
    prefs.begin("wfbench", false);
    prefs.putString("label", label);
    prefs.putBytes("cycle", sig.cycle, sizeof(sig.cycle));
    prefs.putFloat("rms", sig.rmsAdc);
    prefs.putFloat("crest", sig.crest);
    prefs.putFloat("form", sig.formFactor);
    prefs.putFloat("cond", sig.conduction);
    prefs.putFloat("thd", sig.thd);
    prefs.putString("cls", sig.label);
    prefs.end();

    savedProfile = sig;
    strncpy(savedLabel, label, sizeof(savedLabel) - 1);
    savedLabel[sizeof(savedLabel) - 1] = '\0';
    hasSavedProfile = true;

    Serial.printf("Saved profile '%s' (%s, crest %.2f, THD %.2f) to flash.\n",
                  savedLabel, savedProfile.label, savedProfile.crest, savedProfile.thd);
}

void loadProfile() {
    prefs.begin("wfbench", true);
    String label = prefs.getString("label", "");
    if (label.length() > 0 &&
        prefs.getBytesLength("cycle") == sizeof(savedProfile.cycle)) {
        prefs.getBytes("cycle", savedProfile.cycle, sizeof(savedProfile.cycle));
        savedProfile.rmsAdc     = prefs.getFloat("rms", 0);
        savedProfile.crest      = prefs.getFloat("crest", 0);
        savedProfile.formFactor = prefs.getFloat("form", 0);
        savedProfile.conduction = prefs.getFloat("cond", 0);
        savedProfile.thd        = prefs.getFloat("thd", 0);
        savedProfile.valid      = true;
        savedProfile.label      = wfClassify(savedProfile);
        label.toCharArray(savedLabel, sizeof(savedLabel));
        hasSavedProfile = true;
        Serial.printf("Loaded saved profile '%s' (%s, crest %.2f).\n",
                      savedLabel, savedProfile.label, savedProfile.crest);
    }
    prefs.end();
}

// Shape distance: compare the two normalised cycles point by point. Both are
// scaled to their own peak first, so a bulb at 40W and the same bulb at 60W
// match - it is the shape being compared, never the size.
float shapeDistance(const WfSignature& a, const WfSignature& b) {
    float peakA = 0, peakB = 0;
    for (int n = 0; n < WF_BINS; n++) {
        if (fabsf(a.cycle[n]) > peakA) peakA = fabsf(a.cycle[n]);
        if (fabsf(b.cycle[n]) > peakB) peakB = fabsf(b.cycle[n]);
    }
    if (peakA <= 0 || peakB <= 0) return 1.0f;

    float sum = 0;
    for (int n = 0; n < WF_BINS; n++) {
        const float d = (a.cycle[n] / peakA) - (b.cycle[n] / peakB);
        sum += d * d;
    }
    return sqrtf(sum / WF_BINS);
}

void matchAgainstProfile() {
    if (!hasSavedProfile) {
        Serial.println("No profile saved yet. Capture a device and use:  save <NAME>");
        return;
    }
    WfSignature live = wfCapture(CURRENT_PINS[activeChannel]);
    if (!live.valid) {
        Serial.println("Nothing drawing on this channel - is the relay on?");
        return;
    }

    const float distance = shapeDistance(live, savedProfile);
    Serial.println();
    Serial.printf("Saved   : %-16s %s   crest %.2f  THD %.2f\n",
                  savedLabel, savedProfile.label, savedProfile.crest, savedProfile.thd);
    Serial.printf("Live    : %-16s %s   crest %.2f  THD %.2f\n",
                  "(now)", live.label, live.crest, live.thd);
    Serial.printf("Shape difference: %.3f  ", distance);

    // Threshold checked in backend/selftest.py against simulated captures:
    // two captures of the same load land around 0.07-0.09 (and a 40W bulb
    // against a 60W bulb is just as close, since size is normalised out),
    // while a bulb against a charger lands near 0.50. Expect real captures to
    // be noisier than that - if same-device matches start reading above 0.25,
    // raise WF_CYCLES before loosening this number.
    if (distance < 0.25f) Serial.println("-> SAME shape as the saved device");
    else if (distance < 0.45f) Serial.println("-> similar, but not a confident match");
    else Serial.println("-> DIFFERENT device");

    if (strcmp(live.label, savedProfile.label) != 0) {
        Serial.printf("Type also differs: saved is %s, live is %s.\n",
                      savedProfile.label, live.label);
    }
    Serial.println();
}

// --- Help ----------------------------------------------------------------
void printHelp() {
    Serial.println();
    Serial.println("Commands");
    Serial.println("  n              measure noise floor (NOTHING plugged in)");
    Serial.println("  on <1-4>       close the relay, socket goes live");
    Serial.println("  off <1-4>      open the relay");
    Serial.println("  off all        open every relay");
    Serial.println("  ch <1-4>       choose which channel to measure");
    Serial.println("  c              capture once and show the waveform");
    Serial.println("  save <NAME>    store this capture as the reference profile");
    Serial.println("  show           print the stored profile");
    Serial.println("  match          compare what is plugged in now to the stored profile");
    Serial.println("  clear          erase the stored profile");
    Serial.println("  log <NAME>     stream labelled CSV rows for collect_samples.py");
    Serial.println("  stop           stop streaming");
    Serial.println("  ?              this help");
    Serial.println();
}

// --- Setup / loop --------------------------------------------------------
void setup() {
    // Drive the pins HIGH *before* making them outputs. An ESP32 GPIO is an
    // input on reset, so an active-LOW relay board sees a floating/low line and
    // clicks ON for a moment during boot if you set pinMode first. With mains
    // wired that is a real switch-on of the socket every time the board resets.
    for (int i = 0; i < 4; i++) {
        digitalWrite(RELAY_PINS[i], RELAY_OFF);
        pinMode(RELAY_PINS[i], OUTPUT);
        digitalWrite(RELAY_PINS[i], RELAY_OFF);
    }

    Serial.begin(115200);
    delay(600);

    analogReadResolution(12);
    for (int i = 0; i < 4; i++) {
        pinMode(CURRENT_PINS[i], INPUT);
        analogSetPinAttenuation(CURRENT_PINS[i], ADC_11db);  // full 0-3.3V range
    }

    Serial.println("\n\n=== WaveformBench ===");
    Serial.println("4-channel relay + 4x ACS712 load signature bench.");
    Serial.printf("Relays  GPIO %d %d %d %d (active LOW, all OFF)\n",
                  RELAY_PINS[0], RELAY_PINS[1], RELAY_PINS[2], RELAY_PINS[3]);
    Serial.printf("Sensors GPIO %d %d %d %d\n",
                  CURRENT_PINS[0], CURRENT_PINS[1], CURRENT_PINS[2], CURRENT_PINS[3]);
    Serial.printf("Sampling %d Hz, %d cycles averaged per capture.\n",
                  WF_SAMPLE_RATE_HZ, WF_CYCLES);

    loadProfile();
    printHelp();
    Serial.println("Start with 'n' to measure the noise floor, nothing plugged in.");
}

void loop() {
    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        if (line.length() == 0) return;

        String lower = line;
        lower.toLowerCase();

        if (lower == "?" || lower == "help") {
            printHelp();

        } else if (lower == "n") {
            Serial.println("Measuring noise floor - make sure NOTHING is plugged in...");
            wfMeasureNoiseFloor(CURRENT_PINS[activeChannel]);
            Serial.println("Put that number in WF_NOISE_FLOOR_ADC in Waveform.h and re-flash.");

        } else if (lower == "c") {
            if (!relayState[activeChannel]) {
                Serial.printf("Note: relay %d is OFF, so no current can flow.\n", activeChannel + 1);
            }
            printSignature(wfCapture(CURRENT_PINS[activeChannel]));

        } else if (lower.startsWith("on ")) {
            setRelay(lower.substring(3).toInt() - 1, true);

        } else if (lower == "off all") {
            for (int i = 0; i < 4; i++) setRelay(i, false);

        } else if (lower.startsWith("off ")) {
            setRelay(lower.substring(4).toInt() - 1, false);

        } else if (lower.startsWith("ch ")) {
            int channel = lower.substring(3).toInt() - 1;
            if (channel >= 0 && channel < 4) {
                activeChannel = channel;
                Serial.printf("Measuring channel %d (sensor GPIO %d)\n",
                              activeChannel + 1, CURRENT_PINS[activeChannel]);
            } else {
                Serial.println("Channel must be 1-4.");
            }

        } else if (lower.startsWith("save ")) {
            saveProfile(wfCapture(CURRENT_PINS[activeChannel]), line.substring(5).c_str());

        } else if (lower == "show") {
            if (!hasSavedProfile) Serial.println("No profile stored.");
            else {
                Serial.printf("\nStored profile: %s\n", savedLabel);
                printTrace(savedProfile);
                Serial.printf("  %s   crest %.2f   form %.2f   conduction %.0f%%   THD %.2f\n\n",
                              savedProfile.label, savedProfile.crest, savedProfile.formFactor,
                              savedProfile.conduction * 100, savedProfile.thd);
            }

        } else if (lower == "match") {
            matchAgainstProfile();

        } else if (lower == "clear") {
            prefs.begin("wfbench", false);
            prefs.clear();
            prefs.end();
            hasSavedProfile = false;
            savedLabel[0] = '\0';
            Serial.println("Stored profile erased.");

        } else if (lower.startsWith("log ")) {
            line.substring(4).toCharArray(streamLabel, sizeof(streamLabel));
            streaming = true;
            Serial.printf("Streaming CSV as '%s'. Type 'stop' to end.\n", streamLabel);

        } else if (lower == "stop") {
            streaming = false;
            Serial.println("Streaming stopped.");

        } else {
            Serial.printf("Unknown command: %s   (type ? for help)\n", line.c_str());
        }
    }

    if (streaming && millis() - lastStream > streamIntervalMs) {
        lastStream = millis();
        wfPrintCsv(wfCapture(CURRENT_PINS[activeChannel]), streamLabel);
    }
}
