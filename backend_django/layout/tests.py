import json

from django.contrib.auth.models import User
from django.test import Client, TestCase

from accounts.jwt_utils import encode_jwt
from devices.models import Device

from .models import Room


class LayoutApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='layout-user', password='test-pass')
        self.token = encode_jwt({'user_id': self.user.id})
        self.client = Client(HTTP_AUTHORIZATION=f'Bearer {self.token}')

    def test_get_layout_contract_returns_room_array_by_default(self):
        room = Room.objects.create(owner=self.user, name='Kitchen', grid_x=0, grid_y=0, grid_w=4, grid_h=4)
        Device.objects.create(
            owner=self.user,
            is_paired=True,
            mac_address='7C:9E:BD:11:11:11',
            name='Main Kitchen Node',
            role='sensor',
            room=room,
        )

        response = self.client.get('/api/layout/')

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(body, list)
        self.assertEqual(body[0]['name'], 'Kitchen')
        self.assertEqual(body[0]['floor'], 0)
        self.assertEqual(body[0]['mapped_device_mac'], '7C:9E:BD:11:11:11')
        self.assertIn('doors', body[0])

    def test_save_layout_creates_rooms_and_maps_devices(self):
        Device.objects.create(
            owner=self.user,
            is_paired=True,
            mac_address='7C:9E:BD:22:22:22',
            name='Server Room Node',
            role='sensor',
        )

        response = self.client.put(
            '/api/layout/',
            data=json.dumps({
                'rooms': [
                    {
                        'name': 'Server Room',
                        'floor': 1,
                        'grid_x': 2,
                        'grid_y': 1,
                        'grid_w': 5,
                        'grid_h': 3,
                        'doors': [
                            {'id': 'main-door', 'wall': 'right', 'offset': 0.4, 'width': 0.25},
                            {'id': 'service-door', 'wall': 'bottom', 'offset': 0.7, 'width': 0.2},
                        ],
                        'mapped_device_mac': '7C:9E:BD:22:22:22',
                    }
                ]
            }),
            content_type='application/json',
        )

        body = response.json()
        device = Device.objects.get(mac_address='7C:9E:BD:22:22:22')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body['rooms'][0]['name'], 'Server Room')
        self.assertEqual(body['rooms'][0]['floor'], 1)
        self.assertEqual(len(body['rooms'][0]['doors']), 2)
        self.assertEqual(device.room.name, 'Server Room')

    def test_include_devices_returns_editor_payload(self):
        Device.objects.create(
            owner=self.user,
            is_paired=True,
            mac_address='7C:9E:BD:33:33:33',
            name='Unmapped Node',
            role='sensor',
        )

        response = self.client.get('/api/layout/?include_devices=1')

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertIn('rooms', body)
        self.assertEqual(body['unmapped_devices'][0]['mac_address'], '7C:9E:BD:33:33:33')
