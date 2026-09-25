from dataclasses import asdict, dataclass

from django.conf import settings


@dataclass(frozen=True)
class HazardThresholds:
    gas_warning: int
    gas_danger: int
    gas_critical: int
    flame_active_value: int
    fire_risk_score: int
    buzzer_score: int
    solenoid_score: int
    notification_score: int

    @classmethod
    def from_settings(cls):
        return cls(
            gas_warning=int(getattr(settings, 'HAZARD_GAS_WARNING', 1800)),
            gas_danger=int(getattr(settings, 'HAZARD_GAS_DANGER', 3500)),
            gas_critical=int(getattr(settings, 'HAZARD_GAS_CRITICAL', 4095)),
            flame_active_value=int(getattr(settings, 'HAZARD_FLAME_ACTIVE_VALUE', 0)),
            fire_risk_score=int(getattr(settings, 'HAZARD_FIRE_RISK_SCORE', 95)),
            buzzer_score=int(getattr(settings, 'HAZARD_BUZZER_SCORE', 55)),
            solenoid_score=int(getattr(settings, 'HAZARD_SOLENOID_SCORE', 75)),
            notification_score=int(getattr(settings, 'HAZARD_NOTIFICATION_SCORE', 35)),
        )

    def tuned(self, overrides: dict | None):
        if not overrides:
            return self

        values = asdict(self)
        for key in values:
            if key in overrides:
                values[key] = int(overrides[key])
        tuned = HazardThresholds(**values)
        tuned.validate()
        return tuned

    def validate(self):
        if not (0 <= self.gas_warning < self.gas_danger <= self.gas_critical):
            raise ValueError('Gas thresholds must satisfy warning < danger <= critical.')
        for name in ['fire_risk_score', 'buzzer_score', 'solenoid_score', 'notification_score']:
            value = getattr(self, name)
            if value < 0 or value > 100:
                raise ValueError(f'{name} must be between 0 and 100.')


class HazardRiskScorer:
    """
    Lightweight ML-inspired scorer for real-time gas/fire risk.

    The score blends normalized gas concentration, flame state and interaction
    risk. It is deterministic, explainable and fast enough for request-path use.
    """

    def __init__(self, thresholds: HazardThresholds | None = None):
        self.thresholds = thresholds or HazardThresholds.from_settings()
        self.thresholds.validate()

    def predict(self, payload: dict) -> dict:
        gas = self._parse_gas(payload)
        flame = self._parse_flame(payload)
        flame_detected = flame == self.thresholds.flame_active_value

        gas_score = self._gas_score(gas)
        flame_score = self.thresholds.fire_risk_score if flame_detected else 0
        interaction_bonus = 15 if flame_detected and gas >= self.thresholds.gas_warning else 0
        risk_score = min(100, round((gas_score * 0.72) + (flame_score * 0.85) + interaction_bonus))

        hazard_type = self._hazard_type(gas, flame_detected)
        severity = self._severity(risk_score)
        confidence = self._confidence(gas, flame_detected, risk_score)

        return {
            'risk_score': risk_score,
            'severity': severity,
            'hazard_detected': risk_score >= self.thresholds.notification_score,
            'hazard_type': hazard_type,
            'confidence_score': confidence,
            'inputs': {
                'gas': gas,
                'flame': flame,
                'flame_detected': flame_detected,
            },
            'signals': {
                'gas_score': round(gas_score, 2),
                'flame_score': flame_score,
                'interaction_bonus': interaction_bonus,
            },
            'thresholds': asdict(self.thresholds),
            'explanation': self._explanation(gas, flame_detected, hazard_type, risk_score),
        }

    @staticmethod
    def _parse_gas(payload: dict) -> int:
        if 'gas' not in payload:
            raise ValueError('gas is required.')
        gas = int(payload['gas'])
        if gas < 0:
            raise ValueError('gas must be greater than or equal to 0.')
        return gas

    @staticmethod
    def _parse_flame(payload: dict) -> int:
        if 'flame' not in payload:
            raise ValueError('flame is required.')
        return int(payload['flame'])

    def _gas_score(self, gas: int) -> float:
        if gas <= self.thresholds.gas_warning:
            return (gas / max(self.thresholds.gas_warning, 1)) * 30.0
        if gas <= self.thresholds.gas_danger:
            span = self.thresholds.gas_danger - self.thresholds.gas_warning
            return 30.0 + ((gas - self.thresholds.gas_warning) / span) * 45.0
        span = max(self.thresholds.gas_critical - self.thresholds.gas_danger, 1)
        return min(100.0, 75.0 + ((gas - self.thresholds.gas_danger) / span) * 25.0)

    def _hazard_type(self, gas: int, flame_detected: bool) -> str:
        gas_danger = gas >= self.thresholds.gas_danger
        gas_warning = gas >= self.thresholds.gas_warning
        if flame_detected and gas_warning:
            return 'GAS_FIRE_COMPOUND_RISK'
        if flame_detected:
            return 'FIRE_RISK'
        if gas_danger:
            return 'GAS_LEAK'
        if gas_warning:
            return 'GAS_WARNING'
        return 'NORMAL'

    @staticmethod
    def _severity(risk_score: int) -> str:
        if risk_score >= 85:
            return 'critical'
        if risk_score >= 65:
            return 'high'
        if risk_score >= 35:
            return 'medium'
        return 'low'

    @staticmethod
    def _confidence(gas: int, flame_detected: bool, risk_score: int) -> float:
        sensor_strength = min(gas / 4095.0, 1.0)
        flame_strength = 1.0 if flame_detected else 0.0
        confidence = 0.45 + (sensor_strength * 0.35) + (flame_strength * 0.2)
        if risk_score < 35:
            confidence = min(confidence, 0.65)
        return round(min(confidence, 0.99), 4)

    def _explanation(self, gas: int, flame_detected: bool, hazard_type: str, risk_score: int) -> str:
        if hazard_type == 'GAS_FIRE_COMPOUND_RISK':
            return f'Gas is elevated at {gas} and the flame sensor is active; risk score is {risk_score}.'
        if hazard_type == 'FIRE_RISK':
            return f'The flame sensor is active; risk score is {risk_score}.'
        if hazard_type == 'GAS_LEAK':
            return f'Gas reading {gas} is above the danger threshold; risk score is {risk_score}.'
        if hazard_type == 'GAS_WARNING':
            return f'Gas reading {gas} is above the warning threshold; monitor ventilation and appliances.'
        return 'Gas and flame readings are within normal operating range.'

