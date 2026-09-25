from datetime import datetime, timedelta, timezone
import json

import pandas as pd
from django.test import Client, SimpleTestCase, override_settings

from .services.engine import EnergyRecommendationEngine, EngineConfig


def _engine():
    return EnergyRecommendationEngine(
        EngineConfig(
            default_voltage=230.0,
            electricity_rate_per_kwh=10.0,
            standby_current_threshold=0.02,
            standby_power_threshold_watts=5.0,
            occupancy_power_threshold_watts=15.0,
            abnormal_trend_percent=25.0,
            min_samples_per_appliance=4,
            max_recommendations=12,
        )
    )


def _sample(timestamp, appliance, watts, pir=1, state='active'):
    return {
        'timestamp': timestamp.isoformat(),
        'appliance': appliance,
        'power_watts': watts,
        'pir': pir,
        'state': state,
        'duration_seconds': 3600,
    }


class EnergyRecommendationEngineTests(SimpleTestCase):
    def test_detects_standby_power(self):
        start = datetime(2026, 5, 1, tzinfo=timezone.utc)
        rows = [
            _sample(start + timedelta(hours=i), 'TV Unit', 12, state='standby')
            for i in range(8)
        ]

        result = _engine().generate(pd.DataFrame(rows))

        categories = {item['category'] for item in result['recommendations']}
        self.assertIn('standby_power', categories)
        self.assertGreater(result['summary']['estimated_monthly_savings'], 0)

    def test_detects_occupancy_waste(self):
        start = datetime(2026, 5, 1, tzinfo=timezone.utc)
        rows = [
            _sample(start + timedelta(hours=i), 'Living Room AC', 450, pir=0)
            for i in range(6)
        ]

        result = _engine().generate(pd.DataFrame(rows))

        recommendation = result['recommendations'][0]
        self.assertEqual(recommendation['category'], 'occupancy_based')
        self.assertIn('PIR reports no occupancy', recommendation['message'])

    def test_detects_abnormal_usage_trend(self):
        start = datetime(2026, 5, 1, tzinfo=timezone.utc)
        rows = []
        for day in range(4):
            rows.append(_sample(start + timedelta(days=day), 'Water Heater', 100, state='active'))
        for day in range(4, 8):
            rows.append(_sample(start + timedelta(days=day), 'Water Heater', 250, state='active'))

        result = _engine().generate(pd.DataFrame(rows))

        categories = {item['category'] for item in result['recommendations']}
        self.assertIn('abnormal_usage_trend', categories)
        self.assertEqual(result['summary']['appliances_analyzed'], 1)

    def test_normalizes_occupancy_aliases(self):
        start = datetime(2026, 5, 1, tzinfo=timezone.utc)
        rows = [
            {
                'timestamp': (start + timedelta(hours=i)).isoformat(),
                'appliance': 'Desk Lamp',
                'power_watts': 35,
                'duration_seconds': 3600,
                'occupancy': 'unoccupied',
            }
            for i in range(5)
        ]

        result = _engine().generate(pd.DataFrame(rows))

        categories = {item['category'] for item in result['recommendations']}
        self.assertIn('occupancy_based', categories)


class EnergyRecommendationApiTests(SimpleTestCase):
    def test_post_rejects_non_array_readings(self):
        response = Client().post(
            '/api/recommendations/energy/',
            data=json.dumps({'readings': {'bad': 'shape'}}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('readings', response.json()['error'])

    @override_settings(MIN_RECOMMENDATION_SAMPLES=4)
    def test_post_returns_json_recommendations(self):
        start = datetime(2026, 5, 1, tzinfo=timezone.utc)
        payload = {
            'readings': [
                _sample(start + timedelta(hours=i), 'Kitchen Plug', 22, pir=0)
                for i in range(5)
            ]
        }

        response = Client().post(
            '/api/recommendations/energy/',
            data=json.dumps(payload),
            content_type='application/json',
        )

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertIn('summary', body)
        self.assertIn('recommendations', body)
        self.assertEqual(body['metadata']['source'], 'payload')
