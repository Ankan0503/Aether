from django.urls import path

from .views import (
    ai_insights,
    anomaly_model_status,
    appliance_state_model_status,
    detect_phantom_current,
    energy_savings,
    power_usage_analytics,
    prediction_history,
    realtime_appliance_status,
)


urlpatterns = [
    path('status/', anomaly_model_status, name='anomaly_model_status'),
    path('phantom-current/', detect_phantom_current, name='detect_phantom_current'),
    path('appliance-state/status/', appliance_state_model_status, name='appliance_state_model_status'),
    path('appliance-state/history/', prediction_history, name='appliance_prediction_history'),
    path('appliance-state/current/', realtime_appliance_status, name='realtime_appliance_status'),
    path('appliance-state/insights/', ai_insights, name='appliance_ai_insights'),
    path('appliance-state/savings/', energy_savings, name='appliance_energy_savings'),
    path('appliance-state/power-usage/', power_usage_analytics, name='appliance_power_usage_analytics'),
]
