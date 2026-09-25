"""
URL configuration for core project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path, include
from telemetry.views import socket_status

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/socket-status/', socket_status, name='api_socket_status'),
    path('api/telemetry/', include('telemetry.urls')),
    path('api/accounts/', include('accounts.urls')),
    path('api/devices/', include('devices.urls')),
    path('api/layout/', include('layout.urls')),
    path('api/anomaly/', include('anomaly.urls')),
    path('api/recommendations/', include('recommendations.urls')),
    path('api/hazards/', include('hazards.urls')),
    path('api/notifications/', include('notifications.urls')),
]
