from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('layout', '0002_room_doors'),
    ]

    operations = [
        migrations.AddField(
            model_name='room',
            name='floor',
            field=models.PositiveSmallIntegerField(default=0),
        ),
        migrations.AlterModelOptions(
            name='room',
            options={'ordering': ['floor', 'grid_y', 'grid_x', 'created_at']},
        ),
        migrations.RemoveIndex(
            model_name='room',
            name='layout_room_owner_i_501dd3_idx',
        ),
        migrations.AddIndex(
            model_name='room',
            index=models.Index(fields=['owner', 'floor', 'grid_y', 'grid_x'], name='layout_room_owner_i_ec4b60_idx'),
        ),
    ]
