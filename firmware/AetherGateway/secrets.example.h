// Copy this file to secrets.h and fill it in. secrets.h is gitignored.
//
//     cp secrets.example.h secrets.h
//
// Wi-Fi credentials are NOT here: WiFiManager collects them through its captive
// portal on first boot and stores them in NVS. On a fresh gateway, join the
// "Aether-Gateway-Setup" access point and the portal will ask for the network
// plus the Mesh ID and Mesh Key shown on your dashboard after signing up.

#ifndef AETHER_SECRETS_H
#define AETHER_SECRETS_H

// --- MQTT broker (HiveMQ Cloud or any TLS broker) --------------------------
#define MQTT_SERVER "your-cluster.s1.eu.hivemq.cloud"
#define MQTT_PORT   8883
#define MQTT_USER   "your-mqtt-username"
#define MQTT_PASS   "your-mqtt-password"

// Name of the setup access point the gateway raises when it has no Wi-Fi.
#define WIFI_PORTAL_NAME "Aether-Gateway-Setup"

// --- Broker certificate ----------------------------------------------------
// Without this the TLS connection is unauthenticated: encrypted, but with no
// proof the server is really your broker, so a network attacker could sit in
// the middle. Fine on a bench; set it before deploying anywhere real.
//
// Paste the broker's root CA in PEM form:
//
// #define MQTT_ROOT_CA R"EOF(
// -----BEGIN CERTIFICATE-----
// ...
// -----END CERTIFICATE-----
// )EOF"

#endif  // AETHER_SECRETS_H
