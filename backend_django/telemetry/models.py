from django.db import models
from devices.models import Device

class TelemetryReading(models.Model):
    device_ref = models.ForeignKey(Device, on_delete=models.CASCADE, null=True, blank=True, related_name='readings')
    device_id = models.CharField(max_length=64)
    gas = models.IntegerField()
    current = models.FloatField()
    power = models.FloatField(default=0.0)
    pir = models.IntegerField(default=1)
    flame = models.IntegerField(default=1)
    status = models.CharField(max_length=50, default="SAFE")
    timestamp = models.DateTimeField(auto_now_add=True)
    c1 = models.FloatField(default=0.0)
    c2 = models.FloatField(default=0.0)
    c3 = models.FloatField(default=0.0)
    c4 = models.FloatField(default=0.0)
    appliance_id = models.IntegerField(null=True, blank=True, db_column='appliance_id')
    channel = models.PositiveSmallIntegerField(null=True, blank=True, db_index=True)
    socket_id = models.PositiveSmallIntegerField(null=True, blank=True, db_index=True)

    @property
    def device(self):
        if not hasattr(self, '_device_cache'):
            self._device_cache = self.device_ref
            if self._device_cache is None and self.device_id:
                try:
                    self._device_cache = Device.objects.get(mac_address=self.device_id)
                except Device.DoesNotExist:
                    self._device_cache = None
        return self._device_cache

    @property
    def appliance(self):
        if not hasattr(self, '_appliance_cache'):
            from devices.models import Appliance
            try:
                self._appliance_cache = Appliance.objects.get(id=int(self.appliance_id)) if self.appliance_id else None
            except (Appliance.DoesNotExist, ValueError):
                self._appliance_cache = None
        return self._appliance_cache

    def __str__(self):
        device_name = self.device.name if self.device else (self.device_id or "Legacy Device")
        appliance_name = f" - {self.appliance.name}" if self.appliance else ""
        return f"{device_name}{appliance_name} ({self.status}) at {self.timestamp}"


class ApplianceStatePrediction(models.Model):
    STATE_ACTIVE = 'ACTIVE'
    STATE_IDLE = 'IDLE'
    STATE_PHANTOM_LOAD = 'PHANTOM_LOAD'
    STATE_ABNORMAL = 'ABNORMAL'
    STATE_CHOICES = [
        (STATE_ACTIVE, 'Active'),
        (STATE_IDLE, 'Idle'),
        (STATE_PHANTOM_LOAD, 'Phantom Load'),
        (STATE_ABNORMAL, 'Abnormal'),
    ]

    # db_constraint=False because TelemetryReading is a TimescaleDB hypertable,
    # and a hypertable cannot be the target of a foreign key - the referenced
    # unique index has to include the partitioning column, which a plain `id`
    # reference cannot. The relation, the column and Django's own cascade on
    # delete all still work; only the database-level constraint is dropped.
    #
    # The catch: the retention policy drops old telemetry chunks in the
    # database, bypassing the ORM, so predictions pointing at dropped readings
    # are left orphaned. purge_orphan_predictions clears them.
    telemetry = models.OneToOneField(
        TelemetryReading,
        on_delete=models.CASCADE,
        related_name='prediction',
        db_constraint=False,
    )
    device_ref = models.ForeignKey(Device, on_delete=models.SET_NULL, null=True, blank=True, related_name='state_predictions')
    device_id = models.CharField(max_length=64, db_index=True)
    appliance_id = models.IntegerField(null=True, blank=True, db_index=True)
    appliance_channel = models.PositiveSmallIntegerField(null=True, blank=True, db_index=True)
    channel_key = models.CharField(max_length=96, db_index=True, default='')
    predicted_state = models.CharField(max_length=32, choices=STATE_CHOICES, db_index=True)
    confidence_score = models.FloatField(default=0.0)
    action_taken = models.CharField(max_length=128, blank=True, default='')
    reason = models.TextField(blank=True, default='')
    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['device_id', '-timestamp']),
            models.Index(fields=['channel_key', '-timestamp'], name='telemetry_a_channel_665f0a_idx'),
            models.Index(fields=['predicted_state', '-timestamp']),
        ]


class MLPrediction(models.Model):
    STATE_ACTIVE = 'ACTIVE'
    STATE_CHARGING_COMPLETE = 'CHARGING_COMPLETE'
    STATE_IDLE = 'IDLE'
    STATE_EMPTY_SOCKET = 'EMPTY_SOCKET'
    STATE_CHOICES = [
        (STATE_ACTIVE, 'Active'),
        (STATE_CHARGING_COMPLETE, 'Charging Complete'),
        (STATE_IDLE, 'Idle'),
        (STATE_EMPTY_SOCKET, 'Empty Socket'),
    ]

    device_id = models.CharField(max_length=64, db_index=True)
    socket_id = models.PositiveSmallIntegerField(db_index=True)
    predicted_state = models.CharField(max_length=32, choices=STATE_CHOICES, db_index=True)
    confidence = models.FloatField(default=0.0)
    action_taken = models.CharField(max_length=128, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = 'ml_predictions'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['device_id', 'socket_id', '-created_at'], name='ml_pred_socket_latest_idx'),
            models.Index(fields=['predicted_state', '-created_at'], name='ml_pred_state_time_idx'),
        ]


class LoadSignature(models.Model):
    """What kind of device is plugged into a socket, from its current waveform.

    The subnode cannot measure watts honestly - it has no voltage reference -
    but it can measure SHAPE, and shape is what distinguishes a filament bulb
    from a laptop charger. Every field here is scale-invariant, computed after
    normalising the waveform by its own RMS, so a mis-calibrated current sensor
    changes none of them.

    `cycle` keeps the 64-point averaged waveform itself so the dashboard can
    draw the trace, not just the verdict. It is small (64 floats) and it is the
    evidence behind the label - a judge, or a user, can see why.
    """

    LABEL_RESISTIVE = 'RESISTIVE'
    LABEL_SMPS = 'SMPS'
    LABEL_MIXED = 'MIXED'
    LABEL_NONE = 'NONE'
    LABEL_CHOICES = [
        (LABEL_RESISTIVE, 'Resistive - bulb, heater, iron'),
        (LABEL_SMPS, 'Switching supply - charger, LED driver, TV'),
        (LABEL_MIXED, 'Mixed - active PFC, or two loads'),
        (LABEL_NONE, 'Nothing detected'),
    ]

    device_ref = models.ForeignKey(
        Device, on_delete=models.CASCADE, null=True, blank=True,
        related_name='load_signatures',
    )
    device_id = models.CharField(max_length=64, db_index=True)
    socket_id = models.PositiveSmallIntegerField(db_index=True)

    label = models.CharField(max_length=16, choices=LABEL_CHOICES, db_index=True)
    confidence = models.FloatField(default=0.0)
    source = models.CharField(max_length=16, default='rule')
    reason = models.TextField(blank=True, default='')

    crest = models.FloatField(default=0.0)
    form_factor = models.FloatField(default=0.0)
    conduction = models.FloatField(default=0.0)
    thd = models.FloatField(default=0.0)
    h3 = models.FloatField(default=0.0)
    h5 = models.FloatField(default=0.0)
    rms_adc = models.FloatField(default=0.0)

    cycle = models.JSONField(default=list, blank=True)
    device_label = models.CharField(max_length=16, blank=True, default='')

    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['device_id', 'socket_id', '-timestamp']),
        ]

    def __str__(self):
        return f'{self.device_id} socket {self.socket_id}: {self.label} ({self.confidence:.0%})'
