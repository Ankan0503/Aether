"""TELEMETRY_PERSIST=False must keep the pipeline live while writing nothing.

    python manage.py test telemetry.test_persist_switch

The point of the switch is to watch telemetry reach the dashboard without
spending database storage on it, so two things have to hold at once: no rows are
written, and the live snapshot the frontend reads is still updated.
"""

from django.test import TestCase, override_settings

from devices.models import Device
from telemetry import live_state
from telemetry.ingestion import ingest_telemetry_payload
from telemetry.models import TelemetryReading
from telemetry.store_policy import reset_state


PAYLOAD = {
    'mac': 'AA:BB:CC:00:11:22',
    'gas': 120,
    'current': 0.43,
    'pir': 1,
    'flame': 1,
    'status': 'SAFE',
}


class PersistSwitchTests(TestCase):
    def setUp(self):
        reset_state()
        live_state.clear()

    @override_settings(TELEMETRY_PERSIST=False)
    def test_nothing_is_written_when_persistence_is_off(self):
        for _ in range(5):
            ingest_telemetry_payload(dict(PAYLOAD))
        self.assertEqual(TelemetryReading.objects.count(), 0)

    @override_settings(TELEMETRY_PERSIST=False)
    def test_live_state_still_updates_when_persistence_is_off(self):
        ingest_telemetry_payload(dict(PAYLOAD, current=0.43))
        reading = live_state.latest_for(PAYLOAD['mac'])
        self.assertIsNotNone(reading, 'the dashboard would show nothing')
        self.assertAlmostEqual(reading.current, 0.43, places=3)

        ingest_telemetry_payload(dict(PAYLOAD, current=1.20))
        reading = live_state.latest_for(PAYLOAD['mac'])
        self.assertAlmostEqual(reading.current, 1.20, places=3,
                               msg='live state went stale')
        self.assertEqual(TelemetryReading.objects.count(), 0)

    @override_settings(TELEMETRY_PERSIST=False)
    def test_unsaved_readings_have_no_id_but_do_have_a_timestamp(self):
        # The view orders by timestamp precisely because an unsaved reading's
        # id is None and would break a max() on it.
        ingest_telemetry_payload(dict(PAYLOAD))
        reading = live_state.latest_for(PAYLOAD['mac'])
        self.assertIsNone(reading.pk)
        self.assertIsNotNone(reading.timestamp)

    @override_settings(TELEMETRY_PERSIST=True)
    def test_rows_are_written_when_persistence_is_on(self):
        ingest_telemetry_payload(dict(PAYLOAD))
        self.assertGreaterEqual(TelemetryReading.objects.count(), 1)

    @override_settings(TELEMETRY_PERSIST=True)
    def test_device_is_still_registered_when_persistence_is_off(self):
        # Device rows are not telemetry history - a node must still appear and
        # be pairable while storage is paused.
        with self.settings(TELEMETRY_PERSIST=False):
            ingest_telemetry_payload(dict(PAYLOAD))
        self.assertTrue(Device.objects.filter(mac_address=PAYLOAD['mac']).exists())
        self.assertEqual(TelemetryReading.objects.count(), 0)
