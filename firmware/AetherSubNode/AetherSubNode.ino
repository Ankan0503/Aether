// ============================================================================
// Aether Automation SubNode - three switched sockets, load identification and
// occupancy-based cutoff.
//
// This is the node already wired on the bench. It does three things:
//   1. switches three mains sockets
//   2. works out WHAT is plugged into each one, from current waveform shape
//   3. opens a socket that is drawing with nobody in the room
//
// Still deliberately standalone - no Wi-Fi, ESP-NOW or MQTT. The cutoff rule
// has to behave correctly against real loads before networking hides it behind
// a dashboard, and the same bench-first approach is what caught the sensor and
// averaging faults earlier.
//
// Pins - see firmware/PINOUT.md:
//   Socket 1  relay GPIO 18 (IN1)   current GPIO 32
//   Socket 2  relay GPIO 22 (IN2)   current GPIO 35
//   Socket 3  relay GPIO 21 (IN4)   current GPIO 34
//   PIR       GPIO 19
//
// Socket 3 runs through the relay board's channel 4 - channel 3 kept sticking
// closed on a 100W USB-C charger's inrush. GPIO 21 still means socket 3.
//
// Serial commands (115200 baud, Newline):
//   s                  status of every socket and the room
//   on <1-3>           close a socket
//   off <1-3>          open a socket
//   id <1-3>           identify what is plugged into a socket
//   scan               identify all three
//   arm / disarm       enable or disable the automatic cutoff
//   grace <seconds>    no-motion delay before cutting an active load
//   idle <seconds>     shorter delay for a load that is only idling
//   pir                live PIR state and time since motion
//   n <1-3>            measure a channel's noise floor
//   ?                  help
// ============================================================================

#include "Waveform.h"
#include "Occupancy.h"

const int RELAY_PINS[OCC_SOCKETS]   = {18, 22, 21};
const int CURRENT_PINS[OCC_SOCKETS] = {32, 35, 34};
const int PIR_PIN    = 19;
const int STATUS_LED = 2;

const int RELAY_ON  = LOW;    // relay board is active LOW
const int RELAY_OFF = HIGH;

OccupancyState room;
SocketState sockets[OCC_SOCKETS];
CutoffConfig config;

int scanChannel = 0;
unsigned long lastScan = 0;
unsigned long lastEvaluate = 0;
unsigned long lastAccumulate = 0;
const unsigned long scanIntervalMs = 3000;      // one socket measured every 3s
const unsigned long evaluateIntervalMs = 1000;

void setRelay(int index, bool closed, bool byRule) {
    if (index < 0 || index >= OCC_SOCKETS) return;
    digitalWrite(RELAY_PINS[index], closed ? RELAY_ON : RELAY_OFF);
    sockets[index].relayClosed = closed;
    if (closed) {
        // A human closing a socket clears the rule's claim on it, so it is not
        // immediately reported as "cut by Aether" again.
        sockets[index].cutByRule = false;
        sockets[index].savedAdcSeconds = 0;
    } else if (byRule) {
        sockets[index].cutByRule = true;
        sockets[index].cutAtMs = millis();
        // Snapshot the draw before the relay opens and the reading collapses.
        sockets[index].currentAtCutAdc = sockets[index].currentAdc;
    }
    Serial.printf("Socket %d %s%s\n", index + 1,
                  closed ? "CLOSED - live" : "OPEN - dead",
                  (!closed && byRule) ? "   (cut automatically)" : "");
}

// Measure one socket and update what we believe is plugged into it.
void refreshSocket(int index) {
    WfSignature signature = wfCapture(CURRENT_PINS[index]);
    sockets[index].currentAdc = signature.rmsAdc;
    sockets[index].loadType = signature.valid ? signature.label : "NONE";
}

void printStatus() {
    const uint32_t quiet = occSecondsSinceMotion(room);
    Serial.println();
    Serial.println("=====================================================================");
    Serial.printf("  room: %s", room.motionNow ? "MOTION NOW" : "still");
    if (!room.everSeenMotion) Serial.printf("   no motion since boot (%lus)", (unsigned long)quiet);
    else Serial.printf("   last motion %lus ago", (unsigned long)quiet);
    Serial.printf("   events %lu\n", (unsigned long)room.motionEvents);
    Serial.printf("  cutoff: %s   active grace %lus   idle grace %lus\n",
                  config.enabled ? "ARMED" : "disarmed",
                  (unsigned long)config.graceSeconds, (unsigned long)config.idleGraceSeconds);
    Serial.println("  -------------------------------------------------------------------");
    Serial.println("  socket  relay   current   band     what is plugged in");
    for (int i = 0; i < OCC_SOCKETS; i++) {
        Serial.printf("    %d     %-6s  %6.1f   %-7s  %s%s\n",
                      i + 1,
                      sockets[i].relayClosed ? "closed" : "open",
                      sockets[i].currentAdc,
                      occLoadBand(sockets[i]),
                      sockets[i].loadType,
                      sockets[i].cutByRule ? "   [cut by Aether]" : "");
    }

    // Only meaningful once something has been cut.
    float totalSaved = 0;
    for (int i = 0; i < OCC_SOCKETS; i++) totalSaved += sockets[i].savedAdcSeconds;
    if (totalSaved > 0) {
        Serial.println("  -------------------------------------------------------------------");
        Serial.printf("  avoided draw: %.0f ADC-step-seconds since cutting\n", totalSaved);
        Serial.println("  (not converted to watts here - the subnode has no voltage reference,");
        Serial.println("   so the gateway's power factor is needed for an honest figure)");
    }
    Serial.println("=====================================================================\n");
}

void identifySocket(int index) {
    if (!sockets[index].relayClosed) {
        Serial.printf("Socket %d is open - no current can flow. Close it first.\n", index + 1);
        return;
    }
    WfSignature signature = wfCapture(CURRENT_PINS[index]);
    sockets[index].currentAdc = signature.rmsAdc;
    sockets[index].loadType = signature.valid ? signature.label : "NONE";

    Serial.println();
    Serial.printf("  socket %d  (sensor GPIO %d)\n", index + 1, CURRENT_PINS[index]);
    if (!signature.valid) {
        Serial.printf("  amplitude %.1f ADC rms - below the noise floor.\n", signature.rmsAdc);
        Serial.println("  Nothing plugged in, or a standby load too small for this sensor.");
        Serial.println();
        return;
    }
    Serial.printf("  amplitude    %6.1f ADC rms\n", signature.rmsAdc);
    Serial.printf("  crest factor %6.2f   (1.41 = pure sine)\n", signature.crest);
    Serial.printf("  conduction   %5.0f%%    (how much of the cycle draws)\n",
                  signature.conduction * 100);
    Serial.printf("  THD          %6.2f\n", signature.thd);
    Serial.printf("  -> %s\n", signature.label);
    if (strcmp(signature.label, WF_CLASS_RESISTIVE) == 0) {
        Serial.println("     clean sine: a filament bulb, heater or iron");
    } else if (strcmp(signature.label, WF_CLASS_SMPS) == 0) {
        Serial.println("     spiky draw near the voltage peaks: a charger, LED driver or TV");
    } else {
        Serial.println("     between the two: an active-PFC supply, or two loads sharing it");
    }
    Serial.println();
}

// The automatic cutoff. Runs once a second against the latest measurements.
//
// It only ever OPENS a socket. Nothing here closes one when motion returns:
// silently energising a mains socket because a sensor twitched is a decision
// that should be explicit, not a side effect. Re-closing is a human action, or
// a backend one with a rule behind it.
void evaluateCutoff() {
    for (int i = 0; i < OCC_SOCKETS; i++) {
        CutoffDecision decision = occEvaluate(sockets[i], room, config);
        if (!decision.shouldCut) continue;

        Serial.printf("\n[CUTOFF] socket %d: %s\n", i + 1, decision.reason);
        Serial.printf("         %s drawing %.1f ADC rms, no motion for %lus\n",
                      sockets[i].loadType, sockets[i].currentAdc,
                      (unsigned long)occSecondsSinceMotion(room));
        setRelay(i, false, true);
    }
}

void printHelp() {
    Serial.println();
    Serial.println("  s                status of every socket and the room");
    Serial.println("  on <1-3>         close a socket");
    Serial.println("  off <1-3>        open a socket");
    Serial.println("  id <1-3>         identify what is plugged into a socket");
    Serial.println("  scan             identify all three");
    Serial.println("  arm / disarm     enable or disable the automatic cutoff");
    Serial.println("  grace <seconds>  no-motion delay before cutting an active load");
    Serial.println("  idle <seconds>   shorter delay for a load that is only idling");
    Serial.println("  pir              live PIR state");
    Serial.println("  n <1-3>          measure a channel's noise floor");
    Serial.println();
}

void setup() {
    // HIGH before pinMode: an ESP32 GPIO is an input on reset, so an active-LOW
    // relay board would otherwise click every socket on during boot.
    for (int i = 0; i < OCC_SOCKETS; i++) {
        digitalWrite(RELAY_PINS[i], RELAY_OFF);
        pinMode(RELAY_PINS[i], OUTPUT);
        digitalWrite(RELAY_PINS[i], RELAY_OFF);
    }
    pinMode(STATUS_LED, OUTPUT);
    pinMode(PIR_PIN, INPUT);
    occBegin(room);

    Serial.begin(115200);
    delay(600);

    analogReadResolution(12);
    for (int i = 0; i < OCC_SOCKETS; i++) {
        pinMode(CURRENT_PINS[i], INPUT);
        analogSetPinAttenuation(CURRENT_PINS[i], ADC_11db);
    }

    Serial.println("\n\n=== Aether Automation SubNode ===");
    Serial.printf("Sockets: relay GPIO %d/%d/%d, current GPIO %d/%d/%d\n",
                  RELAY_PINS[0], RELAY_PINS[1], RELAY_PINS[2],
                  CURRENT_PINS[0], CURRENT_PINS[1], CURRENT_PINS[2]);
    Serial.printf("PIR on GPIO %d. All sockets open.\n", PIR_PIN);
    Serial.println("Cutoff is DISARMED until you type 'arm'.");
    printHelp();
}

void loop() {
    occUpdate(room, PIR_PIN);

    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        String lower = line;
        lower.toLowerCase();

        if (lower.length() == 0) {
            // nothing
        } else if (lower == "?" || lower == "help") {
            printHelp();
        } else if (lower == "s" || lower == "status") {
            printStatus();
        } else if (lower.startsWith("on ")) {
            setRelay(lower.substring(3).toInt() - 1, true, false);
        } else if (lower.startsWith("off ")) {
            setRelay(lower.substring(4).toInt() - 1, false, false);
        } else if (lower.startsWith("id ")) {
            int index = lower.substring(3).toInt() - 1;
            if (index >= 0 && index < OCC_SOCKETS) identifySocket(index);
            else Serial.println("Socket must be 1-3.");
        } else if (lower == "scan") {
            for (int i = 0; i < OCC_SOCKETS; i++) identifySocket(i);
        } else if (lower == "arm") {
            config.enabled = true;
            Serial.printf("Cutoff ARMED. Active loads cut after %lus without motion,\n",
                          (unsigned long)config.graceSeconds);
            Serial.printf("idling loads after %lus.\n", (unsigned long)config.idleGraceSeconds);
        } else if (lower == "disarm") {
            config.enabled = false;
            Serial.println("Cutoff disarmed. Sockets stay as they are.");
        } else if (lower.startsWith("grace ")) {
            config.graceSeconds = (uint32_t)lower.substring(6).toInt();
            Serial.printf("Active-load grace period: %lus\n", (unsigned long)config.graceSeconds);
        } else if (lower.startsWith("idle ")) {
            config.idleGraceSeconds = (uint32_t)lower.substring(5).toInt();
            Serial.printf("Idle-load grace period: %lus\n", (unsigned long)config.idleGraceSeconds);
        } else if (lower == "pir") {
            const uint32_t quiet = occSecondsSinceMotion(room);
            Serial.printf("PIR GPIO %d reads %s.  ", PIR_PIN, room.motionNow ? "HIGH" : "LOW");
            if (!room.everSeenMotion) Serial.printf("No motion since boot (%lus).\n",
                                                    (unsigned long)quiet);
            else Serial.printf("Last motion %lus ago, %lu events.\n",
                               (unsigned long)quiet, (unsigned long)room.motionEvents);
        } else if (lower.startsWith("n ")) {
            int index = lower.substring(2).toInt() - 1;
            if (index >= 0 && index < OCC_SOCKETS) {
                Serial.println("Measuring noise floor - nothing should be drawing...");
                wfMeasureNoiseFloor(CURRENT_PINS[index]);
            } else {
                Serial.println("Socket must be 1-3.");
            }
        } else {
            Serial.printf("Unknown command: %s   (? for help)\n", line.c_str());
        }
    }

    // Round-robin measurement. One socket per sweep so a capture - 320ms of
    // sampling plus the DFT - never stalls the loop for long.
    if (millis() - lastScan > scanIntervalMs) {
        lastScan = millis();
        if (sockets[scanChannel].relayClosed) refreshSocket(scanChannel);
        else sockets[scanChannel].currentAdc = 0;
        scanChannel = (scanChannel + 1) % OCC_SOCKETS;
    }

    if (millis() - lastEvaluate > evaluateIntervalMs) {
        lastEvaluate = millis();
        evaluateCutoff();
    }

    if (millis() - lastAccumulate > 1000) {
        const uint32_t elapsed = millis() - lastAccumulate;
        lastAccumulate = millis();
        for (int i = 0; i < OCC_SOCKETS; i++) occAccumulateSaving(sockets[i], elapsed);
    }

    // Solid while someone is present, slow blink when the room is empty.
    digitalWrite(STATUS_LED, room.motionNow ? HIGH : ((millis() / 1000) % 2));
}
