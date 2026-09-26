// ============================================================================
// Aether SubNode - one sketch, two roles. Pick one before flashing.
//
//   DEVICE_TYPE_AUTOMATION  three switched sockets, load identification from
//                           waveform shape, and occupancy-based cutoff.
//
//   DEVICE_TYPE_KITCHEN     gas and flame sensing with a local buzzer, and a
//                           peer-to-peer emergency trip that opens every relay
//                           on the mesh without involving the gateway.
//
// Both roles share the mesh layer, the pairing flow and the serial console;
// only the sensing and acting differ. Same structure as the original Aether
// subnode, so a node can be reflashed between roles without rewiring anything
// but its sensors.
//
// Networking is in Mesh.h: ESP-NOW only, never Wi-Fi. The node discovers the
// gateway, is paired from the dashboard, then publishes telemetry and load
// signatures through it. Every serial command still works, so the rule can be
// watched directly rather than through a dashboard.
//
// The cutoff runs locally and does not need the gateway: a room keeps managing
// its own sockets with the internet down.
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
//   net                pairing and gateway status
//   unpair             forget the mesh credentials
//   ?                  help
// ============================================================================

// ==========================================================================
// ROLE SWITCH - uncomment exactly one, then flash.
// ==========================================================================
// Uncomment for a kitchen node, or - better - pass it at build time so the
// file never has to be edited and the wrong role cannot be flashed by
// forgetting to change it back:
//
//   arduino-cli compile --build-property \
//       "compiler.cpp.extra_flags=-DDEVICE_TYPE_KITCHEN" firmware/AetherSubNode
//
#define DEVICE_TYPE_KITCHEN

// Automation is the default only when nothing else was selected.
#ifndef DEVICE_TYPE_KITCHEN
#define DEVICE_TYPE_AUTOMATION
#endif

#if defined(DEVICE_TYPE_KITCHEN) && defined(DEVICE_TYPE_AUTOMATION)
#error "Pick one role: a node is either the kitchen sensor or the socket relay."
#endif
#if !defined(DEVICE_TYPE_KITCHEN) && !defined(DEVICE_TYPE_AUTOMATION)
#error "No role selected - uncomment DEVICE_TYPE_KITCHEN or DEVICE_TYPE_AUTOMATION."
#endif

#include "Waveform.h"
#include "Occupancy.h"
#include "Mesh.h"

const int STATUS_LED = 2;
const int RESET_PIN  = 0;    // onboard BOOT button - hold 5s to unpair

#ifdef DEVICE_TYPE_AUTOMATION
const char* NODE_ROLE = "relay";
const int RELAY_PINS[OCC_SOCKETS]   = {18, 22, 21};
const int CURRENT_PINS[OCC_SOCKETS] = {32, 35, 34};
const int PIR_PIN    = 19;

const int RELAY_ON  = LOW;    // relay board is active LOW
const int RELAY_OFF = HIGH;
#endif

#ifdef DEVICE_TYPE_KITCHEN
const char* NODE_ROLE = "sensor";
const int GAS_PIN   = 35;   // MQ-2 analog out, ADC1
const int FLAME_PIN = 32;   // IR flame module digital out - LOW means fire
const int BUZZER_PIN = 25;

// Above this the MQ-2 is reporting gas. Calibrate against clean air: note the
// resting reading and set this well clear of it, or cooking steam will trip it.
int gasThreshold = 3500;

// Buzzer tones. Fire gets the higher, more piercing one so the two hazards are
// distinguishable from another room without looking at anything.
const int TONE_FIRE = 3500;
const int TONE_GAS  = 2200;

bool hadEmergency = false;
unsigned long lastTripSent = 0;
String hazardStatus = "SAFE";
#endif

#ifdef DEVICE_TYPE_AUTOMATION
OccupancyState room;
SocketState sockets[OCC_SOCKETS];
CutoffConfig config;
#endif

#ifdef DEVICE_TYPE_AUTOMATION
int scanChannel = 0;
unsigned long lastScan = 0;
unsigned long lastTelemetry = 0;
unsigned long lastSignature = 0;
int signatureChannel = 0;
const unsigned long telemetryIntervalMs = 10000;    // telemetry sent every 10s (was 2s)
const unsigned long signatureIntervalMs = 60000;    // load signatures sent every 60s (was 15s)
unsigned long lastEvaluate = 0;
unsigned long lastAccumulate = 0;
const unsigned long scanIntervalMs = 10000;          // one socket measured every 10s (was 3s)
const unsigned long evaluateIntervalMs = 1000;
#endif

#ifdef DEVICE_TYPE_KITCHEN
unsigned long lastTelemetry = 0;
const unsigned long telemetryIntervalMs = 2000;
#endif

#ifdef DEVICE_TYPE_AUTOMATION
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
    Serial.println("  socket  relay     ADC      amps     watts  band     what is plugged in");
    for (int i = 0; i < OCC_SOCKETS; i++) {
        const float adc = sockets[i].currentAdc;
        const bool sensorFault = !wfAdcCredible(adc);
        const float amps = wfAdcToAmps(adc);
        // 230 V nominal. The subnode has no voltage reference, so this is an
        // estimate and is labelled as one - the gateway is where true power
        // with a measured power factor comes from.
        Serial.printf("    %d     %-6s  %7.1f  %7.3f  %7.1f  %-7s  %s%s\n",
                      i + 1,
                      sockets[i].relayClosed ? "closed" : "open",
                      adc, amps, amps * 230.0f,
                      occLoadBand(sockets[i]),
                      sockets[i].loadType,
                      sensorFault ? "   [FAULT: sensor reading impossible - check wiring]"
                      : sockets[i].contactsStuck ? "   [FAULT: WILL NOT OPEN]"
                      : sockets[i].cutByRule ? "   [cut by Aether]" : "");
    }
    Serial.println("  (watts estimated at 230 V nominal; the gateway measures true power)");

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

#endif  // DEVICE_TYPE_AUTOMATION - sockets, identification and cutoff

// Called by Mesh.h for commands addressed to this node.
void meshHandleCommand(const String& action, JsonDocument& doc) {
#ifdef DEVICE_TYPE_KITCHEN
    if (action == "RESET_SAFETY") {
        hadEmergency = false;
        hazardStatus = "SAFE";
        ledcWrite(BUZZER_PIN, 0);
        Serial.println("Hazard cleared from the dashboard - alarm muted.");
    } else if (action == "SET_GAS_THRESHOLD") {
        gasThreshold = doc["value"] | gasThreshold;
        Serial.printf("Gas threshold set to %d\n", gasThreshold);
    } else if (action == "BUZZER_TEST") {
        ledcWriteTone(BUZZER_PIN, TONE_GAS);
        delay(400);
        ledcWrite(BUZZER_PIN, 0);
    }
    return;
#else
    if (action == "CONTROL_RELAY" || action == "RELAY_ON" || action == "RELAY_OFF") {
        // The dashboard sends CONTROL_RELAY with a "state" boolean. RELAY_ON and
        // RELAY_OFF are accepted too, so a command sent by hand over MQTT still
        // works and older tooling does not break.
        const bool wanted = (action == "CONTROL_RELAY") ? (doc["state"] | false)
                                                        : (action == "RELAY_ON");

        // Chaining | across two JsonVariants is ambiguous in ArduinoJson 7, so
        // resolve them one at a time.
        int channel = doc["channel"] | 0;
        if (channel == 0) channel = doc["socket_id"] | 0;

        // The backend addresses the relay board's HARDWARE channel, not the
        // socket number: socket 3 was moved to the board's channel 4 after
        // channel 3 kept sticking, so the two stopped being the same thing.
        // Translating here means the firmware follows the wiring and the
        // backend's map stays the single source of truth.
        int socket = 0;
        switch (channel) {
            case 1: socket = 1; break;
            case 2: socket = 2; break;
            case 4: socket = 3; break;   // hardware channel 4 drives socket 3
            case 3: socket = 0; break;   // unused on this wiring
            default: socket = 0; break;
        }

        if (socket >= 1 && socket <= OCC_SOCKETS) {
            Serial.printf("Dashboard: socket %d (hw channel %d) -> %s\n",
                          socket, channel, wanted ? "ON" : "OFF");
            setRelay(socket - 1, wanted, false);
        } else {
            Serial.printf("Ignoring relay command for unknown channel %d\n", channel);
        }
    } else if (action == "TRIP_RELAY") {
        // A gas or fire trip from the kitchen node. Everything off, now.
        // This arrives peer-to-peer over ESP-NOW, so it works with the gateway
        // and the internet both down - which is the point.
        Serial.println("EMERGENCY TRIP from the safety node - opening every socket");

        // Staggered by a few milliseconds each. Three relay coils changing
        // state on the same instant pull a current spike big enough to dip a
        // shared 5V rail and brown out the ESP32 - which resets the node in the
        // middle of the emergency it is responding to. The total delay is under
        // 30ms, far below anything that matters for safety, and it keeps the
        // node alive to keep alarming and to be restored afterwards.
        for (int i = 0; i < OCC_SOCKETS; i++) {
            setRelay(i, false, false);
            delay(12);
        }
    } else if (action == "SET_GRACE") {
        config.graceSeconds = (uint32_t)(doc["seconds"] | (int)config.graceSeconds);
        occSaveConfig(config);
    } else if (action == "ARM_CUTOFF") {
        config.enabled = doc["enabled"] | true;
        occSaveConfig(config);
        Serial.printf("Cutoff %s from the dashboard\n", config.enabled ? "armed" : "disarmed");
    }
#endif
}

#ifdef DEVICE_TYPE_KITCHEN
// The whole point of this node. Gas or flame opens every relay on the mesh by
// broadcasting straight to the other subnodes - no gateway, no Wi-Fi, no
// internet. Most smart-home projects stop working when the router does; this
// path is exactly the one that must not.
void handleHazards() {
    const int flameState = digitalRead(FLAME_PIN);   // LOW means fire
    const int gasValue = analogRead(GAS_PIN);
    const bool emergency = (flameState == LOW) || (gasValue > gasThreshold);

    hazardStatus = (flameState == LOW) ? "FIRE_EMERGENCY"
                 : (gasValue > gasThreshold) ? "GAS_LEAK"
                 : "SAFE";

    if (!emergency) {
        ledcWrite(BUZZER_PIN, 0);
        hadEmergency = false;
        return;
    }

    ledcWriteTone(BUZZER_PIN, hazardStatus == "FIRE_EMERGENCY" ? TONE_FIRE : TONE_GAS);

    // Send on the transition, then repeat every 3s while the hazard lasts - a
    // single broadcast can be missed, and a trip that did not arrive is the
    // one failure this node exists to prevent.
    const unsigned long now = millis();
    if (hadEmergency && now - lastTripSent < 3000) return;
    lastTripSent = now;
    hadEmergency = true;

    char payload[250];
    snprintf(payload, sizeof(payload),
        "{\"action\":\"TRIP_RELAY\",\"mac\":\"%s\",\"mesh_id\":\"%s\","
        "\"status\":\"%s\",\"gas\":%d,\"current\":0,\"pir\":1,\"flame\":%d}",
        meshMac().c_str(), meshCurrentId().c_str(),
        hazardStatus.c_str(), gasValue, flameState);
    meshBroadcast(payload);
    Serial.println("EMERGENCY TRIP BROADCAST: " + hazardStatus);
}

void publishKitchenTelemetry() {
    if (!meshIsPaired()) return;
    const int flameState = digitalRead(FLAME_PIN);
    const int gasValue = analogRead(GAS_PIN);

    char payload[260];
    snprintf(payload, sizeof(payload),
        "{\"action\":\"TELEMETRY\",\"mac\":\"%s\",\"mesh_id\":\"%s\","
        "\"role\":\"sensor\",\"gas\":%d,\"current\":0,\"pir\":1,\"flame\":%d,"
        "\"status\":\"%s\"}",
        meshMac().c_str(), meshCurrentId().c_str(),
        gasValue, flameState, hazardStatus.c_str());
    meshBroadcast(payload);
}

void printKitchenStatus() {
    const int flameState = digitalRead(FLAME_PIN);
    const int gasValue = analogRead(GAS_PIN);
    Serial.println();
    Serial.println("=====================================================================");
    Serial.printf("  gas    %5d  (threshold %d)%s\n", gasValue, gasThreshold,
                  gasValue > gasThreshold ? "   <-- OVER THRESHOLD" : "");
    Serial.printf("  flame  %s\n", flameState == LOW ? "FIRE DETECTED" : "clear");
    Serial.printf("  status %s\n", hazardStatus.c_str());
    Serial.printf("  mesh   %s\n", meshIsPaired() ? meshCurrentId().c_str() : "not paired");
    Serial.println("=====================================================================\n");
}
#endif

#ifdef DEVICE_TYPE_AUTOMATION
// Combined telemetry in the shape the backend already parses: c1/c2/c4 map to
// sockets 1/2/3, since socket 3 runs through the relay board's channel 4.
//
// The current fields are AMPS, not the raw ADC counts this used to send. The
// backend computes power as current * 230 V, so sending counts inflated every
// reading by ~82x and made an idle socket look like a space heater.
void publishTelemetry() {
    if (!meshIsPaired()) return;
    char payload[320];
    snprintf(payload, sizeof(payload),
        "{\"action\":\"TELEMETRY\",\"mac\":\"%s\",\"mesh_id\":\"%s\",\"role\":\"relay\","
        "\"gas\":0,\"current\":%.3f,\"pir\":%d,\"flame\":1,\"status\":\"SAFE\","
        "\"c1\":%.3f,\"c2\":%.3f,\"c3\":0.000,\"c4\":%.3f,"
        "\"r1\":%d,\"r2\":%d,\"r4\":%d}",
        meshMac().c_str(), meshCurrentId().c_str(),
        wfAdcToAmps(sockets[0].currentAdc) + wfAdcToAmps(sockets[1].currentAdc)
            + wfAdcToAmps(sockets[2].currentAdc),
        room.motionNow ? 1 : 0,
        wfAdcToAmps(sockets[0].currentAdc),
        wfAdcToAmps(sockets[1].currentAdc),
        wfAdcToAmps(sockets[2].currentAdc),
        sockets[0].relayClosed ? 1 : 0,
        sockets[1].relayClosed ? 1 : 0,
        sockets[2].relayClosed ? 1 : 0);
    meshBroadcast(payload);
}

// One socket's load signature. Sent as its own frame rather than folded into
// telemetry because the waveform alone is 88 base64 characters and ESP-NOW caps
// a message at 250 bytes.
void publishSignature(int index) {
    if (!meshIsPaired() || !sockets[index].relayClosed) return;

    WfSignature signature = wfCapture(CURRENT_PINS[index]);
    sockets[index].currentAdc = signature.rmsAdc;
    sockets[index].loadType = signature.valid ? signature.label : "NONE";
    if (!signature.valid) return;

    char payload[250];
    const int written = wfBuildPayload(signature, index + 1, meshMac(), meshCurrentId(), payload, sizeof(payload));
    if (written > 0 && written < (int)sizeof(payload)) {
        meshBroadcast(payload);
        Serial.printf("Published socket %d signature: %s (crest %.2f)\n",
                      index + 1, signature.label, signature.crest);
    }
}

#endif  // DEVICE_TYPE_AUTOMATION publishers

// Hold BOOT for five seconds to forget the mesh. A node that followed the
// gateway onto a channel it can no longer reach has no other way back.
void checkResetButton() {
    if (digitalRead(RESET_PIN) != LOW) return;
    unsigned long held = 0;
    while (digitalRead(RESET_PIN) == LOW && held < 5000) {
        delay(100);
        held += 100;
        if (held % 1000 == 0) Serial.printf("Unpair in %lus...\n", (5000 - held) / 1000);
    }
    if (held >= 5000) {
        Serial.println("Unpair requested from the BOOT button.");
        meshUnpair();
    }
}

// The status LED reports MESH state, not sensing state. Occupancy and hazards
// are already visible on serial and in the dashboard; whether the node has
// found its gateway is the one thing you cannot otherwise see, and it is the
// first question worth answering when something is not appearing.
//
//   fast blink  searching for a gateway (unpaired)
//   slow blink  paired, but nothing heard from the gateway recently
//   solid       paired and the gateway is alive
void updateStatusLed() {
    bool on;
    if (!meshIsPaired())          on = (millis() / 150) % 2;
    else if (!meshGatewayAlive()) on = (millis() / 800) % 2;
    else                          on = true;
    digitalWrite(STATUS_LED, on);
}

void printNetworkStatus() {
    Serial.println();
    Serial.printf("  mac        %s\n", meshMac().c_str());
    Serial.printf("  paired     %s\n", meshIsPaired() ? meshCurrentId().c_str()
                                                       : "no - broadcasting discovery");
    Serial.printf("  channel    %d\n", meshCurrentChannel());
    Serial.printf("  gateway    %s\n\n", meshGatewayAlive() ? "reachable"
                                                             : "not heard from recently");
}

void printHelp() {
    Serial.println();
#ifdef DEVICE_TYPE_KITCHEN
    Serial.println("  s                gas, flame and hazard status");
    Serial.println("  gas <value>      set the gas alert threshold");
    Serial.println("  test             sound the buzzer briefly");
    Serial.println("  clear            clear a latched hazard and mute the alarm");
    Serial.println("  net              pairing and gateway status");
    Serial.println("  unpair           forget the mesh credentials");
    Serial.println();
    return;
#else
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
    Serial.println("  net              pairing and gateway status");
    Serial.println("  unpair           forget the mesh credentials");
    Serial.println();
#endif
}

void setup() {
    pinMode(STATUS_LED, OUTPUT);
    pinMode(RESET_PIN, INPUT_PULLUP);
    Serial.begin(115200);
    delay(600);
    analogReadResolution(12);

#ifdef DEVICE_TYPE_KITCHEN
    pinMode(FLAME_PIN, INPUT_PULLUP);
    pinMode(GAS_PIN, INPUT);
    analogSetPinAttenuation(GAS_PIN, ADC_11db);
    ledcAttach(BUZZER_PIN, 2000, 8);
    ledcWrite(BUZZER_PIN, 0);

    Serial.println("\n\n=== Aether Kitchen Safety SubNode ===");
    Serial.printf("Gas on GPIO %d, flame on GPIO %d, buzzer on GPIO %d\n",
                  GAS_PIN, FLAME_PIN, BUZZER_PIN);
    Serial.printf("Gas threshold %d - calibrate it against clean air before trusting it.\n",
                  gasThreshold);
    Serial.println("A hazard trips every relay on the mesh directly, without the gateway.");

    meshBegin(NODE_ROLE);
    printHelp();
}
#else
    // HIGH before pinMode: an ESP32 GPIO is an input on reset, so an active-LOW
    // relay board would otherwise click every socket on during boot.
    for (int i = 0; i < OCC_SOCKETS; i++) {
        digitalWrite(RELAY_PINS[i], RELAY_OFF);
        pinMode(RELAY_PINS[i], OUTPUT);
        digitalWrite(RELAY_PINS[i], RELAY_OFF);
    }
    pinMode(PIR_PIN, INPUT);
    occBegin(room);

    for (int i = 0; i < OCC_SOCKETS; i++) {
        pinMode(CURRENT_PINS[i], INPUT);
        analogSetPinAttenuation(CURRENT_PINS[i], ADC_11db);
    }

    Serial.println("\n\n=== Aether Automation SubNode ===");
    Serial.printf("Sockets: relay GPIO %d/%d/%d, current GPIO %d/%d/%d\n",
                  RELAY_PINS[0], RELAY_PINS[1], RELAY_PINS[2],
                  CURRENT_PINS[0], CURRENT_PINS[1], CURRENT_PINS[2]);
    Serial.printf("PIR on GPIO %d. All sockets open.\n", PIR_PIN);

    // Restore the cutoff settings from NVS before the first decision is made.
    occLoadConfig(config);
    if (config.enabled) {
        Serial.printf("Cutoff is ARMED: active loads cut after %lus without motion,"
                      " idling loads after %lus.\n",
                      (unsigned long)config.graceSeconds,
                      (unsigned long)config.idleGraceSeconds);
        Serial.println("Type 'disarm' to stop it acting.");
    } else {
        Serial.println("Cutoff is DISARMED (saved setting). Type 'arm' to enable it.");
    }

    meshBegin(NODE_ROLE);
    printHelp();
}
#endif  // role-specific setup

void loop() {
    checkResetButton();

#ifdef DEVICE_TYPE_KITCHEN
    meshLoop(NODE_ROLE);
    handleHazards();

    if (millis() - lastTelemetry > telemetryIntervalMs) {
        lastTelemetry = millis();
        publishKitchenTelemetry();
    }

    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        String lower = line;
        lower.toLowerCase();

        if (lower == "?" || lower == "help") printHelp();
        else if (lower == "s" || lower == "status") printKitchenStatus();
        else if (lower == "net") printNetworkStatus();
        else if (lower == "unpair") meshUnpair();
        else if (lower == "test") { ledcWriteTone(BUZZER_PIN, TONE_GAS); delay(400); ledcWrite(BUZZER_PIN, 0); }
        else if (lower == "clear") { hadEmergency = false; hazardStatus = "SAFE"; ledcWrite(BUZZER_PIN, 0);
                                     Serial.println("Hazard cleared."); }
        else if (lower.startsWith("gas ")) { gasThreshold = lower.substring(4).toInt();
                                             Serial.printf("Gas threshold %d\n", gasThreshold); }
        else if (lower.length()) Serial.printf("Unknown command: %s   (? for help)\n", line.c_str());
    }

    // Solid while a hazard is latched, slow blink when clear.
    // A hazard overrides everything - a fast double-rate flash that cannot be
    // confused with either mesh state.
    if (hazardStatus != "SAFE") digitalWrite(STATUS_LED, (millis() / 100) % 2);
    else updateStatusLed();
    return;
#else
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
            occSaveConfig(config);
            Serial.printf("Cutoff ARMED. Active loads cut after %lus without motion,\n",
                          (unsigned long)config.graceSeconds);
            Serial.printf("idling loads after %lus.\n", (unsigned long)config.idleGraceSeconds);
        } else if (lower == "disarm") {
            config.enabled = false;
            occSaveConfig(config);
            Serial.println("Cutoff disarmed. Sockets stay as they are.");
        } else if (lower.startsWith("grace ")) {
            config.graceSeconds = (uint32_t)lower.substring(6).toInt();
            occSaveConfig(config);
            Serial.printf("Active-load grace period: %lus\n", (unsigned long)config.graceSeconds);
        } else if (lower.startsWith("idle ")) {
            config.idleGraceSeconds = (uint32_t)lower.substring(5).toInt();
            occSaveConfig(config);
            Serial.printf("Idle-load grace period: %lus\n", (unsigned long)config.idleGraceSeconds);
        } else if (lower == "pir") {
            const uint32_t quiet = occSecondsSinceMotion(room);
            Serial.printf("PIR GPIO %d reads %s.  ", PIR_PIN, room.motionNow ? "HIGH" : "LOW");
            if (!room.everSeenMotion) Serial.printf("No motion since boot (%lus).\n",
                                                    (unsigned long)quiet);
            else Serial.printf("Last motion %lus ago, %lu events.\n",
                               (unsigned long)quiet, (unsigned long)room.motionEvents);
        } else if (lower == "net") {
            printNetworkStatus();
        } else if (lower == "unpair") {
            meshUnpair();
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

    meshLoop("relay");

    if (millis() - lastTelemetry > telemetryIntervalMs) {
        lastTelemetry = millis();
        publishTelemetry();
    }

    // Load signatures go out far less often than telemetry: the shape of a load
    // changes only when the device does, and each capture costs 320ms of
    // sampling that the safety path should not wait behind.
    if (millis() - lastSignature > signatureIntervalMs) {
        lastSignature = millis();
        publishSignature(signatureChannel);
        signatureChannel = (signatureChannel + 1) % OCC_SOCKETS;
    }

    // Round-robin measurement. One socket per sweep so a capture - 320ms of
    // sampling plus the DFT - never stalls the loop for long.
    if (millis() - lastScan > scanIntervalMs) {
        lastScan = millis();

        // Measure every socket, open or closed. Only measuring the ones we
        // believe are closed makes the single worst failure invisible: a relay
        // whose contacts have welded shut still passes current while the node
        // reports it open, so the safety cutoff silently does nothing. Current
        // flowing through a socket we commanded open is the evidence, and it is
        // only available if we look.
        refreshSocket(scanChannel);

        SocketState& sock = sockets[scanChannel];
        if (!sock.relayClosed && sock.currentAdc >= OCC_NOISE_FLOOR_ADC) {
            if (!sock.contactsStuck) {
                sock.contactsStuck = true;
                Serial.printf("\n[FAULT] socket %d is OPEN but drawing %.1f ADC rms.\n",
                              scanChannel + 1, sock.currentAdc);
                Serial.println("        The relay contacts are not releasing. That socket");
                Serial.println("        cannot be switched off - treat it as permanently live.");
            }
        } else if (sock.relayClosed || sock.currentAdc < OCC_NOISE_FLOOR_ADC) {
            sock.contactsStuck = false;
        }

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

    updateStatusLed();
#endif
}
