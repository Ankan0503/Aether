from django.urls import path

from .views import layout_detail


urlpatterns = [
    path('', layout_detail, name='layout_detail'),
]
