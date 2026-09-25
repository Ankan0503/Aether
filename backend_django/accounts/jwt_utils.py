import base64
import hashlib
import hmac
import json
import time
from django.conf import settings

def base64url_encode(data):
    if isinstance(data, dict):
        data = json.dumps(data).encode('utf-8')
    elif isinstance(data, str):
        data = data.encode('utf-8')
    encoded = base64.urlsafe_b64encode(data).decode('utf-8')
    return encoded.rstrip('=')

def base64url_decode(payload):
    padding = '=' * (4 - len(payload) % 4)
    return base64.urlsafe_b64decode(payload + padding)

def encode_jwt(payload, expiry_seconds=86400 * 7): # Default 7 days expiry
    header = {"alg": "HS256", "typ": "JWT"}
    
    # Add expiration time
    payload = payload.copy()
    payload['exp'] = int(time.time()) + expiry_seconds
    
    header_b64 = base64url_encode(header)
    payload_b64 = base64url_encode(payload)
    
    signature_base = f"{header_b64}.{payload_b64}".encode('utf-8')
    signature = hmac.new(
        settings.SECRET_KEY.encode('utf-8'),
        signature_base,
        hashlib.sha256
    ).digest()
    
    signature_b64 = base64url_encode(signature)
    return f"{header_b64}.{payload_b64}.{signature_b64}"

def decode_jwt(token):
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None
            
        header_b64, payload_b64, signature_b64 = parts
        
        # Verify signature
        signature_base = f"{header_b64}.{payload_b64}".encode('utf-8')
        expected_signature = hmac.new(
            settings.SECRET_KEY.encode('utf-8'),
            signature_base,
            hashlib.sha256
        ).digest()
        
        expected_signature_b64 = base64url_encode(expected_signature)
        
        if not hmac.compare_digest(signature_b64, expected_signature_b64):
            return None # Signature mismatch
            
        # Decode payload
        payload_data = base64url_decode(payload_b64).decode('utf-8')
        payload = json.loads(payload_data)
        
        # Check expiration
        if 'exp' in payload and payload['exp'] < time.time():
            return None # Expired
            
        return payload
    except Exception:
        return None
