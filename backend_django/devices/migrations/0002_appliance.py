# Generated manually

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('devices', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='Appliance',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('channel', models.IntegerField()),
                ('name', models.CharField(default='Unnamed Channel', max_length=100)),
                ('type', models.CharField(default='Appliance', max_length=50)),
                ('active', models.BooleanField(default=False)),
                ('nominal_consumption', models.IntegerField(default=100)),
                ('device', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='appliances', to='devices.device')),
            ],
        ),
    ]
