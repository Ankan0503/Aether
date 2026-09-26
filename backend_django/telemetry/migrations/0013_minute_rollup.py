"""Re-bucket the socket rollup from hours to minutes.

An hourly aggregate with a one-hour end_offset shows nothing until the first
whole hour has passed and been materialised. That is right for a system that
has been running for weeks and wrong for one you are watching now - and for a
demo it means an empty chart for up to an hour after switching a socket on.

Minute buckets with a one-minute end_offset and a 30-second refresh mean data
appears within about two minutes. The trade is storage: 60x more rollup rows
than hourly. At three sockets that is ~4,300 rows a day, a few hundred KB
against a 750MB tier, so it costs little. The raw readings are unaffected - the
deadband policy still governs those.

Nothing about correctness changes. time_weight() still handles the irregular
sampling, and the hourly and daily views the API serves are built by
date_trunc() over these minute rows.
"""

from django.db import migrations


DROP_OLD = """
DROP MATERIALIZED VIEW IF EXISTS telemetry_socket_hourly;
"""

CREATE_MINUTE = """
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_socket_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 minute', timestamp) AS bucket,
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

# end_offset of one minute keeps the still-filling bucket out of the view, so a
# partial minute is never served as if complete.
ADD_POLICY = """
SELECT add_continuous_aggregate_policy('telemetry_socket_hourly',
    start_offset      => INTERVAL '2 hours',
    end_offset        => INTERVAL '1 minute',
    schedule_interval => INTERVAL '30 seconds',
    if_not_exists     => TRUE
);
"""

RESTORE_HOURLY = """
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

SELECT add_continuous_aggregate_policy('telemetry_socket_hourly',
    start_offset      => INTERVAL '7 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes',
    if_not_exists     => TRUE
);
"""


def _timescale(schema_editor) -> bool:
    if schema_editor.connection.vendor != 'postgresql':
        return False
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")
        return cursor.fetchone() is not None


def _run(*statements):
    def apply(apps, schema_editor):
        if not _timescale(schema_editor):
            return
        with schema_editor.connection.cursor() as cursor:
            for sql in statements:
                cursor.execute(sql)
    return apply


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ('telemetry', '0012_load_signature'),
    ]

    operations = [
        migrations.RunPython(
            _run(DROP_OLD, CREATE_MINUTE, ADD_POLICY),
            _run(DROP_OLD, RESTORE_HOURLY),
        ),
    ]
