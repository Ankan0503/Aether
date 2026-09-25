import uuid
import secrets
from django.db import models
from django.contrib.auth.models import User
from django.db.models.signals import post_save
from django.dispatch import receiver

class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    mesh_id = models.CharField(max_length=64, unique=True)
    mesh_key = models.CharField(max_length=64)
    is_security_locked = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.user.username}'s Mesh ({self.mesh_id})"

@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    if created:
        # Generate a unique Mesh ID and a random 16-character secret Key
        mesh_id = f"aether-mesh-{uuid.uuid4().hex[:8]}"
        mesh_key = secrets.token_hex(8) # 16 characters
        Profile.objects.create(user=instance, mesh_id=mesh_id, mesh_key=mesh_key)

@receiver(post_save, sender=User)
def save_user_profile(sender, instance, **kwargs):
    if hasattr(instance, 'profile'):
        instance.profile.save()
