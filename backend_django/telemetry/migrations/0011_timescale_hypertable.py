"""Turn TelemetryReading into a TimescaleDB hypertable, with an hourly
per-socket continuous aggregate, compression and retention.

Nothing in the Django model changes. The table keeps its name and every existing
query keeps working - the partitioning happens underneath.

Three things needed care:

1. The primary key. TimescaleDB requires every unique index on a hypertable to
   include the partitioning column, and Django's implicit `id` key does not.
   The PK is rebuilt as (timestamp, id): Django still treats `id` as the primary
   key, so the ORM, .save() and .delete() are unaffected.

2. Transactions. `create_hypertable`, continuous aggregates and policies cannot
   run inside a transaction block, so this migration sets atomic = False.

3. Irregular sampling. Telemetry is stored on change plus a heartbeat rather
   than at a fixed rate (see telemetry/store_policy.py), so a plain avg() over a
   bucket would be biased toward whichever state produced more rows. The
   aggregate uses time_weight() from timescaledb_toolkit instead, which weights
   each sample by how long it was in effect - the correct way to average
   irregularly spaced readings, and what makes integral() give true watt-hours.
"""

from django.db import migrations


FORWARD = """
ALTER TABLE telemetry_telemetryreading
    DROP CONSTRAINT telemetry_telemetryreading_pkey;

ALTER TABLE telemetry_telemetryreading
    ADD CONSTRAINT telemetry_telemetryreading_pkey PRIMARY KEY (timestamp, id);

SELECT create_hypertable(
    'telemetry_telemetryreading',
    'timestamp',
    chunk_time_interval => INTERVAL '1 day',
    migrate_data => TRUE,
    if_not_exists => TRUE
);
"""

REVERSE = """
ALTER TABLE telemetry_telemetryreading
    DROP CONSTRAINT telemetry_telemetryreading_pkey;

ALTER TABLE telemetry_telemetryreading
    ADD CONSTRAINT telemetry_telemetryreading_pkey PRIMARY KEY (id);
"""

# Hourly rollup per socket. `WITH NO DATA` so creating it is instant; the policy
# below backfills and keeps it current incrementally - only buckets touched by
# new rows are recomputed, which is what makes a month of history cheap to read.
AGGREGATE = """
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_socket_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 hour', timestamp) AS bucket,
    device_id,
    socket_id,
    time_weight('LOCF', timestamp, power)   AS power_tw,
    time_weight('LOCF', timestamp, current) AS current_tw,
    max(power)   AS peak_power,
    max(current) AS peak_current,
    min(power)   AS min_power,
    count(*)     AS samples
FROM telemetry_telemetryreading
GROUP BY bucket, device_id, socket_id
WITH NO DATA;
"""

AGGREGATE_REVERSE = """
DROP MATERIALIZED VIEW IF EXISTS telemetry_socket_hourly;
"""

# end_offset of one hour keeps the most recent, still-filling bucket out of the
# materialised view, so a partially complete hour is never served as if final.
POLICIES = """
SELECT add_continuous_aggregate_policy('telemetry_socket_hourly',
    start_offset      => INTERVAL '7 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes',
    if_not_exists     => TRUE
);

ALTER TABLE telemetry_telemetryreading SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, socket_id',
    timescaledb.compress_orderby   = 'timestamp DESC'
);

SELECT add_compression_policy('telemetry_telemetryreading',
    INTERVAL '7 days', if_not_exists => TRUE);

SELECT add_retention_policy('telemetry_telemetryreading',
    INTERVAL '90 days', if_not_exists => TRUE);
"""

# Retention is deliberately far longer than the aggregate's 7-day start_offset:
# raw rows must survive long enough to be materialised, or the rollup would lose
# history that can never be rebuilt.
POLICIES_REVERSE = """
SELECT remove_retention_policy('telemetry_telemetryreading', if_exists => TRUE);
SELECT remove_compression_policy('telemetry_telemetryreading', if_exists => TRUE);
SELECT remove_continuous_aggregate_policy('telemetry_socket_hourly', if_not_exists => TRUE);
ALTER TABLE telemetry_telemetryreading SET (timescaledb.compress = FALSE);
"""


def _timescale_available(schema_editor) -> bool:
    """True only on PostgreSQL with the TimescaleDB extension installed.

    Tests run against SQLite - a managed Tiger Cloud service will not let Django
    create the throwaway database its test runner wants - so every statement
    here has to be skipped cleanly on other backends rather than crashing the
    migration.
    """
    if schema_editor.connection.vendor != 'postgresql':
        return False
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")
        return cursor.fetchone() is not None


def _run(sql):
    def apply(apps, schema_editor):
        if not _timescale_available(schema_editor):
            return
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(sql)
    return apply


class Migration(migrations.Migration):
    # create_hypertable, continuous aggregates and policies all refuse to run
    # inside a transaction block.
    atomic = False

    dependencies = [
        ('telemetry', '0010_drop_prediction_fk_constraint'),
    ]

    operations = [
        migrations.RunPython(_run(FORWARD), _run(REVERSE)),
        migrations.RunPython(_run(AGGREGATE), _run(AGGREGATE_REVERSE)),
        migrations.RunPython(_run(POLICIES), _run(POLICIES_REVERSE)),
    ]
