# TigerData / TimescaleDB in Aether

Aether's telemetry lives in **Tiger Cloud** — managed PostgreSQL with the
**TimescaleDB** and **timescaledb_toolkit** extensions. Django talks to it as an
ordinary Postgres database; everything Timescale-specific is applied through
migrations, so a plain Postgres (or SQLite) still works and simply skips those
steps.

Connection comes from one environment variable:

```
DATABASE_URL=postgres://<user>:<password>@<host>.tsdb.cloud.timescale.com:<port>/tsdb?sslmode=require
```

Read in `backend_django/core/settings.py` via `dj_database_url`, with
`ssl_require = True`.

---

## 1. Why a time-series database at all

Three subnodes publishing every 2 seconds is ~130,000 rows a day. The dashboard
asks questions that are all shaped the same way — *"average watts per socket over
the last hour / day / month"* — and on a plain table every one of those is a scan
over everything ever recorded, getting slower each day the system runs.

Timescale answers that with three things we use directly:

| Feature | What it does for us |
|---|---|
| **Hypertable** | Partitions readings by day automatically, so a query for "today" never touches last month |
| **Continuous aggregate** | Keeps a per-minute rollup up to date incrementally, so a month of history is a few hundred pre-computed rows instead of millions of raw ones |
| **Compression** | Readings older than 7 days are columnar-compressed |
| **Retention** | Raw readings are dropped after 90 days; the rollup survives |

And one thing from the toolkit that matters more than all of them, explained in
section 4.

---

## 2. What we store

### `telemetry_telemetryreading` — the hypertable

One row per reading, per device, per socket.

| Column | Meaning |
|---|---|
| `timestamp` | Partitioning column, 1-day chunks |
| `device_id` | Node MAC, e.g. `70:4B:CA:58:53:D8` |
| `socket_id` | 1–3, or `NULL` for the device-level combined reading |
| `current` | **Amps.** Converted on the node — see the note below |
| `power` | Watts, `current * 230 V` nominal |
| `gas`, `flame`, `pir` | Kitchen sensors and occupancy |
| `status` | `SAFE`, `GAS_LEAK`, `FIRE_EMERGENCY`, `OVERCURRENT_TRIP` |
| `c1`–`c4`, `channel` | Per-channel currents as the node sends them |

> **Note on `current`:** the subnode used to publish raw ADC counts here while the
> backend computed `power = current * voltage`. That made an empty socket read
> ~530 W and a 100 W bulb read 8.8 kW. The node now converts to amps
> (`wfAdcToAmps`, 81.9 counts/A for an ACS712-30A) and reports zero both below the
> noise floor and above what the ADC can physically represent. Migration `0014`
> is the matching guard on the storage side.

Not every reading is stored. `telemetry/store_policy.py` writes a row only when
something **changed beyond a deadband** or a **60-second heartbeat** is due —
except safety-relevant readings, which are always stored. That keeps the table
small without losing anything that matters, and it is the reason section 4 exists.

### `telemetry_loadsignature` — what is plugged in

One row per classified waveform capture.

| Column | Meaning |
|---|---|
| `label` | `RESISTIVE` / `SMPS` / `MIXED` / `NONE` |
| `confidence`, `reason` | Verdict and the sentence explaining it |
| `crest`, `form_factor`, `conduction`, `thd`, `h3`, `h5` | Shape features, all scale-invariant |
| `rms_adc` | Raw amplitude, for reference |
| `cycle` | **The 64-point averaged mains cycle itself**, as JSON |
| `device_label` | What the node decided, kept to compare against the server's verdict |

Storing `cycle` is deliberate: the dashboard draws the actual waveform, so the
evidence ships with the conclusion rather than just the label.

### `telemetry_mlprediction`, `telemetry_appliancestateprediction`

Socket state predictions with confidence and the action taken.

### `telemetry_socket_hourly` — the continuous aggregate

Despite the name (kept so existing queries don't break), this now buckets by the
**minute**. One row per minute, per device, per socket:

```sql
time_bucket(INTERVAL '1 minute', timestamp) AS bucket,
time_weight('LOCF', timestamp, power)   AS power_tw,
time_weight('LOCF', timestamp, current) AS current_tw,
max(power)   AS peak_power,
max(current) AS peak_current,
min(power)   AS min_power,
count(*)     AS samples
WHERE current <= 30.0
```

Refreshed every 30 seconds, with a 1-minute `end_offset` so a still-filling
bucket is never served as if complete.

**Why minutes and not hours:** an hourly aggregate with a one-hour `end_offset`
shows nothing until a whole hour has passed and been materialised. Correct for a
system running for weeks, useless for one you are watching now — and for a demo
it meant a blank chart for up to an hour. Minute buckets cost 60× more rollup
rows, which at three sockets is ~4,300 rows/day — a few hundred KB.

**Why the `current <= 30.0` filter:** an ACS712-30A cannot read above 30 A, so
anything higher is a units or wiring fault, not a load. A floating sensor input
once read 1945 counts, which became "1945 A" and 448 kW, and set the peak for
every range that touched it. Raw rows are left untouched — they are the evidence
that the fault happened — they are just not treated as measurements of
consumption.

---

## 3. The migrations

| Migration | What it does |
|---|---|
| `0011_timescale_hypertable` | `create_hypertable` (1-day chunks), compression after 7 days, retention at 90 days, first continuous aggregate |
| `0012_load_signature` | The `LoadSignature` table |
| `0013_minute_rollup` | Re-buckets the aggregate from hours to minutes, 30s refresh |
| `0014_credible_rollup` | Adds the `current <= 30.0` bound and backfills |

All of them are `atomic = False` and check for the extension first, so they no-op
cleanly on plain Postgres or SQLite:

```python
cursor.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")
```

Two Timescale constraints shaped the schema: a hypertable's primary key **must**
include the partitioning column, and a hypertable **cannot** be the target of a
foreign key.

---

## 4. `time_weight()` — the part that actually matters

This is the strongest technical reason Aether uses Timescale rather than any
time-series store, and it is worth being able to explain out loud.

Readings are written **on change plus a heartbeat**, not at a fixed rate. So a
socket that sits at 50 W for 30 minutes might produce 2 rows, while the same
socket flickering around 75 W for 30 seconds produces 20. A plain `avg(power)`
counts rows, so it would report roughly **75 W** — biased entirely toward
whichever state was noisier — when the honest answer is close to **50 W**.

`time_weight('LOCF', timestamp, power)` weights each reading by **how long it was
true for**, which is what an irregularly-sampled signal requires. Then:

- `average(rollup(power_tw))` → honest average watts
- `integral(rollup(power_tw), 'hours')` → honest watt-hours

**One subtlety worth knowing:** `rollup()` recombines summaries **along time**,
and requires them not to overlap. Within one `(device, socket)` series the minute
buckets satisfy that, so a day rebuilds from its minutes without touching raw
readings. Grouping *several sockets* into one slot does **not** — those series run
in parallel over the same wall-clock minute, and the toolkit rejects it with
`OrderError` rather than returning a quietly wrong number. So `socket_history`
rolls up along time per series first, then sums across series:

```sql
WITH per_series AS (
    SELECT date_trunc('hour', bucket) AS slot, device_id, socket_id,
           average(rollup(power_tw))           AS avg_w,
           integral(rollup(power_tw), 'hours') AS wh
    FROM telemetry_socket_hourly
    WHERE ...
    GROUP BY slot, device_id, socket_id
)
SELECT slot, sum(avg_w), sum(wh) FROM per_series GROUP BY slot ORDER BY slot
```

Total watts is the sum of each socket's watts. Total watt-hours is the sum of
each socket's energy.

---

## 5. How to see the data

### From the dashboard

- **Energy Zones → a socket → Live / Daily / Weekly / Monthly** — reads the
  continuous aggregate through `/api/telemetry/history/`
- **Live Current Waveform** — reads `telemetry_loadsignature` through
  `/api/telemetry/signatures/`

### From the API

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8000/api/telemetry/history/?range=live&socket_id=3"
```

Ranges: `live` (60 min, minute buckets), `hourly`, `daily`, `weekly`, `monthly`,
`yearly`. Add `socket_id` for one socket; omit it for the total across sockets.

### From Django

```bash
cd backend_django
./venv/Scripts/python.exe manage.py shell
```

```python
from telemetry.models import TelemetryReading, LoadSignature
TelemetryReading.objects.count()
LoadSignature.objects.order_by('-timestamp').first().label
```

### Straight SQL

Connect with `psql "$DATABASE_URL"`, or Tiger Cloud's own web console.

```sql
-- newest rollup rows, per socket
SELECT bucket, socket_id,
       round(average(power_tw)::numeric, 1)           AS avg_w,
       round(integral(power_tw, 'hours')::numeric, 3) AS wh,
       samples
FROM telemetry_socket_hourly
ORDER BY bucket DESC, socket_id
LIMIT 20;

-- is the hypertable healthy?
SELECT hypertable_name, num_chunks, compression_enabled
FROM timescaledb_information.hypertables;

-- what background jobs are running?
SELECT job_id, proc_name, schedule_interval, next_start
FROM timescaledb_information.jobs;

-- force a rollup refresh instead of waiting 30s
CALL refresh_continuous_aggregate('telemetry_socket_hourly',
     now() - INTERVAL '2 hours', now() - INTERVAL '1 minute');
```

---

## 6. Turning storage off

`TELEMETRY_PERSIST=False` stops rows being written while leaving the live
dashboard working — the dashboard reads `live_state` first, which is always
current and costs no query. Useful when testing hardware without filling the
database with noise.

---

## 7. Current state (verified on the live Tiger Cloud instance)

```
extensions    timescaledb 2.30.1, timescaledb_toolkit 1.26.0
hypertables   telemetry_telemetryreading - 2 chunks, compression enabled
raw rows      6,197
rollup rows   1,239
db size       16 MB
```

The rollup holding 1,239 rows against 6,197 raw readings is the whole argument in
one line: the dashboard's range queries read the smaller number, and that ratio
only widens as the system runs, because raw readings grow continuously while
minute buckets grow at a fixed 3 rows/minute.
