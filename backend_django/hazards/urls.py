from django.urls import path

from .views import hazard_thresholds, predict_hazard


urlpatterns = [
    path('predict/', predict_hazard, name='predict_hazard'),
    path('thresholds/', hazard_thresholds, name='hazard_thresholds'),
]

