"""Keep physically impossible readings out of the rollup.

The subnode used to publish raw ADC RMS counts in the telemetry `current` field
while the backend computed `power = current * voltage`. A floating sensor input
on socket 1 read ~1945 counts, which became "1945 A" and 448 kW, and once that
landed in a continuous aggregate it set the peak for every range that touched it.

The firmware now converts counts to amps and rejects readings the ADC cannot
represent, so no new row can look like that. This is the matching guard on the
storage side, for the rows already written and for anything that slips past:

    the sensor is an ACS712-30A, so a reading above 30 A is not a large load, it
    is a units or wiring fault

30 A is the part's full scale, not a tuned threshold. Raw readings are left
exactly as they are - they are the evidence that the fault happened - they are
simply not treated as measurements of consumption.

This cannot filter everything. A disconnected sensor that happens to read within
0-30 A is indistinguishable from a real load by magnitude alone, which is why
the node reports the fault itself rather than relying on a bound here.
"""

from django.db import migrations


DROP = "DROP MATERIALIZED VIEW IF EXISTS telemetry_socket_hourly;"

CREATE = """
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
WHERE current <= 30.0
GROUP BY bucket, device_id, socket_id
WITH NO DATA;
"""

POLICY = """
SELECT add_continuous_aggregate_policy('telemetry_socket_hourly',
    start_offset      => INTERVAL '2 hours',
    end_offset        => INTERVAL '1 minute',
    schedule_interval => INTERVAL '30 seconds',
    if_not_exists     => TRUE
);
"""

# Materialise what is on disk now so the chart is populated immediately rather
# than waiting for the policy's next run.
BACKFILL = """
CALL refresh_continuous_aggregate('telemetry_socket_hourly',
    now() - INTERVAL '7 days', now() - INTERVAL '1 minute');
"""

UNBOUNDED = CREATE.replace("WHERE current <= 30.0\n", "")


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
        ('telemetry', '0013_minute_rollup'),
    ]

    operations = [
        migrations.RunPython(
            _run(DROP, CREATE, POLICY, BACKFILL),
            _run(DROP, UNBOUNDED, POLICY),
        ),
    ]
