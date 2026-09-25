import uuid

from django.conf import settings
from django.db import models


class Room(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='rooms')
    name = models.CharField(max_length=100)
    floor = models.PositiveSmallIntegerField(default=0)
    grid_x = models.PositiveSmallIntegerField(default=0)
    grid_y = models.PositiveSmallIntegerField(default=0)
    grid_w = models.PositiveSmallIntegerField(default=4)
    grid_h = models.PositiveSmallIntegerField(default=4)
    doors = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['floor', 'grid_y', 'grid_x', 'created_at']
        indexes = [
            models.Index(fields=['owner', 'floor', 'grid_y', 'grid_x']),
        ]

    def __str__(self):
        return f'{self.name} ({self.owner})'
