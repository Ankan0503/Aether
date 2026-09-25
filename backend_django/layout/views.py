import json

from django.db import transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from accounts.views import get_user_from_jwt
from devices.models import Device

from .models import Room


MAX_ROOMS_PER_LAYOUT = 80
MAX_GRID_UNITS = 48
MAX_DOORS_PER_ROOM = 8
VALID_DOOR_WALLS = {'top', 'right', 'bottom', 'left'}


def _serialize_device(device):
    from django.utils import timezone

    is_active = (timezone.now() - device.last_seen).total_seconds() < 15 if device.last_seen else False
    return {
        'mac_address': device.mac_address,
        'device_alias': device.name,
        'device_type': 'GATEWAY' if device.role == 'gateway' else 'SUBNODE',
        'role': device.role,
        'is_active': is_active,
        'last_seen': device.last_seen.isoformat() if device.last_seen else None,
    }


def _serialize_room(room):
    mapped_device = room.devices.order_by('role', 'name').first()
    return {
        'id': str(room.id),
        'name': room.name,
        'floor': room.floor,
        'grid_x': room.grid_x,
        'grid_y': room.grid_y,
        'grid_w': room.grid_w,
        'grid_h': room.grid_h,
        'doors': room.doors or [],
        'mapped_device_mac': mapped_device.mac_address if mapped_device else None,
        'devices': [_serialize_device(device) for device in room.devices.all().order_by('role', 'name')],
        'created_at': room.created_at.isoformat(),
    }


def _serialize_unmapped_device(device):
    payload = _serialize_device(device)
    payload['room_id'] = str(device.room_id) if device.room_id else None
    return payload


def _clamp_int(value, default, minimum=0, maximum=MAX_GRID_UNITS):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def _parse_room_payload(raw_room):
    if not isinstance(raw_room, dict):
        raise ValueError('Each room must be an object.')

    name = str(raw_room.get('name') or 'Untitled Room').strip()[:100]
    if not name:
        name = 'Untitled Room'

    doors = raw_room.get('doors', [])
    if doors is None:
        doors = []
    if not isinstance(doors, list):
        raise ValueError('`doors` must be an array.')
    if len(doors) > MAX_DOORS_PER_ROOM:
        raise ValueError(f'Each room may contain at most {MAX_DOORS_PER_ROOM} doors.')

    return {
        'id': raw_room.get('id'),
        'name': name,
        'floor': _clamp_int(raw_room.get('floor'), 0, minimum=0, maximum=20),
        'grid_x': _clamp_int(raw_room.get('grid_x'), 0),
        'grid_y': _clamp_int(raw_room.get('grid_y'), 0),
        'grid_w': _clamp_int(raw_room.get('grid_w'), 4, minimum=1),
        'grid_h': _clamp_int(raw_room.get('grid_h'), 4, minimum=1),
        'doors': [_parse_door_payload(door, index) for index, door in enumerate(doors)],
        'mapped_device_mac': raw_room.get('mapped_device_mac'),
    }


def _parse_float(value, default, minimum, maximum):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))


def _parse_door_payload(raw_door, index):
    if not isinstance(raw_door, dict):
        raise ValueError('Each door must be an object.')

    wall = raw_door.get('wall', 'bottom')
    if wall not in VALID_DOOR_WALLS:
        wall = 'bottom'

    return {
        'id': str(raw_door.get('id') or f'door-{index + 1}')[:80],
        'wall': wall,
        'offset': _parse_float(raw_door.get('offset'), 0.5, 0.08, 0.92),
        'width': _parse_float(raw_door.get('width'), 0.28, 0.12, 0.75),
    }


@csrf_exempt
@require_http_methods(['GET', 'PUT', 'POST'])
def layout_detail(request):
    user = get_user_from_jwt(request)
    if not user:
        return JsonResponse({'error': 'Unauthorized'}, status=401)

    if request.method == 'GET':
        rooms = Room.objects.filter(owner=user).prefetch_related('devices')
        devices = Device.objects.filter(owner=user, is_paired=True, room__isnull=True).order_by('role', 'name')
        if request.GET.get('include_devices') not in ('1', 'true', 'True'):
            return JsonResponse([_serialize_room(room) for room in rooms], safe=False)
        return JsonResponse({
            'rooms': [_serialize_room(room) for room in rooms],
            'unmapped_devices': [_serialize_unmapped_device(device) for device in devices],
        })

    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
        rooms_payload = payload.get('rooms', [])
        if not isinstance(rooms_payload, list):
            raise ValueError('`rooms` must be an array.')
        if len(rooms_payload) > MAX_ROOMS_PER_LAYOUT:
            raise ValueError(f'Layouts may contain at most {MAX_ROOMS_PER_LAYOUT} rooms.')

        parsed_rooms = [_parse_room_payload(room) for room in rooms_payload]
        room_ids_to_keep = []

        with transaction.atomic():
            Device.objects.filter(owner=user).update(room=None)

            for room_data in parsed_rooms:
                room_id = room_data.pop('id', None)
                mapped_device_mac = room_data.pop('mapped_device_mac', None)

                if room_id:
                    room, _ = Room.objects.update_or_create(
                        id=room_id,
                        owner=user,
                        defaults=room_data,
                    )
                else:
                    room = Room.objects.create(owner=user, **room_data)

                room_ids_to_keep.append(room.id)

                if mapped_device_mac:
                    Device.objects.filter(
                        owner=user,
                        is_paired=True,
                        mac_address=mapped_device_mac,
                    ).update(room=room)

            Room.objects.filter(owner=user).exclude(id__in=room_ids_to_keep).delete()

        rooms = Room.objects.filter(owner=user).prefetch_related('devices')
        devices = Device.objects.filter(owner=user, is_paired=True, room__isnull=True).order_by('role', 'name')
        return JsonResponse({
            'rooms': [_serialize_room(room) for room in rooms],
            'unmapped_devices': [_serialize_unmapped_device(device) for device in devices],
        })
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Request body must be valid JSON.'}, status=400)
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)
