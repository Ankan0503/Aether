from django.urls import path

from . import views


urlpatterns = [
    path('public-key/', views.public_key, name='notifications_public_key'),
    path('subscribe/', views.subscribe, name='notifications_subscribe'),
    path('unsubscribe/', views.unsubscribe, name='notifications_unsubscribe'),
    path('test/', views.test_notification, name='notifications_test'),
    path('hazard/', views.hazard_notification, name='notifications_hazard'),
]

