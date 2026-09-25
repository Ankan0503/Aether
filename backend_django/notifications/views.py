import json

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from accounts.views import get_user_from_jwt

from .models import WebPushSubscription
from .services import push_is_configured, send_web_push_to_user


def _current_user(request):
    user = get_user_from_jwt(request)
    if not user:
        return None
    return user


@require_http_methods(['GET'])
def public_key(request):
    return JsonResponse({
        'configured': push_is_configured(),
        'publicKey': getattr(settings, 'WEBPUSH_VAPID_PUBLIC_KEY', ''),
    })


@csrf_exempt
@require_http_methods(['POST'])
def subscribe(request):
    user = _current_user(request)
    if not user:
        return JsonResponse({'error': 'Unauthorized'}, status=401)

    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
        endpoint = payload['endpoint']
        keys = payload['keys']
        subscription, _ = WebPushSubscription.objects.update_or_create(
            endpoint=endpoint,
            defaults={
                'user': user,
                'p256dh': keys['p256dh'],
                'auth': keys['auth'],
                'user_agent': request.headers.get('User-Agent', ''),
                'is_active': True,
            },
        )
        return JsonResponse({'subscribed': True, 'id': subscription.id})
    except (KeyError, TypeError, json.JSONDecodeError):
        return JsonResponse({'error': 'Invalid push subscription payload.'}, status=400)


@csrf_exempt
@require_http_methods(['POST'])
def unsubscribe(request):
    user = _current_user(request)
    if not user:
        return JsonResponse({'error': 'Unauthorized'}, status=401)

    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
        endpoint = payload.get('endpoint')
        if endpoint:
            WebPushSubscription.objects.filter(user=user, endpoint=endpoint).update(is_active=False)
        return JsonResponse({'subscribed': False})
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON payload.'}, status=400)


@csrf_exempt
@require_http_methods(['POST'])
def test_notification(request):
    user = _current_user(request)
    if not user:
        return JsonResponse({'error': 'Unauthorized'}, status=401)

    result = send_web_push_to_user(user, {
        'title': 'AETHER notifications enabled',
        'body': 'Your browser can now receive live mesh safety alerts.',
        'tag': 'aether-test-notification',
        'url': '/',
        'severity': 'info',
    })
    return JsonResponse(result.__dict__)


@csrf_exempt
@require_http_methods(['POST'])
def hazard_notification(request):
    user = _current_user(request)
    if not user:
        return JsonResponse({'error': 'Unauthorized'}, status=401)

    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON payload.'}, status=400)

    hazard_type = payload.get('hazard_type', 'SAFETY_RISK')
    severity = payload.get('severity', 'critical')
    message = payload.get('message', 'A safety risk was detected in your Aether mesh.')

    result = send_web_push_to_user(user, {
        'title': payload.get('title') or f'AETHER {severity.upper()} alert',
        'body': message,
        'tag': f'aether-hazard-{hazard_type}',
        'url': '/?view=safety',
        'severity': severity,
        'riskScore': payload.get('risk_score'),
        'hazardType': hazard_type,
    })
    return JsonResponse(result.__dict__)

