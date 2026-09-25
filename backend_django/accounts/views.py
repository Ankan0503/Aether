import json
import uuid
import secrets
from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from .models import Profile
from .jwt_utils import encode_jwt, decode_jwt

# Programmatic migration run
try:
    from django.core.management import call_command
    print("Running programmatic migrations for accounts...")
    call_command('makemigrations', 'accounts', '--noinput')
    call_command('migrate', 'accounts', '--noinput')
    print("Programmatic migrations finished successfully!")
except Exception as migration_err:
    print("Error during programmatic migration run:", migration_err)


def get_or_create_user_profile(user):
    profile, created = Profile.objects.get_or_create(
        user=user,
        defaults={
            "mesh_id": f"aether-mesh-{uuid.uuid4().hex[:8]}",
            "mesh_key": secrets.token_hex(8)
        }
    )
    return profile

def get_user_from_jwt(request):
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ")[1]
    payload = decode_jwt(token)
    if not payload:
        return None
    try:
        return User.objects.get(id=payload.get("user_id"))
    except User.DoesNotExist:
        return None

@csrf_exempt
@require_http_methods(["POST"])
def signup_view(request):
    try:
        data = json.loads(request.body)
        username = data.get("username")
        password = data.get("password")
        email = data.get("email", "")

        if not username or not password:
            return JsonResponse({"error": "Username and password are required."}, status=400)

        if User.objects.filter(username=username).exists():
            return JsonResponse({"error": "Username already exists."}, status=400)

        user = User.objects.create_user(username=username, password=password, email=email)
        profile = get_or_create_user_profile(user)
        
        # Generate JWT Token
        token = encode_jwt({"user_id": user.id})

        return JsonResponse({
            "message": "User created and authenticated.",
            "token": token,
            "username": user.username,
            "mesh_id": profile.mesh_id,
            "mesh_key": profile.mesh_key,
            "is_security_locked": profile.is_security_locked
        }, status=201)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

@csrf_exempt
@require_http_methods(["POST"])
def login_view(request):
    try:
        data = json.loads(request.body)
        username = data.get("username")
        password = data.get("password")

        if not username or not password:
            return JsonResponse({"error": "Username and password are required."}, status=400)

        user = authenticate(username=username, password=password)
        if user is not None:
            profile = get_or_create_user_profile(user)
            # Generate JWT Token
            token = encode_jwt({"user_id": user.id})
            return JsonResponse({
                "message": "Logged in successfully.",
                "token": token,
                "username": user.username,
                "mesh_id": profile.mesh_id,
                "mesh_key": profile.mesh_key,
                "is_security_locked": profile.is_security_locked
            })
        else:
            return JsonResponse({"error": "Invalid credentials."}, status=401)

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

@csrf_exempt
@require_http_methods(["POST", "GET"])
def logout_view(request):
    # In JWT auth, logout is handled by the client destroying the token
    return JsonResponse({"message": "Logged out successfully."})

@require_http_methods(["GET"])
def me_view(request):
    user = get_user_from_jwt(request)
    if user:
        profile = get_or_create_user_profile(user)
        return JsonResponse({
            "authenticated": True,
            "username": user.username,
            "mesh_id": profile.mesh_id,
            "mesh_key": profile.mesh_key,
            "is_security_locked": profile.is_security_locked
        })
    return JsonResponse({"authenticated": False, "error": "Not authenticated"}, status=401)
