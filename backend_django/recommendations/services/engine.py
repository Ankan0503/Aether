from dataclasses import asdict, dataclass
from typing import Any

import pandas as pd
from django.conf import settings
from django.utils import timezone


REQUIRED_OUTPUT_KEYS = [
    'id',
    'category',
    'severity',
    'appliance',
    'title',
    'message',
    'estimated_monthly_savings',
    'evidence',
]


@dataclass(frozen=True)
class EngineConfig:
    default_voltage: float
    electricity_rate_per_kwh: float
    standby_current_threshold: float
    standby_power_threshold_watts: float
    occupancy_power_threshold_watts: float
    abnormal_trend_percent: float
    min_samples_per_appliance: int
    max_recommendations: int

    @classmethod
    def from_settings(cls):
        return cls(
            default_voltage=float(getattr(settings, 'RECOMMENDATION_DEFAULT_VOLTAGE', 230.0)),
            electricity_rate_per_kwh=float(getattr(settings, 'ELECTRICITY_RATE_PER_KWH', 8.0)),
            standby_current_threshold=float(getattr(settings, 'STANDBY_CURRENT_THRESHOLD', 0.05)),
            standby_power_threshold_watts=float(getattr(settings, 'STANDBY_POWER_THRESHOLD_WATTS', 8.0)),
            occupancy_power_threshold_watts=float(getattr(settings, 'OCCUPANCY_POWER_THRESHOLD_WATTS', 15.0)),
            abnormal_trend_percent=float(getattr(settings, 'ABNORMAL_USAGE_TREND_PERCENT', 25.0)),
            min_samples_per_appliance=int(getattr(settings, 'MIN_RECOMMENDATION_SAMPLES', 12)),
            max_recommendations=int(getattr(settings, 'MAX_ENERGY_RECOMMENDATIONS', 12)),
        )


@dataclass(frozen=True)
class Recommendation:
    id: str
    category: str
    severity: str
    appliance: str
    title: str
    message: str
    estimated_monthly_savings: float
    evidence: dict[str, Any]

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload['estimated_monthly_savings'] = round(float(payload['estimated_monthly_savings']), 2)
        return payload


class EnergyRecommendationEngine:
    """
    Lightweight analytics engine for smart-home energy recommendations.

    This intentionally uses pandas aggregations instead of heavyweight ML so it can
    run inside the Django request path for modest history windows.
    """

    def __init__(self, config: EngineConfig | None = None):
        self.config = config or EngineConfig.from_settings()

    def generate(self, raw_history: pd.DataFrame) -> dict:
        frame = self._prepare_history(raw_history)
        if frame.empty:
            return {
                'summary': {
                    'recommendation_count': 0,
                    'estimated_monthly_savings': 0.0,
                    'currency': getattr(settings, 'RECOMMENDATION_CURRENCY', 'INR'),
                    'history_samples': 0,
                    'appliances_analyzed': 0,
                    'message': 'Not enough appliance history is available yet.',
                },
                'recommendations': [],
                'metadata': self._metadata(frame),
            }

        recommendations = []
        recommendations.extend(self._detect_standby_power(frame))
        recommendations.extend(self._detect_occupancy_waste(frame))
        recommendations.extend(self._detect_abnormal_trends(frame))
        recommendations = self._deduplicate_and_rank(recommendations)

        total_monthly_kwh = float(frame.groupby('date')['estimated_kwh'].sum().mean() * 30.0)
        return {
            'summary': {
                'recommendation_count': len(recommendations),
                'estimated_monthly_savings': round(
                    sum(item['estimated_monthly_savings'] for item in recommendations), 2
                ),
                'currency': getattr(settings, 'RECOMMENDATION_CURRENCY', 'INR'),
                'history_samples': int(len(frame)),
                'appliances_analyzed': int(frame['appliance'].nunique()),
                'estimated_monthly_kwh': round(total_monthly_kwh, 3),
                'estimated_monthly_cost': round(total_monthly_kwh * self.config.electricity_rate_per_kwh, 2),
            },
            'recommendations': recommendations,
            'metadata': self._metadata(frame),
        }

    def _prepare_history(self, raw_history: pd.DataFrame) -> pd.DataFrame:
        if raw_history is None or raw_history.empty:
            return pd.DataFrame()

        frame = raw_history.copy()
        if 'timestamp' not in frame:
            return pd.DataFrame()

        frame['timestamp'] = pd.to_datetime(frame['timestamp'], utc=True, errors='coerce')
        frame = frame.dropna(subset=['timestamp'])
        if 'appliance' not in frame:
            frame['appliance'] = 'Whole home'
        frame['appliance'] = frame['appliance'].fillna('Whole home').astype(str)
        frame['appliance'] = frame['appliance'].str.strip().replace('', 'Whole home')

        if 'current' not in frame:
            frame['current'] = 0
        frame['current'] = pd.to_numeric(frame['current'], errors='coerce').fillna(0).clip(lower=0)

        if 'power_watts' in frame:
            frame['power_watts'] = pd.to_numeric(frame['power_watts'], errors='coerce')
        else:
            frame['power_watts'] = frame['current'] * self.config.default_voltage
        frame['power_watts'] = frame['power_watts'].fillna(frame['current'] * self.config.default_voltage).clip(lower=0)

        frame['pir'] = self._normalize_occupancy(frame)
        if 'state' in frame:
            frame['state'] = frame['state'].fillna('').astype(str).str.lower()
        else:
            frame['state'] = ''

        frame['date'] = frame['timestamp'].dt.date
        frame['hour'] = frame['timestamp'].dt.hour
        frame['estimated_kwh'] = self._estimate_sample_kwh(frame)
        return frame.sort_values('timestamp')

    @staticmethod
    def _normalize_occupancy(frame: pd.DataFrame) -> pd.Series:
        for column in ('pir', 'occupied', 'occupancy'):
            if column not in frame:
                continue

            values = frame[column]
            if values.dtype == bool:
                return values.astype(int).clip(0, 1)

            normalized = values.astype(str).str.strip().str.lower()
            mapped = normalized.map({
                'true': 1,
                'yes': 1,
                'occupied': 1,
                'motion': 1,
                '1': 1,
                'false': 0,
                'no': 0,
                'empty': 0,
                'unoccupied': 0,
                'none': 0,
                '0': 0,
            })
            numeric = pd.to_numeric(values, errors='coerce')
            return mapped.fillna(numeric).fillna(1).astype(int).clip(0, 1)

        return pd.Series(1, index=frame.index)

    def _estimate_sample_kwh(self, frame: pd.DataFrame) -> pd.Series:
        # Estimate each sample's duration from the median interval per appliance.
        if 'duration_seconds' in frame:
            duration_seconds = pd.to_numeric(frame['duration_seconds'], errors='coerce').clip(lower=1, upper=3600)
        else:
            intervals = (
                frame.groupby('appliance')['timestamp']
                .diff()
                .dt.total_seconds()
                .clip(lower=1, upper=3600)
            )
            duration_seconds = intervals.groupby(frame['appliance']).transform('median')

        duration_seconds = duration_seconds.fillna(60)
        if 'energy_kwh' in frame:
            explicit_kwh = pd.to_numeric(frame['energy_kwh'], errors='coerce').clip(lower=0)
        else:
            explicit_kwh = pd.Series(float('nan'), index=frame.index, dtype='float64')

        estimated = frame['power_watts'] * (duration_seconds / 3600.0) / 1000.0
        return explicit_kwh.combine_first(estimated)

    def _monthly_savings(self, daily_kwh: float) -> float:
        return max(daily_kwh, 0.0) * 30.0 * self.config.electricity_rate_per_kwh

    def _detect_standby_power(self, frame: pd.DataFrame) -> list[dict]:
        recommendations = []
        for appliance, group in frame.groupby('appliance'):
            if len(group) < self.config.min_samples_per_appliance:
                continue

            active_floor = max(self.config.standby_power_threshold_watts, float(group['power_watts'].quantile(0.1)))
            standby_ceiling = max(self.config.standby_power_threshold_watts, float(group['power_watts'].quantile(0.35)))
            low_load = group[
                (
                    (group['state'].isin(['standby', 'idle', 'off']))
                    | (
                        (group['current'] >= self.config.standby_current_threshold)
                        & (group['power_watts'] >= active_floor)
                        & (group['power_watts'] <= standby_ceiling)
                    )
                )
            ]
            if low_load.empty:
                continue

            standby_daily_kwh = low_load.groupby('date')['estimated_kwh'].sum().mean()
            savings = self._monthly_savings(float(standby_daily_kwh) * 0.7)
            if savings <= 0:
                continue

            recommendations.append(Recommendation(
                id=f'standby-{self._slug(appliance)}',
                category='standby_power',
                severity=self._severity(savings),
                appliance=appliance,
                title=f'Reduce standby draw from {appliance}',
                message=(
                    f'{appliance} shows repeated low-level power draw. Use a smart plug schedule ''or cut power when the appliance is idle.'
                ),
                estimated_monthly_savings=savings,
                evidence={
                    'avg_standby_watts': round(float(low_load['power_watts'].mean()), 2),
                    'standby_samples': int(len(low_load)),
                    'estimated_daily_standby_kwh': round(float(standby_daily_kwh), 4),
                },
            ).to_dict())
        return recommendations

    def _detect_occupancy_waste(self, frame: pd.DataFrame) -> list[dict]:
        recommendations = []
        unoccupied = frame[
            (frame['pir'] == 0)
            & (frame['power_watts'] >= self.config.occupancy_power_threshold_watts)
        ]
        for appliance, group in unoccupied.groupby('appliance'):
            if len(group) < max(3, self.config.min_samples_per_appliance // 3):
                continue

            daily_kwh = group.groupby('date')['estimated_kwh'].sum().mean()
            savings = self._monthly_savings(float(daily_kwh) * 0.8)
            if savings <= 0:
                continue

            recommendations.append(Recommendation(
                id=f'occupancy-{self._slug(appliance)}',
                category='occupancy_based',
                severity=self._severity(savings),
                appliance=appliance,
                title=f'Automate {appliance} when rooms are empty',
                message=(
                    f'{appliance} continues consuming power while PIR reports no occupancy. ''Add an occupancy rule with a short grace period before switching it off.'
                ),
                estimated_monthly_savings=savings,
                evidence={
                    'unoccupied_samples': int(len(group)),
                    'avg_unoccupied_watts': round(float(group['power_watts'].mean()), 2),
                    'estimated_daily_unoccupied_kwh': round(float(daily_kwh), 4),
                },
            ).to_dict())
        return recommendations

    def _detect_abnormal_trends(self, frame: pd.DataFrame) -> list[dict]:
        recommendations = []
        daily = frame.groupby(['appliance', 'date'], as_index=False)['estimated_kwh'].sum()
        for appliance, group in daily.groupby('appliance'):
            if len(group) < 6 or group['estimated_kwh'].sum() <= 0:
                continue

            ordered = group.sort_values('date')
            midpoint = max(len(ordered) // 2, 1)
            baseline = ordered.iloc[:midpoint]['estimated_kwh'].mean()
            recent = ordered.iloc[midpoint:]['estimated_kwh'].mean()
            if baseline <= 0:
                continue

            increase_percent = ((recent - baseline) / baseline) * 100.0
            if increase_percent < self.config.abnormal_trend_percent:
                continue

            excess_daily_kwh = max(float(recent - baseline), 0.0)
            savings = self._monthly_savings(excess_daily_kwh * 0.6)
            if savings <= 0:
                continue

            recommendations.append(Recommendation(
                id=f'trend-{self._slug(appliance)}',
                category='abnormal_usage_trend',
                severity=self._severity(savings),
                appliance=appliance,
                title=f'Investigate rising usage on {appliance}',
                message=(
                    f'{appliance} is using {increase_percent:.0f}% more energy than its earlier pattern. ''Check schedules, manual overrides, failing components or changed routines.'
                ),
                estimated_monthly_savings=savings,
                evidence={
                    'baseline_daily_kwh': round(float(baseline), 4),
                    'recent_daily_kwh': round(float(recent), 4),
                    'increase_percent': round(float(increase_percent), 2),
                },
            ).to_dict())
        return recommendations

    def _deduplicate_and_rank(self, recommendations: list[dict]) -> list[dict]:
        clean = []
        seen = set()
        for item in recommendations:
            if item['id'] in seen:
                continue
            seen.add(item['id'])
            clean.append({key: item[key] for key in REQUIRED_OUTPUT_KEYS})
        ranked = sorted(clean, key=lambda item: item['estimated_monthly_savings'], reverse=True)
        return ranked[:self.config.max_recommendations]

    def _metadata(self, frame: pd.DataFrame) -> dict:
        if frame.empty:
            return {
                'engine': 'pandas-lightweight-v1',
                'generated_at': timezone.now().isoformat(),
            }

        return {
            'engine': 'pandas-lightweight-v1',
            'generated_at': timezone.now().isoformat(),
            'window_start': frame['timestamp'].min().isoformat(),
            'window_end': frame['timestamp'].max().isoformat(),
            'tariff_per_kwh': self.config.electricity_rate_per_kwh,
            'default_voltage': self.config.default_voltage,
        }

    @staticmethod
    def _slug(value: str) -> str:
        return ''.join(ch.lower() if ch.isalnum() else '-' for ch in value).strip('-') or 'appliance'

    @staticmethod
    def _severity(savings: float) -> str:
        if savings >= 300:
            return 'high'
        if savings >= 100:
            return 'medium'
        return 'low'
