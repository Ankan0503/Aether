import json
from datetime import timedelta

from django.http import JsonResponse
from django.db.models import Avg, Count, Sum
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from accounts.views import get_user_from_jwt
from telemetry.models import ApplianceStatePrediction, TelemetryReading
from .ml.appliance_state import appliance_model_status
from .ml.service import ModelNotReadyError, model_status, predict_phantom_current


@require_GET
def anomaly_model_status(request):
    status = model_status()
    response_status = 200 if status['ready'] else 503
    return JsonResponse(status, status=response_status)


@require_GET
def appliance_state_model_status(request):
    status = appliance_model_status()
    return JsonResponse(status, status=200 if status['ready'] else 503)


@csrf_exempt
@require_POST
def detect_phantom_current(request):
    """
    REST endpoint for low-latency phantom current detection.

    Expected JSON:
    {
      "current": 0.42,
      "pir": 0,
      "hour_of_day": 23,
      "voltage": 230,
      "sample_window_minutes": 1
    }
    """
    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
        payload.setdefault('hour_of_day', timezone.localtime().hour)
        result = predict_phantom_current(payload)
        return JsonResponse(result)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Request body must be valid JSON.'}, status=400)
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)
    except ModelNotReadyError as exc:
        return JsonResponse({
            'error': str(exc),
            'hint': 'Train a production model from database telemetry before deployment.',
        }, status=503)


def _user_device_filter(request):
    user = get_user_from_jwt(request)
    if not user:
        return None, JsonResponse({'error': 'Unauthorized'}, status=401)
    device_id = request.GET.get('device_id')
    channel = request.GET.get('channel')
    queryset = ApplianceStatePrediction.objects.filter(device_ref__owner=user)
    if device_id:
        queryset = queryset.filter(device_id=device_id)
    if channel:
        queryset = queryset.filter(appliance_channel=channel)
    return queryset, None


@require_GET
def prediction_history(request):
    queryset, error = _user_device_filter(request)
    if error:
        return error
    limit = min(max(int(request.GET.get('limit', 100)), 1), 500)
    rows = queryset.select_related('telemetry', 'device_ref').order_by('-timestamp')[:limit]
    return JsonResponse({
        'predictions': [
            {
                'id': row.id,
                'device_id': row.device_id,
                'device_name': row.device_ref.name if row.device_ref else row.device_id,
                'appliance_id': row.appliance_id,
                'appliance_channel': row.appliance_channel,
                'channel_key': row.channel_key,
                'predicted_state': row.predicted_state,
                'confidence_score': row.confidence_score,
                'action_taken': row.action_taken,
                'reason': row.reason,
                'power': row.telemetry.power,
                'current': row.telemetry.current,
                'pir': row.telemetry.pir,
                'timestamp': row.timestamp.isoformat(),
            }
            for row in rows
        ]
    })


@require_GET
def realtime_appliance_status(request):
    user = get_user_from_jwt(request)
    if not user:
        return JsonResponse({'error': 'Unauthorized'}, status=401)
    latest_by_device = []
    device_ids = (
        ApplianceStatePrediction.objects
        .filter(device_ref__owner=user)
        .values_list('channel_key', flat=True)
        .distinct()
    )
    for channel_key in device_ids:
        prediction = (
            ApplianceStatePrediction.objects
            .filter(device_ref__owner=user, channel_key=channel_key)
            .select_related('telemetry', 'device_ref')
            .order_by('-timestamp')
            .first()
        )
        if prediction:
            latest_by_device.append({
                'device_id': prediction.device_id,
                'device_name': prediction.device_ref.name if prediction.device_ref else prediction.device_id,
                'appliance_id': prediction.appliance_id,
                'appliance_channel': prediction.appliance_channel,
                'channel_key': prediction.channel_key,
                'predicted_state': prediction.predicted_state,
                'confidence_score': prediction.confidence_score,
                'action_taken': prediction.action_taken,
                'current': prediction.telemetry.current,
                'power': prediction.telemetry.power,
                'pir': prediction.telemetry.pir,
                'status': prediction.telemetry.status,
                'timestamp': prediction.timestamp.isoformat(),
            })
    return JsonResponse({'devices': latest_by_device})


@require_GET
def energy_savings(request):
    queryset, error = _user_device_filter(request)
    if error:
        return error
    days = min(max(int(request.GET.get('days', 30)), 1), 180)
    since = timezone.now() - timedelta(days=days)
    waste_states = ['IDLE', 'PHANTOM_LOAD']
    rows = queryset.filter(timestamp__gte=since, predicted_state__in=waste_states).select_related('telemetry')
    wasted_wh = sum(float(row.telemetry.power or 0.0) / 60.0 for row in rows)
    rate = 8.0
    try:
        from django.conf import settings
        rate = float(getattr(settings, 'APPLIANCE_ELECTRICITY_RATE_PER_KWH', 8.0))
    except Exception:
        pass
    monthly_savings = (wasted_wh / 1000.0) * (30.0 / days) * rate
    return JsonResponse({
        'days': days,
        'estimated_waste_wh': round(wasted_wh, 4),
        'estimated_waste_kwh': round(wasted_wh / 1000.0, 4),
        'estimated_monthly_savings': round(monthly_savings, 2),
        'currency': 'INR',
        'cutoff_events': queryset.filter(timestamp__gte=since, action_taken__startswith='RELAY_OFF').count(),
    })


@require_GET
def power_usage_analytics(request):
    user = get_user_from_jwt(request)
    if not user:
        return JsonResponse({'error': 'Unauthorized'}, status=401)
    days = min(max(int(request.GET.get('days', 7)), 1), 90)
    since = timezone.now() - timedelta(days=days)
    readings = TelemetryReading.objects.filter(device_ref__owner=user, timestamp__gte=since)
    by_device = readings.values('device_id').annotate(
        samples=Count('id'),
        avg_power=Avg('power'),
        total_power=Sum('power'),
        avg_current=Avg('current'),
    )
    return JsonResponse({
        'days': days,
        'devices': [
            {
                'device_id': row['device_id'],
                'samples': row['samples'],
                'avg_power': round(float(row['avg_power'] or 0), 4),
                'avg_current': round(float(row['avg_current'] or 0), 4),
                'estimated_wh': round(float(row['total_power'] or 0) / 60.0, 4),
            }
            for row in by_device
        ],
    })


@require_GET
def ai_insights(request):
    queryset, error = _user_device_filter(request)
    if error:
        return error
    limit = min(max(int(request.GET.get('limit', 20)), 1), 100)
    rows = queryset.select_related('telemetry', 'device_ref').order_by('-timestamp')[:limit]
    insights = []
    for row in rows:
        name = row.device_ref.name if row.device_ref else row.device_id
        if row.predicted_state == 'IDLE':
            message = f'{name} appears idle while still consuming {row.telemetry.power:.1f}W.'
        elif row.predicted_state == 'PHANTOM_LOAD':
            message = f'Standby power consumption detected on {name}.'
        elif row.predicted_state == 'ABNORMAL':
            message = f'{name} behavior deviates from its learned pattern.'
        else:
            message = f'{name} is actively consuming {row.telemetry.power:.1f}W.'
        if row.action_taken:
            message = f'{message} Automatic power cutoff executed.'
        insights.append({
            'device_id': row.device_id,
            'appliance_id': row.appliance_id,
            'appliance_channel': row.appliance_channel,
            'channel_key': row.channel_key,
            'predicted_state': row.predicted_state,
            'message': message,
            'confidence_score': row.confidence_score,
            'timestamp': row.timestamp.isoformat(),
        })
    return JsonResponse({'insights': insights})
