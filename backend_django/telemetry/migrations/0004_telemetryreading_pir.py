# Generated manually to persist occupancy telemetry for ML anomaly detection.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('telemetry', '0003_telemetryreading_device'),
    ]

    operations = [
        migrations.AddField(
            model_name='telemetryreading',
            name='pir',
            field=models.IntegerField(default=1),
        ),
    ]
