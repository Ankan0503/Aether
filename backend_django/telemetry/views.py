from django.conf import settings
from django.http import JsonResponse
from django.db.models import Q
from django.views.decorators.http import require_GET

from anomaly.ml.socket_state import predict_socket_state
from . import live_state
from .models import MLPrediction, TelemetryReading

def get_latest_telemetry(request):
    from django.db import close_old_connections
    from devices.models import Device
    from accounts.views import get_user_from_jwt
    try:
        close_old_connections()
        
        # Authenticate using Bearer token
        user = get_user_from_jwt(request)
        if not user:
            return JsonResponse({
                "gas": 0,
                "current": 0,
                "power": 0,
                "pir": 1,
                "flame": 1,
                "status": "SAFE",
                "timestamp": None,
                "device_mac": None,
                "device_name": "No Account Connected"
            })
            
        # Get devices registered to this user
        user_devices = Device.objects.filter(owner=user, is_paired=True)
        if not user_devices.exists():
            return JsonResponse({
                "gas": 0,
                "current": 0,
                "power": 0,
                "pir": 1,
                "flame": 1,
                "status": "SAFE",
                "timestamp": None,
                "device_mac": None,
                "device_name": "No Devices Registered"
            })

        latest_readings = []
        for dev in user_devices:
            # Live state first. It is always current, costs no query, and is the
            # only source when TELEMETRY_PERSIST is off - the dashboard should
            # show what is happening now regardless of what we chose to store.
            live = live_state.latest_for(dev.mac_address, str(dev.id), max_age_seconds=15)
            if live is not None:
                latest_readings.append(live)
                continue

            try:
                # Prefer the device FK, but include legacy id/mac rows.
                r = TelemetryReading.objects.filter(
                    Q(device_ref=dev) | Q(device_id=dev.mac_address) | Q(device_id=str(dev.id))
                ).latest('timestamp')

                # Only consider it active if seen in the last 15 seconds
                from django.utils import timezone
                if (timezone.now() - r.timestamp).total_seconds() < 15:
                    latest_readings.append(r)
            except TelemetryReading.DoesNotExist:
                continue

        if not latest_readings:
            # Fallback to the absolute latest reading if no active ones in the last 15 seconds
            try:
                legacy_ids = [str(d.id) for d in user_devices]
                mac_ids = [d.mac_address for d in user_devices]
                latest = TelemetryReading.objects.filter(
                    Q(device_ref__in=user_devices) | Q(device_id__in=legacy_ids) | Q(device_id__in=mac_ids)
                ).latest('timestamp')
                latest_readings = [latest]
            except TelemetryReading.DoesNotExist:
                return JsonResponse({
                    "gas": 0,
                    "current": 0,
                    "power": 0,
                    "pir": 1,
                    "flame": 1,
                    "status": "SAFE",
                    "timestamp": None,
                    "device_mac": None,
                    "device_name": "No Active Telemetry"
                })

        # Aggregate values across active devices
        max_gas = max(r.gas for r in latest_readings)
        min_flame = min(r.flame for r in latest_readings) # Active-LOW: 0 means fire, 1 means safe
        max_current = max(r.current for r in latest_readings)
        max_power = max(r.power for r in latest_readings)
        min_pir = min(r.pir for r in latest_readings) # 0 means at least one active device reports no occupancy
        
        # Propagate warning statuses if any active device has it
        status = "SAFE"
        for r in latest_readings:
            if r.status in ["GAS_LEAK", "FIRE_EMERGENCY", "OVERCURRENT_TRIP"]:
                status = r.status
                break

        # Use the absolute latest reading to populate metadata (mac, name, timestamp)
        absolute_latest = max(latest_readings, key=lambda r: r.timestamp)

        data = {
            "gas": max_gas,
            "current": max_current,
            "power": max_power,
            "pir": min_pir,
            "flame": min_flame,
            "status": status,
            "timestamp": absolute_latest.timestamp.isoformat(),
            "device_mac": absolute_latest.device_ref.mac_address if absolute_latest.device_ref else absolute_latest.device_id,
            "device_name": absolute_latest.device_ref.name if absolute_latest.device_ref else absolute_latest.device_id
        }
    except Exception as e:
        print(f"Error fetching latest telemetry: {e}")
        data = {
            "gas": 0,
            "current": 0,
            "power": 0,
            "pir": 1,
            "flame": 1,
            "status": "SAFE",
            "timestamp": None,
            "device_mac": None,
            "device_name": "No Active Telemetry"
        }
    return JsonResponse(data)

def debug_telemetry(request):
    readings = TelemetryReading.objects.all().order_by('-id')[:40]
    data = []
    for r in readings:
        pred = getattr(r, 'prediction', None)
        data.append({
            "id": r.id,
            "device_id": r.device_id,
            "appliance_id": r.appliance_id,
            "socket_id": r.socket_id,
            "appliance_name": r.appliance.name if r.appliance else "Global",
            "current": r.current,
            "power": r.power,
            "c1": r.c1,
            "c2": r.c2,
            "c3": r.c3,
            "c4": r.c4,
            "predicted_state": pred.predicted_state if pred else "N/A",
            "action_taken": pred.action_taken if pred else "",
            "reason": pred.reason if pred else "",
            "timestamp": r.timestamp.isoformat()
        })
    return JsonResponse({"readings": data})


@require_GET
def socket_status(request):
    device_id = request.GET.get('device_id')
    socket_id = request.GET.get('socket_id')

    if device_id and socket_id:
        try:
            status = predict_socket_state(device_id, int(socket_id))
            return JsonResponse({
                'device_id': status['device_id'],
                'socket_id': status['socket_id'],
                'state': status['state'],
                'confidence': status['confidence'],
            })
        except (ValueError, TelemetryReading.DoesNotExist) as exc:
            return JsonResponse({'error': str(exc)}, status=404)

    latest = MLPrediction.objects.order_by('-created_at').first()
    if latest is None:
        return JsonResponse({'error': 'No socket predictions are available yet.'}, status=404)

    return JsonResponse({
        'device_id': latest.device_id,
        'socket_id': latest.socket_id,
        'state': latest.predicted_state,
        'confidence': round(float(latest.confidence), 2),
    })


@require_GET
def load_signatures(request):
    """What is plugged into each socket, with the waveform behind the verdict.

    Returns the newest signature per socket for the caller's paired devices.
    `cycle` is the 64-point averaged mains cycle, normalised to its own peak,
    so the dashboard can draw the trace rather than only print a label - the
    evidence and the conclusion together.
    """
    from accounts.views import get_user_from_jwt
    from devices.models import Device

    from .waveform import latest_signatures

    user = get_user_from_jwt(request)
    if not user:
        return JsonResponse({'error': 'Authentication required.'}, status=401)

    macs = list(
        Device.objects.filter(owner=user, is_paired=True)
        .values_list('mac_address', flat=True)
    )
    if not macs:
        return JsonResponse({'sockets': []})

    sockets = []
    for (device_id, socket_id), row in sorted(latest_signatures(macs).items()):
        sockets.append({
            'device_id': device_id,
            'socket_id': socket_id,
            'label': row.label,
            'description': row.get_label_display(),
            'confidence': round(row.confidence, 3),
            'source': row.source,
            'reason': row.reason,
            'features': {
                'crest': round(row.crest, 3),
                'form_factor': round(row.form_factor, 3),
                'conduction': round(row.conduction, 3),
                'thd': round(row.thd, 3),
                'h3': round(row.h3, 3),
                'h5': round(row.h5, 3),
            },
            'amplitude_adc_rms': round(row.rms_adc, 2),
            'cycle': row.cycle,
            'timestamp': row.timestamp.isoformat(),
        })

    return JsonResponse({'sockets': sockets})


@require_GET
def socket_history(request):
    """Per-socket energy history, served from the TimescaleDB continuous aggregate.

    Query: ?range=daily|weekly|monthly&socket_id=N

    Reads telemetry_socket_hourly rather than the raw table. The rollup is
    maintained incrementally, so a month of history is a few hundred
    pre-computed rows instead of a scan over millions - which is what lets a
    time range redraw instantly rather than after a pause.

    The aggregate stores time_weight() rather than a plain average, because
    readings are written on change plus a heartbeat rather than at a fixed rate
    (see store_policy.py). A plain avg() would be biased toward whichever state
    produced more rows - measured at 75 W against a true 50 W on a load that ran
    half an hour. average() and integral() over the weighted summary give the
    honest watts and watt-hours.

    When there is no data it returns an empty series and says why. It never
    invents a curve: a chart that looks like evidence has to be evidence.
    """
    from django.db import connection

    from accounts.views import get_user_from_jwt
    from devices.models import Device

    user = get_user_from_jwt(request)
    if not user:
        return JsonResponse({'error': 'Authentication required.'}, status=401)

    # The aggregate buckets by the minute, so 'live' serves its rows directly and
    # the wider ranges are date_trunc'd up from them. 'live' is what makes the
    # chart fill within a couple of minutes of switching a socket on instead of
    # staying blank until an hour has elapsed.
    ranges = {
        'live': ('60 minutes', 'minute', '%H:%M'),
        'hourly': ('6 hours', 'minute', '%H:%M'),
        'daily': ('1 day', 'hour', '%H:00'),
        'weekly': ('7 days', 'day', '%a'),
        'monthly': ('30 days', 'day', '%d %b'),
        'yearly': ('365 days', 'month', '%b %Y'),
    }
    key = str(request.GET.get('range', 'live')).lower()
    window, bucket, fmt = ranges.get(key, ranges['daily'])

    macs = list(
        Device.objects.filter(owner=user, is_paired=True)
        .values_list('mac_address', flat=True)
    )
    if not macs:
        return JsonResponse({'range': key, 'points': [], 'total_wh': 0.0,
                             'note': 'No paired devices yet.'})

    filters = ['device_id = ANY(%s)', f"bucket > now() - INTERVAL '{window}'"]
    params = [macs]

    socket_id = request.GET.get('socket_id')
    if socket_id:
        filters.append('socket_id = %s')
        params.append(int(socket_id))
    else:
        # Ingestion stores a combined device reading (socket_id NULL) alongside
        # one row per socket, so summing everything adds the total to its own
        # parts - which is how this briefly reported an average above its own
        # peak. The per-socket rows are what the zones represent, so those are
        # the series that get summed.
        filters.append('socket_id IS NOT NULL')

    # Two stages, and the split is not cosmetic.
    #
    # rollup() recombines time-weighted summaries ALONG TIME, and it requires the
    # summaries it is given to be non-overlapping. Within one (device, socket)
    # series the minute buckets satisfy that, so a day can be rebuilt from its
    # minutes without touching the raw readings - that is the whole point of the
    # aggregate.
    #
    # Grouping several sockets into one slot does not satisfy it: those series run
    # in PARALLEL, covering the same wall-clock minute, and the toolkit rejects it
    # with OrderError rather than returning a quietly wrong number. It is right to
    # refuse. Three sockets drawing at once is not one longer measurement, and
    # time-weighting them together would mean nothing.
    #
    # So: roll up along time per series first, then sum across series. Total watts
    # is the sum of each socket's watts, and total watt-hours the sum of each
    # socket's energy, which is what the dashboard is actually claiming to show.
    sql = f"""
        WITH per_series AS (
            SELECT date_trunc('{bucket}', bucket)      AS slot,
                   device_id,
                   socket_id,
                   average(rollup(power_tw))           AS avg_w,
                   integral(rollup(power_tw), 'hours') AS wh,
                   max(peak_power)                     AS peak_w,
                   sum(samples)                        AS samples
            FROM telemetry_socket_hourly
            WHERE {' AND '.join(filters)}
            GROUP BY slot, device_id, socket_id
        )
        SELECT slot,
               sum(avg_w)   AS avg_w,
               sum(wh)      AS wh,
               -- Upper bound: per-socket peaks need not have been simultaneous.
               -- max() would understate the total and can fall below the mean,
               -- which is worse than a bound that is honest about being one.
               sum(peak_w)  AS peak_w,
               sum(samples) AS samples
        FROM per_series
        GROUP BY slot
        ORDER BY slot
    """

    points, total_wh = [], 0.0
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql, params)
            for slot, avg_w, wh, peak_w, samples in cursor.fetchall():
                watt_hours = float(wh or 0.0)
                total_wh += watt_hours
                points.append({
                    'name': slot.strftime(fmt),
                    'timestamp': slot.isoformat(),
                    'value': round(float(avg_w or 0.0), 2),
                    'watt_hours': round(watt_hours, 3),
                    'peak': round(float(peak_w or 0.0), 2),
                    'samples': int(samples or 0),
                })
    except Exception as exc:  # noqa: BLE001 - a cold aggregate must not 500
        return JsonResponse({'range': key, 'points': [], 'total_wh': 0.0,
                             'note': f'History not available yet: {exc}'})

    tariff = float(getattr(settings, 'TARIFF_RUPEES_PER_KWH', 8.0))
    return JsonResponse({
        'range': key,
        'bucket': bucket,
        'points': points,
        'total_wh': round(total_wh, 3),
        'cost': round(total_wh / 1000.0 * tariff, 2),
        'note': '' if points else 'No readings stored for this range yet.',
    })
