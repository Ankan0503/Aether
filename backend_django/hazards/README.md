# Hazard Prediction API

The hazard module scores MQ2 gas and flame sensor readings in real time using
lightweight, explainable scoring logic.

## Endpoints

```text
POST /api/hazards/predict/
GET /api/hazards/thresholds/
```

## Prediction Request

```json
{
  "gas": 3500,
  "flame": 1,
  "device_mac": "AA:BB:CC:DD:EE:FF",
  "trigger_actions": false,
  "thresholds": {
    "gas_warning": 1800,
    "gas_danger": 3500
  }
}
```

`flame` defaults to the firmware convention: `0` means flame detected and `1`
means safe.

## Response

The API returns:

- `risk_score`: dynamic score from `0` to `100`.
- `hazard_type`: `NORMAL`, `GAS_WARNING`, `GAS_LEAK`, `FIRE_RISK` or compound risk.
- `confidence_score`: explainable confidence from sensor strength.
- `actions`: buzzer, solenoid shutoff and dashboard notification decisions.
- `dispatch`: MQTT publish result when `trigger_actions` is true.

## Tuning

Environment variables:

```text
HAZARD_GAS_WARNING=1800
HAZARD_GAS_DANGER=3500
HAZARD_GAS_CRITICAL=4095
HAZARD_FLAME_ACTIVE_VALUE=0
HAZARD_FIRE_RISK_SCORE=95
HAZARD_BUZZER_SCORE=55
HAZARD_SOLENOID_SCORE=75
HAZARD_NOTIFICATION_SCORE=35
HAZARD_MQTT_TOPIC=aether/pairing/command
```
