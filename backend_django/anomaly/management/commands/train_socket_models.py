from datetime import timedelta

import joblib
import pandas as pd
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q
from django.utils import timezone
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report

from anomaly.ml.socket_state import (
    FEATURE_COLUMNS,
    SOCKET_TO_RELAY_CHANNEL,
    STATE_ACTIVE,
    STATE_CHARGING_COMPLETE,
    STATE_EMPTY_SOCKET,
    STATE_IDLE,
    build_feature_frame,
    clear_socket_model_cache,
    socket_model_path,
)
from telemetry.models import TelemetryReading


SOCKET_IDS = [1, 2, 3]
RELAY_CHANNEL_TO_SOCKET = {relay: socket for socket, relay in SOCKET_TO_RELAY_CHANNEL.items()}


def _backfill_socket_ids() -> int:
    updated = 0
    for hardware_channel, socket_id in RELAY_CHANNEL_TO_SOCKET.items():
        updated += TelemetryReading.objects.filter(
            socket_id__isnull=True,
            channel=hardware_channel,
        ).update(socket_id=socket_id)
    return updated


def _effective_socket_id(row) -> int | None:
    channel = row.get('channel')
    if pd.notna(channel):
        hardware_socket = RELAY_CHANNEL_TO_SOCKET.get(int(channel))
        if hardware_socket is None:
            return None
        return hardware_socket
    socket_id = row.get('socket_id')
    if pd.isna(socket_id):
        return None
    socket_id = int(socket_id)
    return socket_id if socket_id in SOCKET_IDS else None


def _label_group(frame: pd.DataFrame) -> pd.Series:
    labels = []
    for _, row in frame.iterrows():
        power = float(row['power'])
        current = float(row['current'])
        timestamp = row['timestamp']

        if power < 1.0 and current < 0.02:
            labels.append(STATE_EMPTY_SOCKET)
            continue
        if power > 15.0:
            labels.append(STATE_ACTIVE)
            continue

        window_start = timestamp - pd.Timedelta(minutes=10)
        recent = frame[(frame['timestamp'] >= window_start) & (frame['timestamp'] <= timestamp)]
        low_power_for_window = (
            not recent.empty
            and recent['timestamp'].min() <= window_start
            and float(recent['power'].max()) < 5.0
        )
        if low_power_for_window:
            labels.append(STATE_CHARGING_COMPLETE)
        else:
            labels.append(STATE_IDLE)
    return pd.Series(labels, index=frame.index)


class Command(BaseCommand):
    help = 'Train RandomForest appliance state models independently for each device socket.'

    def add_arguments(self, parser):
        parser.add_argument('--days', type=int, default=90)
        parser.add_argument('--min-rows', type=int, default=None)
        parser.add_argument('--bootstrap-min-rows', type=int, default=None)
        parser.add_argument('--n-jobs', type=int, default=None)
        parser.add_argument(
            '--skip-backfill',
            action='store_true',
            help='Do not backfill socket_id from legacy channel values before training.',
        )

    def handle(self, *args, **options):
        days = int(options['days'])
        if days <= 0:
            raise CommandError('--days must be greater than 0.')

        min_rows = int(options['min_rows'] or getattr(settings, 'SOCKET_MODEL_MIN_ROWS', 20))
        bootstrap_min_rows = int(
            options['bootstrap_min_rows'] or getattr(settings, 'SOCKET_BOOTSTRAP_MIN_ROWS', 2)
        )
        if bootstrap_min_rows < 1:
            raise CommandError('--bootstrap-min-rows must be greater than 0.')
        if bootstrap_min_rows > min_rows:
            raise CommandError('--bootstrap-min-rows cannot be greater than --min-rows.')
        n_jobs = int(options['n_jobs'] if options['n_jobs'] is not None else getattr(settings, 'SOCKET_MODEL_N_JOBS', 1))

        if not options['skip_backfill']:
            updated = _backfill_socket_ids()
            if updated:
                self.stdout.write(f'Backfilled socket_id on {updated} legacy telemetry row(s).')

        since = timezone.now() - timedelta(days=days)
        queryset = (
            TelemetryReading.objects
            .filter(
                Q(socket_id__in=SOCKET_IDS) | Q(socket_id__isnull=True, channel__in=RELAY_CHANNEL_TO_SOCKET.keys()),
                timestamp__gte=since,
            )
            .exclude(status__iexact='OFF')
            .order_by('device_id', 'socket_id', 'channel', 'timestamp', 'id')
            .values('id', 'device_id', 'socket_id', 'channel', 'timestamp', 'current', 'power')
        )
        rows = list(queryset)
        if not rows:
            raise CommandError('No relay-on socket telemetry found in the requested training window.')

        trained = []
        skipped = []
        all_rows = pd.DataFrame(rows)
        all_rows['effective_socket_id'] = all_rows.apply(_effective_socket_id, axis=1)
        all_rows = all_rows[all_rows['effective_socket_id'].notna()].copy()
        all_rows['effective_socket_id'] = all_rows['effective_socket_id'].astype(int)
        if all_rows.empty:
            raise CommandError('No telemetry rows matched the active socket hardware mapping.')
        for (device_id, socket_id), group in all_rows.groupby(['device_id', 'effective_socket_id']):
            readings = [
                TelemetryReading(
                    id=int(row['id']),
                    device_id=str(device_id),
                    socket_id=int(socket_id),
                    timestamp=row['timestamp'],
                    current=float(row['current'] or 0.0),
                    power=float(row['power'] or 0.0),
                )
                for row in group.to_dict('records')
            ]
            frame = build_feature_frame(readings)
            if len(frame) < bootstrap_min_rows:
                skipped.append((device_id, int(socket_id), len(frame), 'not enough rows'))
                continue
            cutoff_ready = len(frame) >= min_rows

            frame['label'] = _label_group(frame)
            X = frame[FEATURE_COLUMNS]
            y = frame['label']
            model = RandomForestClassifier(
                n_estimators=220,
                max_depth=14,
                min_samples_leaf=2,
                class_weight='balanced_subsample',
                random_state=42,
                n_jobs=n_jobs,
            )
            model.fit(X, y)
            predictions = model.predict(X)
            report = classification_report(y, predictions, output_dict=True, zero_division=0)

            output = socket_model_path(str(device_id), int(socket_id))
            output.parent.mkdir(parents=True, exist_ok=True)
            bundle = {
                'model': model,
                'features': FEATURE_COLUMNS,
                'device_id': str(device_id),
                'socket_id': int(socket_id),
                'model_version': f"socket-rf-{timezone.now().strftime('%Y%m%d%H%M%S')}",
                'trained_at': timezone.now().isoformat(),
                'training_rows': int(len(frame)),
                'training_window_days': days,
                'cutoff_ready': cutoff_ready,
                'minimum_rows_for_cutoff': min_rows,
                'label_counts': y.value_counts().to_dict(),
                'classification_report': report,
            }
            joblib.dump(bundle, output)
            trained.append((device_id, int(socket_id), len(frame), output, bundle['label_counts'], cutoff_ready))

        clear_socket_model_cache()
        if not trained:
            raise CommandError(
                f'No socket models were trained. Skipped groups: {skipped or "none"}.'
            )

        for device_id, socket_id, count, output, labels, cutoff_ready in trained:
            if cutoff_ready:
                self.stdout.write(self.style.SUCCESS(
                    f'Trained {device_id} socket {socket_id}: {output} ({count} rows, labels={labels})'
                ))
            else:
                self.stdout.write(self.style.WARNING(
                    f'Trained bootstrap model for {device_id} socket {socket_id}: {output} '
                    f'({count}/{min_rows} rows, labels={labels}). Confidence is capped until retrained with enough data.'
                ))
        for device_id, socket_id, count, reason in skipped:
            self.stdout.write(
                f'Skipped {device_id} socket {socket_id}: {reason} ({count}/{bootstrap_min_rows} rows).'
            )
