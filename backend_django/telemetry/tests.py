from datetime import timedelta
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.utils import timezone

from anomaly.ml.socket_state import (
    STATE_CHARGING_COMPLETE,
    clear_socket_model_cache,
    should_cut_socket_power,
)
from devices.models import Device
from telemetry.ingestion import ingest_telemetry_payload
from telemetry.models import MLPrediction, TelemetryReading


class TelemetryIngestionTests(TestCase):
    def tearDown(self):
        clear_socket_model_cache()

    def test_ingestion_stores_float_current_and_power_without_legacy_prediction(self):
        reading, prediction = ingest_telemetry_payload({
            'mac': '7C:9E:BD:AA:00:01',
            'gas': 120,
            'current': 0.42,
            'pir': 1,
            'flame': 1,
            'status': 'SAFE',
        })

        self.assertIsInstance(reading.current, float)
        self.assertAlmostEqual(reading.current, 0.42)
        self.assertAlmostEqual(reading.power, 96.6)
        self.assertEqual(reading.device_id, '7C:9E:BD:AA:00:01')
        self.assertIsNone(reading.socket_id)
        self.assertIsNone(prediction)

    def test_relay_ingestion_creates_three_socket_readings(self):
        Device.objects.create(
            mac_address='7C:9E:BD:AA:00:02',
            name='Desk Plug',
            role='relay',
            is_paired=True,
        )

        ingest_telemetry_payload({
            'mac': '7C:9E:BD:AA:00:02',
            'c1': 0.10,
            'c2': 0.00,
            'c3': 0.02,
            'c4': 0.40,
            'r1': 1,
            'r2': 0,
            'r3': 1,
            'r4': 1,
            'gas': 0,
            'flame': 1,
        })

        socket_rows = TelemetryReading.objects.filter(
            device_id='7C:9E:BD:AA:00:02',
            socket_id__isnull=False,
        ).order_by('socket_id')
        self.assertEqual(socket_rows.count(), 3)
        self.assertEqual([row.socket_id for row in socket_rows], [1, 2, 3])
        self.assertEqual(socket_rows.get(socket_id=2).status, 'OFF')
        self.assertEqual(socket_rows.get(socket_id=3).channel, 4)
        self.assertAlmostEqual(socket_rows.get(socket_id=3).current, 0.40)
        self.assertEqual(MLPrediction.objects.filter(device_id='7C:9E:BD:AA:00:02').count(), 2)

    @override_settings(
        SOCKET_AUTO_CUTOFF_ENABLED=True,
        SOCKET_CUTOFF_CONFIDENCE_THRESHOLD=90.0,
        SOCKET_CUTOFF_CONFIRMATION_MINUTES=10,
    )
    def test_socket_cutoff_requires_ten_minutes_of_high_confidence(self):
        device_id = 'ESP32_001'
        socket_id = 2

        cutoff, reason = should_cut_socket_power(device_id, socket_id, STATE_CHARGING_COMPLETE, 96.5)
        self.assertFalse(cutoff)
        self.assertIn('Waiting', reason)

        MLPrediction.objects.create(
            device_id=device_id,
            socket_id=socket_id,
            predicted_state=STATE_CHARGING_COMPLETE,
            confidence=96.5,
        )
        old_prediction = MLPrediction.objects.get(device_id=device_id, socket_id=socket_id)
        old_prediction.created_at = timezone.now() - timedelta(minutes=11)
        old_prediction.save(update_fields=['created_at'])

        MLPrediction.objects.create(
            device_id=device_id,
            socket_id=socket_id,
            predicted_state=STATE_CHARGING_COMPLETE,
            confidence=96.5,
        )

        cutoff, reason = should_cut_socket_power(device_id, socket_id, STATE_CHARGING_COMPLETE, 96.5)
        self.assertTrue(cutoff)
        self.assertIn('confirmed', reason)

    @override_settings(SOCKET_AUTO_CUTOFF_ENABLED=True)
    @patch('anomaly.ml.socket_state.mqtt_publish.single')
    @patch('anomaly.ml.socket_state.predict_socket_state')
    def test_high_confidence_charging_complete_publishes_cutoff_after_window(self, predict_state, publish_single):
        from anomaly.ml.socket_state import predict_socket_log_and_act

        device_id = 'ESP32_002'
        socket_id = 1
        MLPrediction.objects.create(
            device_id=device_id,
            socket_id=socket_id,
            predicted_state=STATE_CHARGING_COMPLETE,
            confidence=96.5,
        )
        old_prediction = MLPrediction.objects.get(device_id=device_id, socket_id=socket_id)
        old_prediction.created_at = timezone.now() - timedelta(minutes=11)
        old_prediction.save(update_fields=['created_at'])

        predict_state.return_value = {
            'device_id': device_id,
            'socket_id': socket_id,
            'state': STATE_CHARGING_COMPLETE,
            'predicted_state': STATE_CHARGING_COMPLETE,
            'confidence': 96.5,
        }

        prediction = predict_socket_log_and_act(device_id, socket_id)

        self.assertTrue(prediction.action_taken.startswith('RELAY_OFF'))
        self.assertEqual(publish_single.call_count, 1)
