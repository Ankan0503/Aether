import importlib.util
from datetime import timedelta
from pathlib import Path

import pandas as pd
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from anomaly.ml.service import clear_model_cache, default_model_path
from telemetry.models import TelemetryReading


class Command(BaseCommand):
    help = 'Train the anomaly model from Django telemetry history.'

    def add_arguments(self, parser):
        window_group = parser.add_mutually_exclusive_group()
        window_group.add_argument('--days', type=int, default=None)
        window_group.add_argument('--hours', type=int, default=None)
        window_group.add_argument('--minutes', type=int, default=None)
        parser.add_argument('--limit', type=int, default=50000)
        parser.add_argument('--min-rows', type=int, default=500)
        parser.add_argument('--contamination', type=float, default=0.03)
        parser.add_argument('--n-jobs', type=int, default=1)
        parser.add_argument('--output', default=str(default_model_path()))
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
            days = days or 90
            training_window = timedelta(days=days)
            window_label = f'{days} day(s)'

        try:
            from django.utils import timezone

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
            ).exclude(current__isnull=True).order_by('-timestamp')[:options['limit']]

            rows = [
                {
                    'current': reading.current,
                    'timestamp': reading.timestamp,
                }
                for reading in queryset
            ]
            history = pd.DataFrame(rows)
        except Exception as exc:
            raise CommandError(f'Unable to load telemetry history: {exc}') from exc

        try:
            trainer_path = Path(settings.BASE_DIR).parent / 'ML' / 'scripts' / 'train_phantom_current_model.py'
            spec = importlib.util.spec_from_file_location('train_phantom_current_model', trainer_path)
            trainer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(trainer)
        except Exception as exc:
            raise CommandError(f'Unable to import trainer: {exc}') from exc

        try:
            model_path = trainer.train_from_frame(
                history=history,
                output_path=options['output'],
                contamination=options['contamination'],
                n_jobs=options['n_jobs'],
                min_rows=options['min_rows'],
                training_source='database',
            )
        except Exception as exc:
            raise CommandError(f'Production training failed: {exc}') from exc

        clear_model_cache()
        self.stdout.write(self.style.SUCCESS(
            f"Production model saved to {model_path} from {len(history)} telemetry rows "
            f"collected over the last {window_label}, {anchor_label}."
        ))
