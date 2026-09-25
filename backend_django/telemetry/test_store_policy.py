"""Tests for the telemetry storage policy.

    python manage.py test telemetry.test_store_policy

The policy is what stands between a 2-second publish rate and a database that
fills in a fortnight, so its edges are worth pinning down: safety must never be
suppressed, sensor noise must never be mistaken for a change, and each socket
must be judged on its own.
"""

from django.test import SimpleTestCase

from telemetry.store_policy import reset_state, should_store


class StorePolicyTests(SimpleTestCase):
    def setUp(self):
        reset_state()

    def test_first_sample_is_always_stored(self):
        stored, reason = should_store('AA', 1, current=0.4, now=1000.0)
        self.assertTrue(stored)
        self.assertIn('first sample', reason)

    def test_unchanged_sample_is_suppressed(self):
        should_store('AA', 1, current=0.400, now=1000.0)
        stored, reason = should_store('AA', 1, current=0.401, now=1002.0)
        self.assertFalse(stored)
        self.assertIn('unchanged', reason)

    def test_heartbeat_forces_a_store(self):
        should_store('AA', 1, current=0.400, now=1000.0)
        stored, _ = should_store('AA', 1, current=0.400, now=1059.0)
        self.assertFalse(stored, 'just under the heartbeat should still be suppressed')
        stored, reason = should_store('AA', 1, current=0.400, now=1061.0)
        self.assertTrue(stored)
        self.assertIn('heartbeat', reason)

    def test_real_current_change_is_stored(self):
        should_store('AA', 1, current=0.400, now=1000.0)
        stored, reason = should_store('AA', 1, current=0.000, now=1002.0)
        self.assertTrue(stored)
        self.assertIn('current', reason)

    def test_sensor_noise_is_not_a_change(self):
        # A 30A ACS712 jitters by a few tens of milliamps with a steady load.
        # Without the absolute deadband every sample would look like a change
        # and nothing would ever be suppressed.
        should_store('AA', 1, current=0.400, now=1000.0)
        for offset, noisy in enumerate([0.412, 0.389, 0.404, 0.395], start=1):
            stored, _ = should_store('AA', 1, current=noisy, now=1000.0 + offset)
            self.assertFalse(stored, f'{noisy} A should read as noise, not a change')

    def test_status_change_bypasses_the_deadband(self):
        should_store('AA', 1, current=0.4, status='SAFE', now=1000.0)
        stored, reason = should_store('AA', 1, current=0.4, status='DANGER', now=1000.5)
        self.assertTrue(stored, 'a hazard must never wait for a heartbeat')
        self.assertIn('status', reason)

    def test_flame_change_bypasses_the_deadband(self):
        should_store('AA', 1, current=0.4, flame=1, now=1000.0)
        stored, reason = should_store('AA', 1, current=0.4, flame=0, now=1000.5)
        self.assertTrue(stored)
        self.assertIn('flame', reason)

    def test_gas_crossing_the_alert_threshold_is_stored(self):
        should_store('AA', 1, current=0.4, gas=1000, now=1000.0)
        stored, reason = should_store('AA', 1, current=0.4, gas=3600, now=1000.5)
        self.assertTrue(stored)
        self.assertIn('gas', reason)

    def test_sockets_are_independent_streams(self):
        should_store('AA', 1, current=0.4, now=1000.0)
        should_store('AA', 2, current=0.0, now=1000.0)
        # Socket 1 changes; socket 2 must not be dragged into a write.
        stored_one, _ = should_store('AA', 1, current=0.0, now=1002.0)
        stored_two, _ = should_store('AA', 2, current=0.0, now=1002.0)
        self.assertTrue(stored_one)
        self.assertFalse(stored_two)

    def test_devices_are_independent_streams(self):
        should_store('AA', 1, current=0.4, now=1000.0)
        stored, reason = should_store('BB', 1, current=0.4, now=1000.0)
        self.assertTrue(stored)
        self.assertIn('first sample', reason)

    def test_steady_load_writes_once_a_minute(self):
        """The headline claim: a constant load costs 1,440 rows a day, not 43,200."""
        writes = 0
        for tick in range(0, 3600, 2):        # one hour at the 2-second publish rate
            stored, _ = should_store('AA', 1, current=0.400, now=1000.0 + tick)
            writes += stored
        self.assertLessEqual(writes, 61, f'{writes} writes in an hour is too many')
        self.assertGreaterEqual(writes, 59, f'{writes} writes means the heartbeat is missing')
