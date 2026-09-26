// ============================================================================
// Aether Gateway - mains metering bench firmware
//
// Measures the incoming supply with a ZMPT101B (voltage) and an ACS712
// (current) on the same circuit, and reports true active power, power factor
// and accumulated energy.
//
// Networking lives in Mesh.h: Wi-Fi provisioning through a captive portal,
// ESP-NOW to the subnodes, MQTT over TLS to the backend. Metering.h knows
// nothing about any of it, so the meter can still be calibrated over serial
// with no network present - and the local safety cutoff keeps working when the
// internet is down, which is the whole point of the mesh.
//
// Pins - see firmware/PINOUT.md:
//   ZMPT101B OUT -> GPIO 35      ACS712 OUT -> GPIO 34
//   Main relay   -> GPIO 23      Buzzer     -> GPIO 25
//
// SAFETY: the ZMPT connects directly across live and neutral. Enclose it.
// Never probe it while mains is connected.
//
// Serial commands (115200 baud, Newline):
//   n              measure the noise floor (relay closed, nothing drawing)
//   m              one measurement
//   live / stop    stream measurements once a second
//   on / off       main relay
//   e              show accumulated energy and cost
//   reset          zero the energy counter
//   calv <volts>   calibrate voltage against a multimeter reading
//   calw <watts>   calibrate current against a known resistive load
//   net            Wi-Fi, MQTT and mesh status
//   forget         wipe Wi-Fi and mesh credentials, then restart
//   ?              help
// ============================================================================

#include "Metering.h"
#include "Mesh.h"

const int VOLTAGE_PIN = 35;   // ZMPT101B  - ADC1, input-only
const int CURRENT_PIN = 34;   // ACS712    - ADC1, input-only
const int RELAY_PIN   = 23;   // main relay, active LOW
const int BUZZER_PIN  = 25;
const int STATUS_LED  = 2;
const int RESET_PIN   = 0;    // onboard BOOT button - hold 5s to wipe settings

// Local overcurrent protection. This trips WITHOUT the network: the gateway
// measures the whole supply, so it can cut before a fault becomes a fire even
// with the broker unreachable. Aether compared a raw ADC count and shipped the
// threshold at 4095, which disabled it; here it is a real amp figure from the
// calibrated meter, so the number means something.
const float OVERCURRENT_AMPS = 12.0f;

const int RELAY_ON  = LOW;
const int RELAY_OFF = HIGH;

// Domestic slab rate, rupees per kWh. Adjust to the local tariff.
const float TARIFF_RUPEES_PER_KWH = 8.0f;

MtEnergy energy;
bool relayClosed = false;
bool streaming = false;
unsigned long lastStream = 0;

// Safety state. `tripped` latches until something clears it deliberately -
// a hazard cutoff must not undo itself because the next reading looked calm.
bool tripped = false;
String safetyStatus = "SAFE";
unsigned long lastTelemetryPublish = 0;
const unsigned long telemetryIntervalMs = 2000;

void setRelay(bool closed) {
    digitalWrite(RELAY_PIN, closed ? RELAY_ON : RELAY_OFF);
    relayClosed = closed;
    Serial.printf("Main relay %s\n", closed ? "CLOSED - supply live" : "OPEN - supply dead");
}

void printReading(const MtReading& r) {
    Serial.println();
    Serial.println("=====================================================================");
    Serial.printf("  voltage        %7.1f V rms      (%.1f ADC rms)\n", r.vRms, r.vRmsAdc);
    Serial.printf("  current        %7.3f A rms      (%.1f ADC rms)%s\n", r.iRms, r.iRmsAdc,
                  r.valid ? "" : "   <-- below noise floor");
    Serial.printf("  frequency      %7.1f Hz         %s\n", r.frequency,
                  (r.frequency > 45 && r.frequency < 65) ? "" : "<-- NOT MAINS, check the ZMPT");
    Serial.println("  -------------------------------------------------------------------");
    Serial.printf("  ACTIVE power   %7.1f W          <- what the meter bills\n", r.activePower);
    Serial.printf("  apparent power %7.1f VA         <- Vrms x Irms\n", r.apparentPower);
    Serial.printf("  power factor   %7.2f            %s\n", r.powerFactor, mtLoadCharacter(r));

    if (r.valid && r.apparentPower > 1.0f) {
        const float wasted = r.apparentPower - r.activePower;
        Serial.printf("  the gap        %7.1f VA         drawn from the grid but not consumed\n",
                      wasted);
    }
    Serial.println("=====================================================================\n");
}

void measureNoiseFloor() {
    Serial.println("Measuring noise floor - make sure NOTHING is drawing...");
    float worstCurrent = 0, worstVoltage = 0;
    for (int i = 0; i < 10; i++) {
        MtReading r = mtMeasure(VOLTAGE_PIN, CURRENT_PIN);
        if (r.iRmsAdc > worstCurrent) worstCurrent = r.iRmsAdc;
        if (r.vRmsAdc > worstVoltage) worstVoltage = r.vRmsAdc;
    }
    Serial.printf("\n  current noise floor: %.2f ADC rms -> set MT_NOISE_FLOOR_ADC to %.1f\n",
                  worstCurrent, worstCurrent * 1.5f);
    Serial.printf("  voltage amplitude  : %.2f ADC rms\n", worstVoltage);
    if (worstVoltage < 10) {
        Serial.println("  WARNING: almost no voltage signal. The ZMPT is not seeing mains,");
        Serial.println("  or its trim pot is turned right down.");
    }
    Serial.println();
}

void calibrateVoltage(float trueVolts) {
    MtReading r = mtMeasure(VOLTAGE_PIN, CURRENT_PIN);
    if (r.vRmsAdc < 1.0f) {
        Serial.println("No voltage signal to calibrate against.");
        return;
    }
    Serial.printf("\n  reported %.1f V, you measured %.1f V\n", r.vRms, trueVolts);
    Serial.printf("  set MT_VOLT_CAL to %.4f  (was %.4f)\n\n",
                  trueVolts / r.vRmsAdc, MT_VOLT_CAL);
}

void calibrateCurrent(float trueWatts) {
    MtReading r = mtMeasure(VOLTAGE_PIN, CURRENT_PIN);
    if (!r.valid || r.activePower < 1.0f) {
        Serial.println("No load detected. Plug in a known resistive load and close the relay.");
        return;
    }
    Serial.printf("\n  reported %.1f W, load is rated %.1f W\n", r.activePower, trueWatts);
    Serial.printf("  set MT_CURR_CAL to %.5f  (was %.5f)\n",
                  MT_CURR_CAL * trueWatts / r.activePower, MT_CURR_CAL);
    if (r.powerFactor < 0.95f) {
        Serial.printf("  CAUTION: power factor is %.2f. A resistive load should be above\n",
                      r.powerFactor);
        Serial.println("  0.95 - calibrate against the wattage only once it is, or the");
        Serial.println("  constant will absorb a phase error instead of fixing it.");
    }
    Serial.println();
}

void printEnergy() {
    Serial.printf("\n  energy  %.3f Wh  (%.5f kWh)\n", energy.wattHours, energy.wattHours / 1000.0);
    Serial.printf("  cost    Rs %.4f  at Rs %.2f/kWh\n\n",
                  mtCostRupees(energy, TARIFF_RUPEES_PER_KWH), TARIFF_RUPEES_PER_KWH);
}

// Called by Mesh.h for commands aimed at this gateway's own hardware. Kept
// here rather than in the mesh layer so that header stays free of the pin map.
void meshHandleGatewayCommand(const String& action, JsonDocument& doc) {
    if (action == "RESET_SAFETY") {
        tripped = false;
        safetyStatus = "SAFE";
        setRelay(true);
        digitalWrite(BUZZER_PIN, LOW);
        Serial.println("Safety reset from the dashboard: supply restored.");
    } else if (action == "SHUT_SOLENOID" || action == "TRIP_RELAY") {
        tripped = true;
        safetyStatus = (action == "TRIP_RELAY") ? String(doc["status"] | "GAS_LEAK")
                                                : String("HAZARD_SHUTOFF");
        setRelay(false);
        digitalWrite(BUZZER_PIN, HIGH);
        Serial.println("Hazard cutoff: main supply opened (" + safetyStatus + ")");
    } else if (action == "BUZZER_ALERT") {
        digitalWrite(BUZZER_PIN, HIGH);
        safetyStatus = "HAZARD_WARNING";
    } else if (action == "RELAY_ON") {
        if (!tripped) setRelay(true);
        else Serial.println("Refusing to close the relay while tripped - reset safety first.");
    } else if (action == "RELAY_OFF") {
        setRelay(false);
    }
}

// The gateway's own telemetry. Unlike the subnodes this carries real measured
// voltage, active power and power factor, because it is the only node with a
// voltage reference - so the backend's cost figures come from here.
void publishTelemetry(const MtReading& r) {
    char payload[400];
    snprintf(payload, sizeof(payload),
        "{\"action\":\"TELEMETRY\",\"mac\":\"%s\",\"mesh_id\":\"%s\","
        "\"role\":\"gateway\",\"gas\":0,\"current\":%.3f,\"voltage\":%.1f,"
        "\"power\":%.1f,\"apparent_power\":%.1f,\"power_factor\":%.3f,"
        "\"frequency\":%.1f,\"energy_wh\":%.3f,\"pir\":1,\"flame\":1,"
        "\"status\":\"%s\"}",
        meshMac().c_str(), meshCurrentId().c_str(),
        r.iRms, r.vRms, r.activePower, r.apparentPower, r.powerFactor,
        r.frequency, (float)energy.wattHours, safetyStatus.c_str());
    if (meshPublishTelemetry(payload)) {
        Serial.printf("Published %.1f W, PF %.2f, %.3f Wh\n",
                      r.activePower, r.powerFactor, energy.wattHours);
    }
}

void printNetworkStatus() {
    Serial.println();
    Serial.printf("  wi-fi     %s", WiFi.status() == WL_CONNECTED ? "connected" : "DISCONNECTED");
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("   ssid %s   ip %s   channel %d   rssi %d dBm",
                      WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(),
                      WiFi.channel(), WiFi.RSSI());
    }
    Serial.println();
    Serial.printf("  mqtt      %s\n", meshOnline() ? "connected" : "DISCONNECTED");
    Serial.printf("  mesh id   %s\n", meshCurrentId().length() ? meshCurrentId().c_str()
                                                               : "(not paired - use the setup portal)");
    Serial.printf("  mac       %s\n", meshMac().c_str());
    Serial.printf("  safety    %s%s\n\n", safetyStatus.c_str(), tripped ? "  [TRIPPED]" : "");
}

void printHelp() {
    Serial.println();
    Serial.println("  n              measure the noise floor (nothing drawing)");
    Serial.println("  m              one measurement");
    Serial.println("  live / stop    stream measurements once a second");
    Serial.println("  on / off       main relay");
    Serial.println("  e              accumulated energy and cost");
    Serial.println("  reset          zero the energy counter");
    Serial.println("  calv <volts>   calibrate voltage against a multimeter");
    Serial.println("  calw <watts>   calibrate current against a known resistive load");
    Serial.println("  cal            show the full calibration procedure");
    Serial.println("  net            wi-fi, mqtt and mesh status");
    Serial.println("  forget         wipe wi-fi and mesh credentials, then restart");
    Serial.println();
}

void setup() {
    // HIGH before pinMode, so an active-LOW relay does not click on during boot.
    digitalWrite(RELAY_PIN, RELAY_OFF);
    pinMode(RELAY_PIN, OUTPUT);
    digitalWrite(RELAY_PIN, RELAY_OFF);

    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);
    pinMode(STATUS_LED, OUTPUT);
    digitalWrite(STATUS_LED, LOW);   // gateway LED stays dark
    pinMode(RESET_PIN, INPUT_PULLUP);

    Serial.begin(115200);
    delay(600);

    analogReadResolution(12);
    analogSetPinAttenuation(VOLTAGE_PIN, ADC_11db);   // full 0-3.3V range
    analogSetPinAttenuation(CURRENT_PIN, ADC_11db);
    pinMode(VOLTAGE_PIN, INPUT);
    pinMode(CURRENT_PIN, INPUT);

    Serial.println("\n\n=== Aether Gateway - mains metering ===");
    Serial.printf("ZMPT on GPIO %d, ACS712 on GPIO %d, main relay on GPIO %d\n",
                  VOLTAGE_PIN, CURRENT_PIN, RELAY_PIN);
    Serial.printf("Sampling %d pairs/s, %d cycles per window\n", MT_SAMPLE_PAIRS, MT_CYCLES);
    Serial.printf("Calibration: MT_VOLT_CAL %.4f, MT_CURR_CAL %.5f\n", MT_VOLT_CAL, MT_CURR_CAL);
    Serial.println("Relay is OPEN. Start with 'cal' if this is a fresh build.");

    // Brings up Wi-Fi (captive portal on first boot), ESP-NOW and MQTT. Blocks
    // for up to the portal timeout if there is no saved network.
    meshBegin();
    printHelp();
}

void loop() {
    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        String lower = line;
        lower.toLowerCase();

        if (lower.length() == 0) {
            // nothing to do
        } else if (lower == "?" || lower == "help") {
            printHelp();
        } else if (lower == "cal") {
            mtCalibrationHelp();
        } else if (lower == "n") {
            measureNoiseFloor();
        } else if (lower == "m") {
            MtReading r = mtMeasure(VOLTAGE_PIN, CURRENT_PIN);
            mtAccumulate(energy, r);
            printReading(r);
        } else if (lower == "on") {
            setRelay(true);
        } else if (lower == "off") {
            setRelay(false);
        } else if (lower == "live") {
            streaming = true;
            Serial.println("Streaming. Type 'stop' to end.");
        } else if (lower == "stop") {
            streaming = false;
            Serial.println("Stopped.");
        } else if (lower == "e") {
            printEnergy();
        } else if (lower == "reset") {
            energy = MtEnergy();
            Serial.println("Energy counter zeroed.");
        } else if (lower.startsWith("calv ")) {
            calibrateVoltage(lower.substring(5).toFloat());
        } else if (lower.startsWith("calw ")) {
            calibrateCurrent(lower.substring(5).toFloat());
        } else if (lower == "net") {
            printNetworkStatus();
        } else if (lower == "forget") {
            Serial.println("Wiping wi-fi and mesh credentials...");
            meshFactoryReset();
        } else {
            Serial.printf("Unknown command: %s   (? for help)\n", line.c_str());
        }
    }

    meshLoop();

    // Periodic telemetry to the backend, independent of the serial stream.
    if (millis() - lastTelemetryPublish > telemetryIntervalMs) {
        lastTelemetryPublish = millis();
        MtReading r = mtMeasure(VOLTAGE_PIN, CURRENT_PIN);
        mtAccumulate(energy, r);

        // Checked on every measurement, not only when online - protection that
        // depends on the network is not protection.
        if (r.valid && r.iRms > OVERCURRENT_AMPS && !tripped) {
            tripped = true;
            safetyStatus = "OVERCURRENT_TRIP";
            setRelay(false);
            Serial.printf("OVERCURRENT: %.2f A exceeded %.1f A - supply opened\n",
                          r.iRms, OVERCURRENT_AMPS);
        }

        if (meshOnline()) publishTelemetry(r);
    }

    if (streaming && millis() - lastStream > 1000) {
        lastStream = millis();
        MtReading r = mtMeasure(VOLTAGE_PIN, CURRENT_PIN);
        mtAccumulate(energy, r);
        Serial.printf("%6.1f V   %6.3f A   %7.1f W   %6.1f VA   PF %.2f   %5.1f Hz   %.3f Wh   %s\n",
                      r.vRms, r.iRms, r.activePower, r.apparentPower, r.powerFactor,
                      r.frequency, energy.wattHours, mtLoadCharacter(r));
    }

    // The gateway deliberately leaves its LED dark. It is a fixed box at the
    // meter - you are not standing over it reading a blink pattern, and its
    // state is better seen through `net` on serial or the dashboard. The blue
    // LED is reserved for the subnodes, which are the things you move around
    // and need feedback from while pairing.
}
