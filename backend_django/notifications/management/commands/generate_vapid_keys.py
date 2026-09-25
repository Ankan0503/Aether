from django.core.management.base import BaseCommand


def _b64url(data: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


class Command(BaseCommand):
    help = 'Generate a VAPID key pair for Web Push notifications.'

    def handle(self, *args, **options):
        try:
            from py_vapid import Vapid
            from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
        except ImportError:
            self.stderr.write('Install pywebpush first: pip install -r requirements.txt')
            return

        vapid = Vapid()
        vapid.generate_keys()
        private_value = vapid.private_key.private_numbers().private_value
        private_key = private_value.to_bytes(32, 'big')
        public_key = vapid.public_key.public_bytes(
            Encoding.X962,
            PublicFormat.UncompressedPoint,
        )

        # The browser Push API expects the uncompressed public key, while
        # pywebpush accepts the raw private key; both are URL-safe base64.
        self.stdout.write('WEBPUSH_VAPID_PUBLIC_KEY=' + _b64url(public_key))
        self.stdout.write('WEBPUSH_VAPID_PRIVATE_KEY=' + _b64url(private_key))
        self.stdout.write('WEBPUSH_VAPID_SUBJECT=mailto:admin@example.com')
