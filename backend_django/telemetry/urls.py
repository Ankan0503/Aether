from django.urls import path
from .views import get_latest_telemetry, debug_telemetry, socket_status, load_signatures

urlpatterns = [
    path('latest/', get_latest_telemetry, name='latest_telemetry'),
    path('debug/', debug_telemetry, name='debug_telemetry'),
    path('socket-status/', socket_status, name='socket_status'),
    path('signatures/', load_signatures, name='load_signatures'),
]
