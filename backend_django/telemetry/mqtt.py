import os
import json
import threading
import paho.mqtt.client as mqtt

MQTT_BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "inventx/telemetry")
MQTT_USER = os.getenv("MQTT_USER")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")

def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        print("Connected to HiveMQ MQTT Broker successfully! ")
        client.subscribe("aether/#")
    else:
        print(f"Failed to connect, return code {rc}")

def on_message(client, userdata, msg):
    from devices.models import Device
    from django.db import close_old_connections
    from telemetry.ingestion import ingest_telemetry_payload
    try:
        close_old_connections()
        payload = msg.payload.decode()
        data = json.loads(payload)
        
        if msg.topic == "aether/discovery":
            mac = data.get("mac")
            role = data.get("role", "sensor")
            if mac:
                # Add or update unlinked device
                device, created = Device.objects.get_or_create(
                    mac_address=mac,
                    defaults={
                        "name": f"Unassigned {role.capitalize()}",
                        "role": role,
                        "is_paired": False
                    }
                )
                device.save() # Auto-updates last_seen
                print(f"Discovered unlinked device: {mac} (Role: {role})")
                
        elif msg.topic == "aether/telemetry":
            # Load signatures share the telemetry topic but are a different
            # shape - a waveform rather than a set of scalars - so they are
            # routed by their action rather than by topic. Keeping them on one
            # topic means the gateway relays everything the same way and no
            # subscription has to change.
            from telemetry.waveform import ingest_waveform_payload, is_waveform_payload

            if is_waveform_payload(data):
                signature = ingest_waveform_payload(data)
                if signature is None:
                    print(f"Load signature from {data.get('mac')} unchanged - not stored")
                else:
                    print(
                        f"Load signature from {signature.device_id} socket "
                        f"{signature.socket_id}: {signature.label} "
                        f"({signature.confidence:.0%}, crest {signature.crest:.2f})"
                    )
                return

            reading, prediction = ingest_telemetry_payload(data)
            print(
                f"Saved Telemetry from {reading.device_id}: current={reading.current}A "
                f"power={reading.power}W state={prediction.predicted_state if prediction else 'N/A'}"
            )
            
    except Exception as e:
        print(f"Error parsing MQTT message on {msg.topic}: {e}")

def start_mqtt_listener():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message

    # HiveMQ Cloud (port 8883) requires secure TLS
    if MQTT_PORT == 8883:
        client.tls_set()

    # Authenticate with credentials if provided
    if MQTT_USER and MQTT_PASSWORD:
        client.username_pw_set(MQTT_USER, MQTT_PASSWORD)

    try:
        client.connect(MQTT_BROKER, MQTT_PORT, 60)
        # Run loop in a background thread so it doesn't block Django
        mqtt_thread = threading.Thread(target=client.loop_forever, daemon=True)
        mqtt_thread.start()
        print("Started background MQTT listener thread...")
    except Exception as e:
        print(f"Failed to start MQTT Client: {e}")

