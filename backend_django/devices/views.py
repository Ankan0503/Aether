import json
from django.db.models import Q
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.contrib.auth.models import User
from .models import Device
from anomaly.ml.socket_state import relay_channel_for_socket

def get_user_from_jwt_or_fallback(request):
    from accounts.views import get_user_from_jwt
    return get_user_from_jwt(request)

@require_http_methods(["GET"])
def get_user_devices(request):
    user = get_user_from_jwt_or_fallback(request)
    if not user:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    from django.utils import timezone
    devices = Device.objects.filter(owner=user, is_paired=True)
    device_list = []
    
    print(" --- DATABASE DEVICE DEBUG ---")
    print(f"Checking devices for User: {user.username}")
    for d in devices:
        print(f"Device MAC: {d.mac_address} | Role: {d.role} | Name: {d.name} | Appliances Count: {d.appliances.count()}")
        is_active = (timezone.now() - d.last_seen).total_seconds() < 15
        appliances_list = []
        for app in d.appliances.all().order_by('channel'):
            appliances_list.append({
                "id": app.id,
                "channel": app.channel,
                "name": app.name,
                "type": app.type,
                "active": app.active,
                "nominal_consumption": app.nominal_consumption
            })
        device_list.append({
            "id": d.id,
            "mac_address": d.mac_address,
            "name": d.name,
            "role": d.role,
            "last_seen": d.last_seen.isoformat(),
            "is_active": is_active,
            "appliances": appliances_list,
        })
    return JsonResponse({"devices": device_list})

@require_http_methods(["GET"])
def get_unlinked_devices(request):
    user = get_user_from_jwt_or_fallback(request)
    if not user:
        return JsonResponse({"error": "Unauthorized"}, status=401)
    from django.utils import timezone
    from datetime import timedelta
    
    # Only return unlinked devices seen in the last 15 seconds
    cutoff = timezone.now() - timedelta(seconds=15)
    devices = Device.objects.filter(is_paired=False, owner=None, last_seen__gte=cutoff)
    device_list = []
    for d in devices:
        device_list.append({
            "id": d.id,
            "mac_address": d.mac_address,
            "name": d.name,
            "role": d.role,
            "last_seen": d.last_seen.isoformat(),
            "is_active": True,
        })
    return JsonResponse({"devices": device_list})

@csrf_exempt
@require_http_methods(["POST"])
def register_device(request):
    try:
        user = get_user_from_jwt_or_fallback(request)
        if not user:
            return JsonResponse({"error": "Unauthorized"}, status=401)
        data = json.loads(request.body)
        mac_address = data.get("mac_address")
        name = data.get("name", "Unnamed Device")
        role = data.get("role", "sensor")

        if not mac_address:
            return JsonResponse({"error": "MAC address is required."}, status=400)

        # Get or create the device
        device, created = Device.objects.get_or_create(
            mac_address=mac_address,
            defaults={"name": name, "role": role}
        )

        device.owner = user
        device.is_paired = True
        device.name = name
        device.role = role
        device.save()

        # Auto-create 3 appliance sockets for relay nodes.
        if device.role == 'relay':
            from .models import Appliance
            default_names = ["Socket 1", "Socket 2", "Socket 3"]
            default_types = ["Appliance", "Appliance", "Appliance"]
            default_consumptions = [100, 100, 100]
            for ch in range(1, 4):
                Appliance.objects.get_or_create(
                    device=device,
                    channel=ch,
                    defaults={
                        "name": default_names[ch - 1],
                        "type": default_types[ch - 1],
                        "nominal_consumption": default_consumptions[ch - 1]
                    }
                )

        # Publish pairing message over MQTT to tell the Gateway to pair the device locally
        from paho.mqtt import publish as mqtt_publish
        from accounts.views import get_or_create_user_profile
        import os
        
        profile = get_or_create_user_profile(user)

        MQTT_BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
        MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
        MQTT_USER = os.getenv("MQTT_USER")
        MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")

        pairing_payload = {
            "mac": mac_address,
            "mesh_id": profile.mesh_id,
            "mesh_key": profile.mesh_key,
            "name": name,
            "role": role,
            "action": "PAIR"
        }
        
        auth = None
        if MQTT_USER and MQTT_PASSWORD:
            auth = {'username': MQTT_USER, 'password': MQTT_PASSWORD}

        tls = None
        if MQTT_PORT == 8883:
            import ssl
            tls = {'ca_certs': None, 'cert_reqs': ssl.CERT_NONE, 'tls_version': ssl.PROTOCOL_TLS}

        mqtt_publish.single(
            "aether/pairing/command",
            payload=json.dumps(pairing_payload),
            hostname=MQTT_BROKER,
            port=MQTT_PORT,
            auth=auth,
            tls=tls
        )
        print(f"Published pairing command for {mac_address} to MQTT")

        return JsonResponse({
            "message": "Device registered and pairing command sent.",
            "mac_address": device.mac_address,
            "name": device.name,
            "role": device.role
        })

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

@csrf_exempt
@require_http_methods(["POST"])
def unregister_device(request):
    try:
        user = get_user_from_jwt_or_fallback(request)
        if not user:
            return JsonResponse({"error": "Unauthorized"}, status=401)
        data = json.loads(request.body)
        mac_address = data.get("mac_address")

        if not mac_address:
            return JsonResponse({"error": "MAC address is required."}, status=400)

        try:
            device = Device.objects.get(mac_address=mac_address, owner=user)
        except Device.DoesNotExist:
            return JsonResponse({"error": "Device not found or not owned by you."}, status=404)

        # Send UNPAIR command via MQTT & delete from DB
        from paho.mqtt import publish as mqtt_publish
        import os

        MQTT_BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
        MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
        MQTT_USER = os.getenv("MQTT_USER")
        MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")

        auth = None
        if MQTT_USER and MQTT_PASSWORD:
            auth = {'username': MQTT_USER, 'password': MQTT_PASSWORD}

        tls = None
        if MQTT_PORT == 8883:
            import ssl
            tls = {'ca_certs': None, 'cert_reqs': ssl.CERT_NONE, 'tls_version': ssl.PROTOCOL_TLS}

        is_gateway = (device.role == 'gateway')

        if is_gateway:
            # Cascading unpair/delete: unpair all devices in the mesh
            devices_to_delete = Device.objects.filter(owner=user)
            print("--- GATEWAY DELETION TRIGGERED ---")
            print("User:", user.username)
            print("Devices slated for deletion:", [f"{d.name} ({d.mac_address}) [Role: {d.role}]" for d in devices_to_delete])
            
            # Order the MQTT unpair messages: subnodes first, then gateway last
            # We add a 1-second sleep in between so the gateway has time to receive 
            # and forward the unpair packets to the subnodes before it wipes its own config and reboots.
            subnodes = [d for d in devices_to_delete if d.role != 'gateway']
            gateways = [d for d in devices_to_delete if d.role == 'gateway']

            for d in subnodes:
                try:
                    unpairing_payload = {
                        "mac": d.mac_address,
                        "action": "UNPAIR"
                    }
                    mqtt_publish.single(
                        "aether/pairing/command",
                        payload=json.dumps(unpairing_payload),
                        hostname=MQTT_BROKER,
                        port=MQTT_PORT,
                        auth=auth,
                        tls=tls
                    )
                    print(f"Published unpairing command for subnode {d.mac_address} to MQTT")
                except Exception as mqtt_err:
                    print(f"Failed to publish MQTT unpair for subnode {d.mac_address}: {mqtt_err}")

            if subnodes:
                import time
                print("Sleeping for 1 second to allow Gateway to forward unpair commands to subnodes...")
                time.sleep(1.0)

            for d in gateways:
                try:
                    unpairing_payload = {
                        "mac": d.mac_address,
                        "action": "UNPAIR"
                    }
                    mqtt_publish.single(
                        "aether/pairing/command",
                        payload=json.dumps(unpairing_payload),
                        hostname=MQTT_BROKER,
                        port=MQTT_PORT,
                        auth=auth,
                        tls=tls
                    )
                    print(f"Published unpairing command for gateway {d.mac_address} to MQTT")
                except Exception as mqtt_err:
                    print(f"Failed to publish MQTT unpair for gateway {d.mac_address}: {mqtt_err}")
            
            # Delete associated telemetry readings manually first
            from telemetry.models import TelemetryReading
            device_ids_str = [str(d.id) for d in devices_to_delete]
            device_macs = [d.mac_address for d in devices_to_delete]
            TelemetryReading.objects.filter(
                Q(device_ref__in=devices_to_delete) | Q(device_id__in=device_ids_str + device_macs)
            ).delete()

            # Delete all user's devices from the database
            del_res = devices_to_delete.delete()
            print("Django database delete response:", del_res)
            print("Remaining devices in database:", [f"{d.name} ({d.mac_address})" for d in Device.objects.all()])
            print("---------------------------------")
        else:
            # Single unpair/delete
            try:
                unpairing_payload = {
                    "mac": mac_address,
                    "action": "UNPAIR"
                }
                mqtt_publish.single(
                    "aether/pairing/command",
                    payload=json.dumps(unpairing_payload),
                    hostname=MQTT_BROKER,
                    port=MQTT_PORT,
                    auth=auth,
                    tls=tls
                )
                print(f"Published unpairing command for {mac_address} to MQTT")
            except Exception as mqtt_err:
                print(f"Failed to publish MQTT unpair for {mac_address}: {mqtt_err}")
            
            # Delete associated telemetry readings manually first
            from telemetry.models import TelemetryReading
            TelemetryReading.objects.filter(
                Q(device_ref=device) | Q(device_id__in=[str(device.id), device.mac_address])
            ).delete()

            # Delete specific device from the database
            device.delete()

        return JsonResponse({"message": "Device unregistered successfully."})

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

@csrf_exempt
@require_http_methods(["POST"])
def reset_safety(request):
    try:
        user = get_user_from_jwt_or_fallback(request)
        if not user:
            return JsonResponse({"error": "Unauthorized"}, status=401)
        data = json.loads(request.body)
        mac_address = data.get("mac_address")

        if not mac_address:
            return JsonResponse({"error": "MAC address is required."}, status=400)

        try:
            device = Device.objects.get(mac_address=mac_address, owner=user, role__in=['gateway', 'relay'])
        except Device.DoesNotExist:
            return JsonResponse({"error": "Gateway/Relay device not found or not owned by you."}, status=404)

        # Check safety states
        from accounts.views import get_or_create_user_profile
        profile = get_or_create_user_profile(user)
        
        from django.utils import timezone
        from datetime import timedelta
        from telemetry.models import TelemetryReading
        from django.db.models import Q

        # Check if currently there is an active emergency in the very latest telemetry.
        user_devices = Device.objects.filter(owner=user)
        legacy_ids = [str(d.id) for d in user_devices]
        mac_ids = [d.mac_address for d in user_devices]
        latest_reading = TelemetryReading.objects.filter(
            Q(device_ref__in=user_devices) | Q(device_id__in=legacy_ids + mac_ids)
        ).order_by('-timestamp').first()
        if latest_reading:
            if latest_reading.gas > 3500 or latest_reading.flame == 0:
                return JsonResponse({"error": "Cannot restore power. Sensors are currently reporting unsafe conditions!"}, status=400)

        if profile.is_security_locked:
            # Check last 30 seconds of readings
            cutoff = timezone.now() - timedelta(seconds=30)
            recent_readings = TelemetryReading.objects.filter(
                Q(device_ref__in=user_devices) | Q(device_id__in=legacy_ids + mac_ids),
                timestamp__gte=cutoff,
            )
            
            if not recent_readings.exists():
                return JsonResponse({"error": "No recent telemetry data received. Ensure sensors are online before resetting."}, status=400)
                
            unsafe_readings = recent_readings.filter(Q(gas__gt=3500) | Q(flame=0))
            if unsafe_readings.exists():
                # Get the duration since the last unsafe reading to calculate cooldown remaining
                last_unsafe = unsafe_readings.order_by('-timestamp').first()
                elapsed = (timezone.now() - last_unsafe.timestamp).total_seconds()
                remaining = max(1, int(30 - elapsed))
                return JsonResponse({
                    "error": f"Safety buffer active. Please wait {remaining} more seconds for the environment to clear."
                }, status=400)

        # Send RESET_SAFETY command via MQTT
        from paho.mqtt import publish as mqtt_publish
        import os

        MQTT_BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
        MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
        MQTT_USER = os.getenv("MQTT_USER")
        MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")

        auth = None
        if MQTT_USER and MQTT_PASSWORD:
            auth = {'username': MQTT_USER, 'password': MQTT_PASSWORD}

        tls = None
        if MQTT_PORT == 8883:
            import ssl
            tls = {'ca_certs': None, 'cert_reqs': ssl.CERT_NONE, 'tls_version': ssl.PROTOCOL_TLS}

        reset_payload = {
            "mac": mac_address,
            "action": "RESET_SAFETY"
        }
        
        try:
            mqtt_publish.single(
                "aether/pairing/command",
                payload=json.dumps(reset_payload),
                hostname=MQTT_BROKER,
                port=MQTT_PORT,
                auth=auth,
                tls=tls
            )
            print(f"Published RESET_SAFETY command for gateway {mac_address} to MQTT")
        except Exception as mqtt_err:
            print(f"Failed to publish MQTT reset safety command: {mqtt_err}")
            return JsonResponse({"error": "Failed to contact MQTT broker"}, status=500)

        return JsonResponse({"message": "System safety reset command successfully sent to Gateway."})

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

@csrf_exempt
@require_http_methods(["POST"])
def toggle_security_lock(request):
    try:
        user = get_user_from_jwt_or_fallback(request)
        if not user:
            return JsonResponse({"error": "Unauthorized"}, status=401)
        data = json.loads(request.body)
        is_locked = data.get("is_locked", True)
        
        from accounts.views import get_or_create_user_profile
        profile = get_or_create_user_profile(user)
        profile.is_security_locked = is_locked
        profile.save()
        
        # Publish SET_LOCK command via MQTT to gateway
        from paho.mqtt import publish as mqtt_publish
        import os
        
        MQTT_BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
        MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
        MQTT_USER = os.getenv("MQTT_USER")
        MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")
        
        auth = None
        if MQTT_USER and MQTT_PASSWORD:
            auth = {'username': MQTT_USER, 'password': MQTT_PASSWORD}
            
        tls = None
        if MQTT_PORT == 8883:
            import ssl
            tls = {'ca_certs': None, 'cert_reqs': ssl.CERT_NONE, 'tls_version': ssl.PROTOCOL_TLS}
            
        lock_payload = {
            "action": "SET_LOCK",
            "is_locked": is_locked
        }
        
        try:
            mqtt_publish.single(
                "aether/pairing/command",
                payload=json.dumps(lock_payload),
                hostname=MQTT_BROKER,
                port=MQTT_PORT,
                auth=auth,
                tls=tls
            )
            print(f"Published SET_LOCK: {is_locked} to MQTT")
        except Exception as mqtt_err:
            print(f"Failed to publish MQTT lock command: {mqtt_err}")
            
        return JsonResponse({
            "message": f"Mesh security state successfully set to {'LOCKED' if is_locked else 'UNLOCKED'}.",
            "is_security_locked": is_locked
        })
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

@csrf_exempt
@require_http_methods(["POST"])
def toggle_appliance(request):
    try:
        user = get_user_from_jwt_or_fallback(request)
        if not user:
            return JsonResponse({"error": "Unauthorized"}, status=401)
        data = json.loads(request.body)
        appliance_id = data.get("appliance_id")
        hardcoded_id = data.get("hardcoded_id")
        active = data.get("active")

        if appliance_id is None and hardcoded_id is None:
            return JsonResponse({"error": "appliance_id or hardcoded_id is required."}, status=400)
        if active is None:
            return JsonResponse({"error": "active state is required."}, status=400)

        from .models import Appliance
        appliance = None
        if appliance_id:
            try:
                appliance = Appliance.objects.get(id=appliance_id, device__owner=user)
            except Appliance.DoesNotExist:
                return JsonResponse({"error": "Appliance not found or not owned by you."}, status=404)
        else:
            # Map hardcoded mock card IDs to sockets 1-3 of the user's registered relay device.
            relay_device = Device.objects.filter(owner=user, role='relay', is_paired=True).first()
            if not relay_device:
                # Fallback to any paired device if no explicit relay is registered
                relay_device = Device.objects.filter(owner=user, is_paired=True).first()
            
            if not relay_device:
                return JsonResponse({"error": "No paired relay board found to route the command."}, status=404)

            channel_map = {
                'lr-lights': 1,
                'kitchen-app': 2,
                'hvac': 3,
                'tv-unit': 3
            }
            channel = channel_map.get(hardcoded_id, 1)
            
            # Find or auto-create the appliance channel for this device
            appliance, created = Appliance.objects.get_or_create(
                device=relay_device,
                channel=channel,
                defaults={
                    "name": f"Channel {channel} (Mock Fallback)",
                    "type": "Appliance"
                }
            )

        appliance.active = active
        appliance.save()

        # Send control command to relay node via MQTT
        from paho.mqtt import publish as mqtt_publish
        import os

        MQTT_BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
        MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
        MQTT_USER = os.getenv("MQTT_USER")
        MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")

        auth = None
        if MQTT_USER and MQTT_PASSWORD:
            auth = {'username': MQTT_USER, 'password': MQTT_PASSWORD}

        tls = None
        if MQTT_PORT == 8883:
            import ssl
            tls = {'ca_certs': None, 'cert_reqs': ssl.CERT_NONE, 'tls_version': ssl.PROTOCOL_TLS}

        control_payload = {
            "mac": appliance.device.mac_address,
            "action": "CONTROL_RELAY",
            "channel": relay_channel_for_socket(appliance.channel),
            "state": active
        }

        try:
            if MQTT_BROKER:
                mqtt_publish.single(
                    "aether/pairing/command",
                    payload=json.dumps(control_payload),
                    hostname=MQTT_BROKER,
                    port=MQTT_PORT,
                    auth=auth,
                    tls=tls
                )
                print(f"Published CONTROL_RELAY to MQTT: {control_payload}")
            else:
                print("MQTT_BROKER not configured; skipping MQTT publish.")
        except Exception as mqtt_err:
            print(f"Failed to publish MQTT control relay command: {mqtt_err}")
            return JsonResponse({"error": "Failed to contact MQTT broker"}, status=500)

        return JsonResponse({
            "message": "Appliance state toggled and relay command sent.",
            "appliance_id": appliance.id,
            "active": appliance.active
        })

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

@csrf_exempt
@require_http_methods(["POST"])
def update_appliance(request):
    try:
        user = get_user_from_jwt_or_fallback(request)
        if not user:
            return JsonResponse({"error": "Unauthorized"}, status=401)
        data = json.loads(request.body)
        appliance_id = data.get("appliance_id")
        name = data.get("name")
        type_ = data.get("type")
        nominal_consumption = data.get("nominal_consumption")

        if appliance_id is None:
            return JsonResponse({"error": "appliance_id is required."}, status=400)

        from .models import Appliance
        try:
            appliance = Appliance.objects.get(id=appliance_id, device__owner=user)
        except Appliance.DoesNotExist:
            return JsonResponse({"error": "Appliance not found or not owned by you."}, status=404)

        if name is not None:
            appliance.name = name
        if type_ is not None:
            appliance.type = type_
        if nominal_consumption is not None:
            appliance.nominal_consumption = nominal_consumption

        appliance.save()

        return JsonResponse({
            "message": "Appliance configuration updated.",
            "appliance_id": appliance.id,
            "name": appliance.name,
            "type": appliance.type,
            "nominal_consumption": appliance.nominal_consumption
        })

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)
