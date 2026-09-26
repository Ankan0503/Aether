#ifndef AETHER_SUBNODE_MESH_H
#define AETHER_SUBNODE_MESH_H

// ============================================================================
// Subnode networking - ESP-NOW only, no Wi-Fi association
// ============================================================================
// A subnode never joins the router and never speaks MQTT. It only talks ESP-NOW
// to the gateway, which relays for it. That keeps it cheap, fast to boot, and -
// the part that matters - still working when the internet is down.
//
// Two modes:
//
//   UNPAIRED   broadcasts DISCOVER every few seconds and waits. The gateway
//              answers DISCOVER_ACK with its Wi-Fi channel, and forwards the
//              discovery to the cloud so the node appears in the dashboard as
//              unclaimed. The user pairs it there, which sends PAIR back down.
//
//   PAIRED     credentials in NVS. Publishes telemetry and load signatures,
//              accepts relay commands, and ignores anything whose mesh_id is
//              not its own - several homes can share the same airspace.
//
// Channel tracking is the subtle part. ESP-NOW peers must be on the same Wi-Fi
// channel, and the router can move the gateway at any time. The gateway
// heartbeats its channel every 5 seconds; a paired node follows it and saves
// the new value. Without that the mesh goes silently deaf after a channel
// change - still powered, still paired, nothing getting through.
//
// The offline safety path does not pass through here at all: a sensor node
// broadcasts TRIP_RELAY directly to the relay node, peer to peer, so gas and
// fire cutoff works with the gateway unplugged.
// ============================================================================

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <ArduinoJson.h>
#include <Preferences.h>

static Preferences subPrefs;

static String meshId = "";
static String meshKey = "";
static String deviceName = "";
static int meshChannel = 1;
static bool isPaired = false;
static bool gatewaySeen = false;
static unsigned long lastGatewayContact = 0;
static unsigned long lastDiscover = 0;

static const uint8_t BROADCAST_ADDR[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// Implemented by the sketch - relay control lives with the pin map, not here.
void meshHandleCommand(const String& action, JsonDocument& doc);

inline String meshMac() { return WiFi.macAddress(); }
inline bool meshIsPaired() { return isPaired; }
inline const String& meshCurrentId() { return meshId; }
inline int meshCurrentChannel() { return meshChannel; }
inline bool meshGatewayAlive() {
    return gatewaySeen && (millis() - lastGatewayContact < 30000);
}

// doc["mesh_id"] | "" is a const char*, and const char* == String does not
// compile. Converting once here keeps the call sites readable and avoids three
// separate casts that would all have to stay in step.
inline String meshIdOf(JsonDocument& doc) {
    return String(doc["mesh_id"] | "");
}

inline void meshBroadcast(const char* payload) {
    esp_now_send(BROADCAST_ADDR, (const uint8_t*)payload, strlen(payload));
}

// --- credentials ----------------------------------------------------------
inline void meshSavePairing(const String& id, const String& key,
                            const String& name, int channel) {
    subPrefs.begin("sub-settings", false);
    subPrefs.putString("mesh_id", id);
    subPrefs.putString("mesh_key", key);
    subPrefs.putString("device_name", name);
    subPrefs.putInt("wifi_channel", channel);
    subPrefs.end();

    meshId = id;
    meshKey = key;
    deviceName = name;
    meshChannel = channel;
    isPaired = true;
    lastGatewayContact = millis();
    Serial.println("Paired. Mesh " + id + ", name '" + name + "', channel " + String(channel));
}

inline void meshSaveChannel(int channel) {
    subPrefs.begin("sub-settings", false);
    subPrefs.putInt("wifi_channel", channel);
    subPrefs.end();
    meshChannel = channel;
    esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
}

inline void meshLoadPairing() {
    subPrefs.begin("sub-settings", true);
    meshId = subPrefs.getString("mesh_id", "");
    meshKey = subPrefs.getString("mesh_key", "");
    deviceName = subPrefs.getString("device_name", "");
    meshChannel = subPrefs.getInt("wifi_channel", 1);
    subPrefs.end();

    isPaired = meshId.length() > 0 && meshKey.length() > 0;
    if (isPaired) {
        esp_wifi_set_channel(meshChannel, WIFI_SECOND_CHAN_NONE);
        lastGatewayContact = millis();
        Serial.println("Loaded pairing: " + meshId + " on channel " + String(meshChannel));
    } else {
        Serial.println("Not paired. Broadcasting discovery...");
    }
}

inline void meshUnpair() {
    subPrefs.begin("sub-settings", false);
    subPrefs.clear();
    subPrefs.end();
    meshId = "";
    meshKey = "";
    deviceName = "";
    meshChannel = 1;
    isPaired = false;
    gatewaySeen = false;
    esp_wifi_set_channel(meshChannel, WIFI_SECOND_CHAN_NONE);
    Serial.println("Unpaired. Back to discovery mode.");
}

// --- inbound --------------------------------------------------------------
inline void meshOnEspNow(const esp_now_recv_info* info, const uint8_t* data, int len) {
    char json[len + 1];
    memcpy(json, data, len);
    json[len] = '\0';

    JsonDocument doc;
    if (deserializeJson(doc, json)) return;

    const String action = doc["action"] | "";

    if (action == "DISCOVER_ACK") {
        // Lock onto the gateway's channel even while unpaired - the PAIR
        // command has to arrive on that channel for pairing to complete.
        const int channel = doc["channel"] | 1;
        meshChannel = channel;
        esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
        gatewaySeen = true;
        lastGatewayContact = millis();
        Serial.println("Gateway found on channel " + String(channel));
        return;
    }

    if (action == "HEARTBEAT") {
        if (isPaired && meshIdOf(doc) == meshId) {
            lastGatewayContact = millis();
            gatewaySeen = true;
            const int channel = doc["channel"] | meshChannel;
            if (channel != meshChannel) {
                Serial.println("Gateway moved to channel " + String(channel) + ", following");
                meshSaveChannel(channel);
            }
        }
        return;
    }

    // Everything else is addressed to a specific node.
    const String targetMac = doc["mac"] | "";
    if (!targetMac.equalsIgnoreCase(meshMac())) {
        // Not for us - but a safety trip from a peer in the same mesh is meant
        // for everyone, and must act without the gateway's involvement.
        if (action == "TRIP_RELAY" && isPaired && meshIdOf(doc) == meshId) {
            meshHandleCommand(action, doc);
        }
        return;
    }

    if (action == "PAIR") {
        meshSavePairing(doc["mesh_id"] | "", doc["mesh_key"] | "",
                        doc["name"] | "Room Node", meshChannel);
        return;
    }
    if (action == "UNPAIR") {
        meshUnpair();
        return;
    }

    // Remaining commands require us to be paired into the sending mesh.
    if (!isPaired || meshIdOf(doc) != meshId) return;
    lastGatewayContact = millis();
    meshHandleCommand(action, doc);
}

// --- setup / loop ---------------------------------------------------------
inline void meshBegin(const char* role) {
    // Station mode without connecting: ESP-NOW needs the radio up, but a
    // subnode has no reason to hold a router association.
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();

    if (esp_now_init() != ESP_OK) {
        Serial.println("ESP-NOW init failed - this node cannot reach the gateway");
        return;
    }
    esp_now_register_recv_cb(meshOnEspNow);

    esp_now_peer_info_t peer;
    memset(&peer, 0, sizeof(peer));
    memcpy(peer.peer_addr, BROADCAST_ADDR, 6);
    peer.channel = 0;
    peer.encrypt = false;
    if (esp_now_add_peer(&peer) != ESP_OK) {
        Serial.println("Failed to register the broadcast peer");
    }

    meshLoadPairing();
    Serial.println("MAC " + meshMac() + ", role " + String(role));
}

inline void meshLoop(const char* role) {
    // Paired and hearing the gateway: nothing to do.
    if (isPaired && meshGatewayAlive()) return;

    // Paired but silent for 30s means the gateway is no longer where we left
    // it - it restarted onto a different channel, or the router moved and it
    // followed. ESP-NOW only reaches peers on the same channel, so the node
    // cannot receive the HEARTBEAT that would tell it where to go. It has to
    // go looking, and until this existed it never did: it knew the gateway was
    // gone, blinked an LED about it, and waited for a human with a BOOT button.
    //
    // Credentials are KEPT. We still know which mesh we belong to; we have only
    // lost where it is. Unpairing would throw away the one thing still valid
    // and force a needless round trip through the dashboard.
    const bool searching = isPaired && !meshGatewayAlive();

    // Unpaired: announce ourselves every 3 seconds, sweeping channels so we
    // find the gateway wherever the router put it. Without the sweep a node
    // only ever discovers a gateway that happens to share its default channel.
    if (millis() - lastDiscover > 3000) {
        lastDiscover = millis();

        // Sweep channels 1-13 only until the gateway is found for the first time.
        // Once gatewaySeen is true, lock to meshChannel so commands arrive instantly.
        if (!gatewaySeen) {
            static int sweep = 1;
            sweep = (sweep % 13) + 1;
            esp_wifi_set_channel(sweep, WIFI_SECOND_CHAN_NONE);
        } else {
            esp_wifi_set_channel(meshChannel, WIFI_SECOND_CHAN_NONE);
        }

        char payload[160];
        snprintf(payload, sizeof(payload),
                 "{\"action\":\"DISCOVER\",\"mac\":\"%s\",\"role\":\"%s\"}",
                 meshMac().c_str(), role);
        meshBroadcast(payload);

        // Say so on serial. An unpaired node is otherwise completely silent
        // after its boot banner scrolls away, so a node that is working looks
        // exactly like one that is dead - which is no help at all when the
        // mesh is not forming. Throttled to one line every few attempts.
        static uint8_t announced = 0;
        if ((announced++ % 4) == 0) {
            Serial.printf("DISCOVER sent on channel %d (%s)\n", WiFi.channel(),
                          searching ? "lost the gateway - sweeping to re-find it"
                          : gatewaySeen ? "gateway seen" : "sweeping");
        }
    }
}

#endif  // AETHER_SUBNODE_MESH_H
