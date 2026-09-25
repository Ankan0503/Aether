"""A WF frame from the firmware must classify and store correctly.

    python manage.py test telemetry.test_waveform_ingest --settings=core.settings_test

The frames here are built the way the firmware builds them - normalised to peak,
quantised to signed bytes, base64 - so this exercises the real decode path, not
a convenient shortcut.
"""

import base64
import math

import numpy as np
from django.test import TestCase

from telemetry.models import LoadSignature
from telemetry.waveform import ingest_waveform_payload, is_waveform_payload

BINS = 64


def encode(cycle: np.ndarray) -> str:
    """Exactly what wfBuildPayload() does on the ESP32."""
    peak = float(np.max(np.abs(cycle))) or 1.0
    quantised = np.clip(np.round(cycle / peak * 127), -127, 127).astype(np.int8)
    return base64.b64encode(quantised.tobytes()).decode()


def bulb() -> np.ndarray:
    t = np.arange(BINS) / BINS
    return 38.0 * np.sin(2 * math.pi * t)


def charger() -> np.ndarray:
    """Non-PFC switching supply: current only near the voltage peaks."""
    t = np.arange(BINS) / BINS
    voltage = np.sin(2 * math.pi * t)
    pulse = np.where(np.abs(voltage) > 0.88, np.abs(voltage) - 0.88, 0.0) * np.sign(voltage)
    return 25.0 * pulse / (np.max(np.abs(pulse)) or 1.0)


def frame(cycle: np.ndarray, socket: int, device_label: str, rms: float) -> dict:
    return {
        'action': 'WF',
        'mac': 'AA:BB:CC:11:22:33',
        'ch': socket,
        'rms': rms,
        'cls': device_label,
        'w': encode(cycle),
    }


class WaveformIngestTests(TestCase):
    def test_action_routing(self):
        self.assertTrue(is_waveform_payload({'action': 'WF'}))
        self.assertFalse(is_waveform_payload({'action': 'TELEMETRY'}))

    def test_bulb_is_classified_resistive(self):
        row = ingest_waveform_payload(frame(bulb(), 1, 'RESISTIVE', 38.3))
        self.assertEqual(row.label, 'RESISTIVE')
        self.assertLess(row.crest, 1.75, 'a sine must have a low crest factor')
        self.assertLess(row.thd, 0.3)
        self.assertGreater(row.conduction, 0.55)

    def test_charger_is_classified_switching(self):
        row = ingest_waveform_payload(frame(charger(), 2, 'SMPS', 25.5))
        self.assertEqual(row.label, 'SMPS')
        self.assertGreater(row.crest, 2.2, 'a switching supply must have a high crest factor')
        self.assertLess(row.conduction, 0.4)

    def test_waveform_is_kept_for_the_dashboard(self):
        row = ingest_waveform_payload(frame(bulb(), 1, 'RESISTIVE', 38.3))
        self.assertEqual(len(row.cycle), BINS)
        self.assertLessEqual(max(abs(v) for v in row.cycle), 1.01,
                             'the stored cycle is normalised to its own peak')

    def test_server_recomputes_rather_than_trusting_the_node(self):
        # The node claims RESISTIVE while sending a charger's waveform. The
        # server must believe the waveform, so stale firmware thresholds cannot
        # skew the history.
        row = ingest_waveform_payload(frame(charger(), 3, 'RESISTIVE', 25.5))
        self.assertEqual(row.label, 'SMPS')
        self.assertEqual(row.device_label, 'RESISTIVE')

    def test_unchanged_signature_is_not_stored_again(self):
        first = ingest_waveform_payload(frame(bulb(), 1, 'RESISTIVE', 38.3))
        self.assertIsNotNone(first)
        again = ingest_waveform_payload(frame(bulb(), 1, 'RESISTIVE', 38.3))
        self.assertIsNone(again, 'an identical shape should not be stored twice')
        self.assertEqual(LoadSignature.objects.count(), 1)

    def test_a_changed_load_is_stored(self):
        ingest_waveform_payload(frame(bulb(), 1, 'RESISTIVE', 38.3))
        swapped = ingest_waveform_payload(frame(charger(), 1, 'SMPS', 25.5))
        self.assertIsNotNone(swapped, 'swapping the appliance must be recorded')
        self.assertEqual(swapped.label, 'SMPS')
        self.assertEqual(LoadSignature.objects.count(), 2)

    def test_sockets_are_tracked_separately(self):
        ingest_waveform_payload(frame(bulb(), 1, 'RESISTIVE', 38.3))
        second = ingest_waveform_payload(frame(bulb(), 2, 'RESISTIVE', 38.3))
        self.assertIsNotNone(second, 'a different socket is a different stream')
        self.assertEqual(LoadSignature.objects.count(), 2)

    def test_malformed_frame_is_rejected_clearly(self):
        with self.assertRaises(ValueError):
            ingest_waveform_payload({'action': 'WF', 'mac': 'AA', 'ch': 1, 'w': 'not base64!!'})
        with self.assertRaises(ValueError):
            ingest_waveform_payload({'action': 'WF', 'ch': 1, 'w': encode(bulb())})
