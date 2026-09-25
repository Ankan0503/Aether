import json
import logging
from dataclasses import dataclass

from django.conf import settings

from .models import WebPushSubscription


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PushResult:
    sent: int
    failed: int
    skipped: int
    reason: str = ''


def push_is_configured() -> bool:
    return all([
        getattr(settings, 'WEBPUSH_VAPID_PUBLIC_KEY', ''),
        getattr(settings, 'WEBPUSH_VAPID_PRIVATE_KEY', ''),
        getattr(settings, 'WEBPUSH_VAPID_SUBJECT', ''),
    ])


def send_web_push_to_user(user, payload: dict) -> PushResult:
    if not push_is_configured():
        return PushResult(sent=0, failed=0, skipped=1, reason='Web Push VAPID keys are not configured.')

    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        return PushResult(sent=0, failed=0, skipped=1, reason='pywebpush is not installed.')

    subscriptions = WebPushSubscription.objects.filter(user=user, is_active=True)
    sent = 0
    failed = 0

    for subscription in subscriptions:
        info = {
            'endpoint': subscription.endpoint,
            'keys': {
                'p256dh': subscription.p256dh,
                'auth': subscription.auth,
            },
        }

        try:
            webpush(
                subscription_info=info,
                data=json.dumps(payload),
                vapid_private_key=settings.WEBPUSH_VAPID_PRIVATE_KEY,
                vapid_claims={'sub': settings.WEBPUSH_VAPID_SUBJECT},
            )
            sent += 1
        except WebPushException as exc:
            failed += 1
            status_code = getattr(getattr(exc, 'response', None), 'status_code', None)
            if status_code in {404, 410}:
                subscription.is_active = False
                subscription.save(update_fields=['is_active', 'updated_at'])
            logger.warning('Web Push delivery failed: %s', exc)
        except Exception as exc:
            failed += 1
            logger.exception('Unexpected Web Push delivery error: %s', exc)

    return PushResult(sent=sent, failed=failed, skipped=0)

