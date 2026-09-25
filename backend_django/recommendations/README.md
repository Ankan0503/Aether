# Energy Recommendation API

The recommendation engine analyzes appliance history with pandas and returns
human-readable energy-saving actions as JSON.

## Endpoint

```text
GET /api/recommendations/energy/?days=30
POST /api/recommendations/energy/
```

GET reads `TelemetryReading` history from the Django/Supabase database. POST can
analyze richer gateway history without requiring a schema change.

## POST Body

```json
{
  "readings": [
    {
      "timestamp": "2026-05-28T18:00:00Z",
      "appliance": "Living room fan",
      "current": 0.18,
      "power_watts": 41.4,
      "pir": 0,
      "duration_seconds": 60,
      "state": "idle"
    }
  ]
}
```

Accepted history fields include `timestamp`, `appliance`, `current`,
`power_watts`, `energy_kwh`, `duration_seconds`, `pir`, `occupied`,
`occupancy`, and `state`. `GET` derives appliance names from paired devices and
uses `TelemetryReading.current` plus the configured voltage for power estimates.

## Detection Types

- `standby_power`: repeated low-level draw from appliances that appear idle.
- `occupancy_based`: power use while PIR reports no occupancy.
- `abnormal_usage_trend`: recent daily energy has risen above the earlier pattern.

## Tuning

The following environment variables tune production behavior:

```text
RECOMMENDATION_DEFAULT_VOLTAGE=230
ELECTRICITY_RATE_PER_KWH=8
RECOMMENDATION_CURRENCY=INR
STANDBY_CURRENT_THRESHOLD=0.05
STANDBY_POWER_THRESHOLD_WATTS=8
OCCUPANCY_POWER_THRESHOLD_WATTS=15
ABNORMAL_USAGE_TREND_PERCENT=25
MIN_RECOMMENDATION_SAMPLES=12
MAX_ENERGY_RECOMMENDATIONS=12
```
