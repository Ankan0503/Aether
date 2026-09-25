"""Delete predictions whose telemetry reading no longer exists.

TelemetryReading is a TimescaleDB hypertable, so ApplianceStatePrediction's
foreign key to it carries db_constraint=False - a hypertable cannot be the
target of a foreign key. Django's ORM still cascades on delete, but the
retention policy drops whole chunks inside the database, which the ORM never
sees. Those predictions are left pointing at rows that are gone.

Nothing breaks: the column is a plain integer and the ORM simply finds nothing.
But the rows accumulate and slowly waste the storage the retention policy was
added to reclaim, so run this periodically - a daily schedule alongside the
retention policy's own cadence is enough.

    python manage.py purge_orphan_predictions
    python manage.py purge_orphan_predictions --dry-run
"""

from django.core.management.base import BaseCommand
from django.db import connection


class Command(BaseCommand):
    help = 'Delete ApplianceStatePrediction rows whose TelemetryReading has been dropped.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Report how many rows would be deleted, without deleting them.',
        )
        parser.add_argument(
            '--batch-size',
            type=int,
            default=10000,
            help='Rows per delete statement, so one purge cannot hold a long lock.',
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        batch_size = options['batch_size']

        count_sql = """
            SELECT count(*)
            FROM telemetry_appliancestateprediction p
            WHERE NOT EXISTS (
                SELECT 1 FROM telemetry_telemetryreading t WHERE t.id = p.telemetry_id
            )
        """
        # Batched by primary key so the anti-join runs against a bounded set
        # rather than the whole prediction table in one statement.
        delete_sql = """
            DELETE FROM telemetry_appliancestateprediction
            WHERE id IN (
                SELECT p.id
                FROM telemetry_appliancestateprediction p
                WHERE NOT EXISTS (
                    SELECT 1 FROM telemetry_telemetryreading t WHERE t.id = p.telemetry_id
                )
                LIMIT %s
            )
        """

        with connection.cursor() as cursor:
            cursor.execute(count_sql)
            orphans = cursor.fetchone()[0]

            if orphans == 0:
                self.stdout.write(self.style.SUCCESS('No orphaned predictions.'))
                return

            if dry_run:
                self.stdout.write(f'{orphans} orphaned prediction(s) would be deleted.')
                return

            deleted = 0
            while True:
                cursor.execute(delete_sql, [batch_size])
                if cursor.rowcount <= 0:
                    break
                deleted += cursor.rowcount
                self.stdout.write(f'  deleted {deleted}/{orphans}...')

        self.stdout.write(self.style.SUCCESS(f'Deleted {deleted} orphaned prediction(s).'))
