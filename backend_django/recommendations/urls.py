from django.urls import path

from .views import energy_recommendations


urlpatterns = [
    path('energy/', energy_recommendations, name='energy_recommendations'),
]
