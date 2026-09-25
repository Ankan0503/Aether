import json
import logging

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from accounts.views import get_user_from_jwt

from .services.engine import EnergyRecommendationEngine
from .services.history import readings_from_database, readings_from_payload


logger = logging.getLogger(__name__)


def _positive_int(value, default, maximum):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(parsed, maximum))


def _readings_from_request(payload):
    readings = payload.get('readings', [])
    if not isinstance(readings, list):
        raise ValueError('`readings` must be an array.')
    if len(readings) > 20000:
        raise ValueError('`readings` may contain at most 20000 samples.')
    return readings


@csrf_exempt
@require_http_methods(['GET', 'POST'])
def energy_recommendations(request):
    """
    Return AI-style energy recommendations as JSON.

    GET analyzes telemetry stored in the Django/Supabase database. POST may pass
    a `readings` array with optional richer fields such as appliance, pir and
    power_watts for appliance-level analytics.
    """
    try:
        days = _positive_int(request.GET.get('days'), default=30, maximum=180)
        device_id = request.GET.get('device_id')
        user = get_user_from_jwt(request)

        if request.method == 'POST':
            payload = json.loads(request.body.decode('utf-8') or '{}')
            history = readings_from_payload(_readings_from_request(payload))
            days = _positive_int(payload.get('days', days), default=days, maximum=180)
        else:
            payload = {}
            history = readings_from_database(days=days, user=user, device_id=device_id)

        result = EnergyRecommendationEngine().generate(history)
        result['metadata'] = {
            **result.get('metadata', {}),
            'source': 'payload' if request.method == 'POST' else 'database',
            'days_requested': days,
            'device_id': device_id,
            'authenticated': user is not None,
        }
        return JsonResponse(result)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Request body must be valid JSON.'}, status=400)
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)
    except Exception as exc:
        logger.exception('Energy recommendation generation failed: %s', exc)
        return JsonResponse({'error': 'Unable to generate energy recommendations.'}, status=500)
