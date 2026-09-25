#ifndef AETHER_MESH_H
#define AETHER_MESH_H

// ============================================================================
// Gateway networking - Wi-Fi provisioning, ESP-NOW mesh, MQTT bridge
// ============================================================================
// The gateway is the only node on both networks. It speaks MQTT over TLS to the
// Django backend, and ESP-NOW to the subnodes, and relays between them.
//
// Protocol is deliberately identical to the existing Aether gateway, so the
// backend, the dashboard and any already-flashed subnode work unchanged:
//
//   MQTT topics
//     aether/telemetry         published - sensor data from every node
//     aether/discovery         published - an unpaired node announcing itself
//     aether/pairing/command   subscribed - commands from the backend
//
//   ESP-NOW actions
//     DISCOVER      subnode -> gateway   "I exist, I am unpaired"
//     DISCOVER_ACK  gateway -> subnode   "here is my Wi-Fi channel"
//     PAIR          backend -> subnode   mesh_id + mesh_key + name
//     UNPAIR        backend -> subnode   forget your credentials
//     HEARTBEAT     gateway -> subnodes  every 5s, carries the current channel
//     TELEMETRY     subnode -> gateway   forwarded to MQTT
//     TRIP_RELAY    subnode -> subnode   emergency cutoff, bypasses the gateway
//     WF            subnode -> gateway   load signature, forwarded to MQTT
//
// Why the heartbeat carries the channel: ESP-NOW peers must sit on the same
// Wi-Fi channel, and the router can move the gateway at any time. Without a
// periodic channel broadcast the mesh silently goes deaf after a router change
// - the nodes are still powered and still paired, but nothing gets through.
// ============================================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <esp_now.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFiManager.h>

#if __has_include("secrets.h")
#include "secrets.h"
#endif

#ifndef MQTT_SERVER
#define MQTT_SERVER "your-broker.hivemq.cloud"
#endif
#ifndef MQTT_PORT
#define MQTT_PORT 8883
#endif
#ifndef MQTT_USER
#define MQTT_USER "your-mqtt-username"
#endif
#ifndef MQTT_PASS
#define MQTT_PASS "your-mqtt-password"
#endif
#ifndef WIFI_PORTAL_NAME
#define WIFI_PORTAL_NAME "Aether-Gateway-Setup"
#endif

#define TOPIC_TELEMETRY "aether/telemetry"
#define TOPIC_DISCOVERY "aether/discovery"
#define TOPIC_COMMAND   "aether/pairing/command"

static WiFiClientSecure meshTlsClient;
static PubSubClient mqttClient(meshTlsClient);
static Preferences meshPrefs;

static String meshId = "";
static String meshKey = "";
static unsigned long lastMqttRetry = 0;
static unsigned long lastHeartbeat = 0;

static const uint8_t BROADCAST_ADDR[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// Implemented by the sketch: lets the gateway act on commands that concern its
// own hardware (relay, buzzer, safety reset) without this header knowing the
// pin map.
void meshHandleGatewayCommand(const String& action, JsonDocument& doc);

inline String meshMac() { return WiFi.macAddress(); }
inline bool meshOnline() { return mqttClient.connected(); }
inline const String& meshCurrentId() { return meshId; }

inline void meshBroadcast(const char* payload) {
    esp_now_send(BROADCAST_ADDR, (const uint8_t*)payload, strlen(payload));
}

inline bool meshPublish(const char* topic, const char* payload) {
    if (!mqttClient.connected()) return false;
    return mqttClient.publish(topic, payload);
}

inline bool meshPublishTelemetry(const char* payload) {
    return meshPublish(TOPIC_TELEMETRY, payload);
}

// --- credentials ----------------------------------------------------------
inline void meshSaveConfig(const String& id, const String& key) {
    meshPrefs.begin("mesh-settings", false);
    meshPrefs.putString("mesh_id", id);
    meshPrefs.putString("mesh_key", key);
    meshPrefs.end();
    meshId = id;
    meshKey = key;
    Serial.println("Mesh credentials saved: " + id);
}

inline void meshLoadConfig() {
    meshPrefs.begin("mesh-settings", true);
    meshId = meshPrefs.getString("mesh_id", "");
    meshKey = meshPrefs.getString("mesh_key", "");
    meshPrefs.end();
    Serial.println(meshId.length() ? "Loaded mesh id " + meshId
                                   : "No mesh credentials - waiting for setup portal");
}

inline void meshFactoryReset() {
    meshPrefs.begin("mesh-settings", false);
    meshPrefs.clear();
    meshPrefs.end();
    WiFiManager wm;
    wm.resetSettings();
    Serial.println("Settings wiped. Restarting...");
    delay(1000);
    ESP.restart();
}

// --- MQTT inbound ---------------------------------------------------------
inline void meshMqttCallback(char* topic, byte* payload, unsigned int length) {
    char clean[length + 1];
    memcpy(clean, payload, length);
    clean[length] = '\0';

    JsonDocument doc;
    if (deserializeJson(doc, clean)) return;

    const String action = doc["action"] | "";
    const String targetMac = doc["mac"] | "";

    // Anything not addressed to the gateway is relayed onto the mesh verbatim.
    // Subnodes filter on their own MAC, so the gateway does not need to know
    // which nodes exist - it is a bridge, not a registry.
    if (targetMac.length() && !targetMac.equalsIgnoreCase(meshMac())) {
        meshBroadcast(clean);
        Serial.println("Relayed to mesh: " + String(clean));
        return;
    }

    if (action == "PAIR") {
        meshSaveConfig(doc["mesh_id"] | "", doc["mesh_key"] | "");
    } else if (action == "UNPAIR") {
        meshFactoryReset();
    } else {
        meshHandleGatewayCommand(action, doc);
    }
}

// --- ESP-NOW inbound ------------------------------------------------------
inline void meshOnEspNow(const esp_now_recv_info* info, const uint8_t* data, int len) {
    char json[len + 1];
    memcpy(json, data, len);
    json[len] = '\0';

    JsonDocument doc;
    if (deserializeJson(doc, json)) return;

    const String action = doc["action"] | "";
    const String nodeMac = doc["mac"] | "";

    if (action == "DISCOVER") {
        // Tell the cloud a node is asking to be claimed, and tell the node
        // which channel to sit on. Both halves matter: without the ACK the
        // subnode never learns the channel and the mesh never forms.
        char disco[160];
        snprintf(disco, sizeof(disco), "{\"mac\":\"%s\",\"role\":\"%s\"}",
                 nodeMac.c_str(), (doc["role"] | "sensor"));
        meshPublish(TOPIC_DISCOVERY, disco);

        char ack[160];
        snprintf(ack, sizeof(ack),
                 "{\"action\":\"DISCOVER_ACK\",\"mac\":\"%s\",\"channel\":%d}",
                 meshMac().c_str(), WiFi.channel());
        meshBroadcast(ack);
        Serial.println("Discovery from " + nodeMac + ", acked channel " + String(WiFi.channel()));
        return;
    }

    // Everything below is only accepted from our own mesh. Several homes can
    // share the same airspace, and ESP-NOW broadcasts reach all of them.
    const String incomingId = doc["mesh_id"] | "";
    if (meshId.length() == 0 || incomingId != meshId) return;

    if (action == "TELEMETRY" || action == "WF") {
        // Forwarded verbatim so the backend sees exactly what the node sent.
        if (meshPublishTelemetry(json)) {
            Serial.println(action == "WF" ? "Forwarded load signature"
                                          : "Forwarded subnode telemetry");
        }
    } else if (action == "TRIP_RELAY") {
        // A safety trip has already been actioned peer-to-peer by the subnodes
        // before this arrives. The gateway's job here is only to report it, and
        // to let the sketch cut its own main relay.
        Serial.println("Emergency trip reported by " + nodeMac);
        meshHandleGatewayCommand("TRIP_RELAY", doc);
        meshPublishTelemetry(json);
    }
}

// --- setup / loop ---------------------------------------------------------
inline void meshBegin() {
    meshLoadConfig();

    WiFiManager wm;
    wm.setConfigPortalTimeout(180);
    WiFiManagerParameter meshIdParam("mesh_id", "Mesh ID", meshId.c_str(), 40);
    WiFiManagerParameter meshKeyParam("mesh_key", "Mesh Key", meshKey.c_str(), 40);
    wm.addParameter(&meshIdParam);
    wm.addParameter(&meshKeyParam);

    if (!wm.autoConnect(WIFI_PORTAL_NAME)) {
        // Not fatal. Metering and the local safety cutoff must keep working
        // with no network at all - that independence is the point of the mesh.
        Serial.println("No Wi-Fi. Running offline; metering and safety still active.");
    } else {
        Serial.println("Wi-Fi connected, channel " + String(WiFi.channel()));
        if (strlen(meshIdParam.getValue()) > 0) {
            meshSaveConfig(meshIdParam.getValue(), meshKeyParam.getValue());
        }
    }

    // AP_STA, not STA: ESP-NOW needs the AP interface up to receive broadcasts
    // reliably while the station side is associated with the router.
    WiFi.mode(WIFI_AP_STA);

    if (esp_now_init() != ESP_OK) {
        Serial.println("ESP-NOW init failed - the mesh will not form");
    } else {
        esp_now_register_recv_cb(meshOnEspNow);
        esp_now_peer_info_t peer;
        memset(&peer, 0, sizeof(peer));
        memcpy(peer.peer_addr, BROADCAST_ADDR, 6);
        peer.channel = 0;      // follow whatever channel the station is on
        peer.encrypt = false;
        if (esp_now_add_peer(&peer) != ESP_OK) {
            Serial.println("Failed to register the broadcast peer");
        }
        Serial.println("ESP-NOW ready on channel " + String(WiFi.channel()));
    }

#ifdef MQTT_ROOT_CA
    meshTlsClient.setCACert(MQTT_ROOT_CA);
#else
    // No pinned certificate: the broker is not authenticated, so a network
    // attacker could impersonate it. Acceptable on a bench, not in a home -
    // set MQTT_ROOT_CA in secrets.h before this is deployed anywhere real.
    meshTlsClient.setInsecure();
#endif
    mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
    mqttClient.setCallback(meshMqttCallback);
    mqttClient.setBufferSize(512);   // waveform frames exceed the 256-byte default
}

inline void meshReconnect() {
    const unsigned long now = millis();
    if (mqttClient.connected() || now - lastMqttRetry < 5000) return;
    lastMqttRetry = now;

    const String clientId = "AetherGateway-" + meshMac();
    Serial.print("Connecting to MQTT broker... ");
    if (mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
        Serial.println("connected");
        mqttClient.subscribe(TOPIC_COMMAND);

        // Announce ourselves the same way a subnode does. Without this the
        // gateway only appears once its first telemetry arrives, and never at
        // all before it is paired - so the one node that has to be claimed
        // first was the one you could not see.
        char announce[160];
        snprintf(announce, sizeof(announce),
                 "{\"mac\":\"%s\",\"role\":\"gateway\"}", meshMac().c_str());
        mqttClient.publish(TOPIC_DISCOVERY, announce);
    } else {
        Serial.println("failed, rc=" + String(mqttClient.state()));
    }
}

inline void meshLoop() {
    if (WiFi.status() == WL_CONNECTED) {
        meshReconnect();
        mqttClient.loop();
    }

    const unsigned long now = millis();
    if (now - lastHeartbeat > 5000 && meshId.length()) {
        lastHeartbeat = now;
        char beat[160];
        snprintf(beat, sizeof(beat),
                 "{\"action\":\"HEARTBEAT\",\"mac\":\"%s\",\"mesh_id\":\"%s\",\"channel\":%d}",
                 meshMac().c_str(), meshId.c_str(), WiFi.channel());
        meshBroadcast(beat);
    }
}

#endif  // AETHER_MESH_H
