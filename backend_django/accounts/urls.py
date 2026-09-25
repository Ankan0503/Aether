from django.urls import path
from .views import signup_view, login_view, logout_view, me_view

urlpatterns = [
    path('signup/', signup_view, name='accounts_signup'),
    path('login/', login_view, name='accounts_login'),
    path('logout/', logout_view, name='accounts_logout'),
    path('me/', me_view, name='accounts_me'),
]
