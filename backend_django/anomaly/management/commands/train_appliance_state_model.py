from pathlib import Path
from datetime import timedelta

import joblib
import pandas as pd
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from anomaly.ml.appliance_state import (
    FEATURE_COLUMNS,
    STATE_ABNORMAL,
    STATE_ACTIVE,
    STATE_IDLE,
    STATE_PHANTOM_LOAD,
    clear_appliance_model_cache,
)
from telemetry.models import TelemetryReading


def _label_row(row, device_stats):
    power = float(row['power'])
    current = float(row['current'])
    stats = device_stats[row['channel_key']]
    avg_power = max(float(stats['avg_power']), 1e-6)
    max_power = max(float(stats['max_power']), 1e-6)

    if power > max(1800.0, max_power * 1.35) or current > 8:
        return STATE_ABNORMAL
    if power <= max(1.5, avg_power * 0.10):
        return STATE_IDLE
    if 3 <= power <= max(8.0, avg_power * 0.25):
        return STATE_PHANTOM_LOAD
    if power > max(2.0, avg_power * 0.40):
        return STATE_ACTIVE
    return STATE_IDLE


class Command(BaseCommand):
    help = 'Train the RandomForest appliance state classifier from telemetry history.'

    def add_arguments(self, parser):
        window_group = parser.add_mutually_exclusive_group()
        window_group.add_argument('--days', type=int, default=None)
        window_group.add_argument('--hours', type=int, default=None)
        window_group.add_argument('--minutes', type=int, default=None)
        parser.add_argument('--output', default=None)
        parser.add_argument('--min-rows', type=int, default=None)
        parser.add_argument(
            '--latest-available',
            action='store_true',
            help='Anchor the training window at the newest telemetry row instead of the current time.',
        )

    def handle(self, *args, **options):
        days = options['days']
        hours = options['hours']
        minutes = options['minutes']
        if days is not None and days <= 0:
            raise CommandError('--days must be greater than 0.')
        if hours is not None and hours <= 0:
            raise CommandError('--hours must be greater than 0.')
        if minutes is not None and minutes <= 0:
            raise CommandError('--minutes must be greater than 0.')

        if minutes is not None:
            training_window = timedelta(minutes=minutes)
            window_label = f'{minutes} minute(s)'
        elif hours is not None:
            training_window = timedelta(hours=hours)
            window_label = f'{hours} hour(s)'
        else:
            days = days or 60
            training_window = timedelta(days=days)
            window_label = f'{days} day(s)'

        min_rows = int(options['min_rows'] or getattr(settings, 'APPLIANCE_MODEL_MIN_ROWS', 50))
        if options['latest_available']:
            latest_reading = TelemetryReading.objects.order_by('-timestamp').first()
            if latest_reading is None:
                raise CommandError('No telemetry readings are available for training.')
            window_end = latest_reading.timestamp
            anchor_label = f'ending at latest telemetry row ({window_end.isoformat()})'
        else:
            window_end = timezone.now()
            anchor_label = f'ending now ({window_end.isoformat()})'

        since = window_end - training_window
        queryset = TelemetryReading.objects.filter(
            timestamp__gte=since,
            timestamp__lte=window_end,
        ).order_by('timestamp')

        rows = []
        for reading in queryset.iterator():
            local_ts = timezone.localtime(reading.timestamp)
            channel = int(reading.channel or 0)
            channel_key = f'{reading.device_id}:ch{channel}' if channel else f'{reading.device_id}:global'
            rows.append({
                'channel_key': channel_key,
                'current': float(reading.current or 0.0),
                'power': float(reading.power or 0.0),
                'hour_of_day': local_ts.hour,
                'day_of_week': local_ts.weekday(),
                'appliance_channel': channel,
            })

        frame = pd.DataFrame(rows)
        if len(frame) < min_rows:
            raise CommandError(f'Need at least {min_rows} telemetry rows, found {len(frame)}.')

        device_stats = (
            frame.groupby('channel_key')['power']
            .agg(avg_power='mean', max_power='max')
            .to_dict('index')
        )
        frame['device_avg_power'] = frame['channel_key'].map(lambda value: device_stats[value]['avg_power'])
        frame['device_max_power'] = frame['channel_key'].map(lambda value: device_stats[value]['max_power'])
        frame['power_to_avg_ratio'] = frame['power'] / frame['device_avg_power'].clip(lower=1e-6)
        frame['label'] = frame.apply(lambda row: _label_row(row, device_stats), axis=1)

        numeric_features = [name for name in FEATURE_COLUMNS if name != 'channel_key']
        preprocessor = ColumnTransformer(
            transformers=[
                ('numeric', StandardScaler(), numeric_features),
                ('channel', OneHotEncoder(handle_unknown='ignore'), ['channel_key']),
            ]
        )
        classifier = RandomForestClassifier(
            n_estimators=180,
            max_depth=12,
            min_samples_leaf=2,
            class_weight='balanced_subsample',
            random_state=42,
            n_jobs=-1,
        )
        pipeline = Pipeline([
            ('preprocess', preprocessor),
            ('model', classifier),
        ])

        X = frame[FEATURE_COLUMNS]
        y = frame['label']
        stratify = y if y.value_counts().min() >= 2 and y.nunique() > 1 else None
        X_train, X_test, y_train, y_test = train_test_split(
            X,
            y,
            test_size=0.2,
            random_state=42,
            stratify=stratify,
        )
        pipeline.fit(X_train, y_train)
        report = classification_report(y_test, pipeline.predict(X_test), output_dict=True, zero_division=0)

        output = Path(options['output'] or getattr(settings, 'APPLIANCE_STATE_MODEL_PATH'))
        output.parent.mkdir(parents=True, exist_ok=True)
        bundle = {
            'pipeline': pipeline,
            'features': FEATURE_COLUMNS,
            'model_version': f"rf-{timezone.now().strftime('%Y%m%d%H%M%S')}",
            'trained_at': timezone.now().isoformat(),
            'training_rows': int(len(frame)),
            'training_window': window_label,
            'label_counts': frame['label'].value_counts().to_dict(),
            'classification_report': report,
        }
        joblib.dump(bundle, output)
        clear_appliance_model_cache()

        self.stdout.write(self.style.SUCCESS(
            f'Trained appliance state model: {output} from {len(frame)} telemetry rows '
            f'collected over the last {window_label}, {anchor_label}.'
        ))
        self.stdout.write(f"Rows: {len(frame)} Labels: {bundle['label_counts']}")
