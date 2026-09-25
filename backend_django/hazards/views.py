import json
import logging

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .services.actions import HazardActionPlanner, MqttHazardDispatcher
from .services.scoring import HazardRiskScorer, HazardThresholds


logger = logging.getLogger(__name__)


@csrf_exempt
@require_http_methods(['POST'])
def predict_hazard(request):
    """
    Predict gas/fire hazard risk from MQ2 and flame sensor values.

    JSON body:
    {
      "gas": 3500,
      "flame": 1,
      "device_mac": "AA:BB:CC:DD:EE:FF",
      "trigger_actions": false,
      "thresholds": {"gas_warning": 1600}
    }
    """
    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
        thresholds = HazardThresholds.from_settings().tuned(payload.get('thresholds'))
        prediction = HazardRiskScorer(thresholds).predict(payload)
        actions = HazardActionPlanner(prediction['thresholds']).plan(prediction)
        dispatch = {'published': False, 'reason': 'trigger_actions is false.'}

        if payload.get('trigger_actions') is True:
            dispatch = MqttHazardDispatcher().publish(payload.get('device_mac'), actions['commands'])

        return JsonResponse({
            **prediction,
            'actions': actions,
            'dispatch': dispatch,
        })
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Request body must be valid JSON.'}, status=400)
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)
    except Exception as exc:
        logger.exception('Hazard prediction failed: %s', exc)
        return JsonResponse({'error': 'Unable to predict hazard risk.'}, status=500)


@require_http_methods(['GET'])
def hazard_thresholds(request):
    """Expose active defaults so dashboards can display and tune sensor thresholds."""
    thresholds = HazardThresholds.from_settings()
    thresholds.validate()
    return JsonResponse({'thresholds': thresholds.__dict__})

