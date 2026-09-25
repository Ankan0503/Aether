from django.core.management.base import BaseCommand, CommandError

from anomaly.ml.service import clear_model_cache, model_status


class Command(BaseCommand):
    help = 'Validate that the anomaly model artifact is loadable and deployment-ready.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--require-production',
            action='store_true',
            help='Fail unless the artifact was trained from database telemetry.',
        )

    def handle(self, *args, **options):
        clear_model_cache()
        status = model_status()

        if not status['ready']:
            raise CommandError(status.get('error', 'Anomaly model is not ready.'))

        if options['require_production'] and not status['production_ready']:
            raise CommandError(status.get('warning', 'Anomaly model is not production-ready.'))

        self.stdout.write(self.style.SUCCESS(
            f"Model {status['model_version']} is ready "
            f"({status['training_source']}, {status['training_rows']} rows)."
        ))
