import importlib.util
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from anomaly.ml.service import clear_model_cache


class Command(BaseCommand):
    help = 'Create a local bootstrap IsolationForest model artifact for anomaly detection.'

    def add_arguments(self, parser):
        parser.add_argument('--rows', type=int, default=5000)

    def handle(self, *args, **options):
        try:
            trainer_path = Path(settings.BASE_DIR).parent / 'ML' / 'scripts' / 'train_phantom_current_model.py'
            spec = importlib.util.spec_from_file_location('train_phantom_current_model', trainer_path)
            trainer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(trainer)
        except Exception as exc:
            raise CommandError(f'Unable to import trainer: {exc}') from exc

        import sys

        original_argv = sys.argv[:]
        sys.argv = [
            'train_phantom_current_model.py',
            '--synthetic',
            '--limit',
            str(options['rows']),
        ]
        try:
            model_path = trainer.train()
        except Exception as exc:
            raise CommandError(f'Bootstrap training failed: {exc}') from exc
        finally:
            sys.argv = original_argv

        clear_model_cache()
        self.stdout.write(self.style.SUCCESS(f'Model saved to {model_path}'))
