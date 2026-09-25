from django.apps import AppConfig
import os

class TelemetryConfig(AppConfig):
    name = 'telemetry'

    def ready(self):
        # RUN_MAIN is set only by Django's autoreloader, so `runserver --noreload`
        # and gunicorn both skip this and the listener never starts. Fall back to
        # an explicit opt-in for those cases.
        if os.environ.get('RUN_MAIN') == 'true' or os.environ.get('START_MQTT') == '1':
            from .mqtt import start_mqtt_listener
            start_mqtt_listener()

    # fix_database_schema() is deliberately NOT called any more.
    #
    # It was a repair hack for an older, hand-edited schema, and it runs on every
    # boot. Against this database it is actively harmful:
    #
    #   1. It drops EVERY foreign key on telemetry_telemetryreading, including
    #      device_ref -> devices_device that the migrations created. Referential
    #      integrity would be silently destroyed on each restart.
    #   2. "UPDATE ... SET device_id = NULL WHERE device_id !~ '^[0-9]+$'" nulls
    #      every MAC-addressed row, since a MAC is not numeric. It survives only
    #      because device_id is NOT NULL and the failure is swallowed by a bare
    #      except - one schema change away from deleting device identity.
    #   3. "ALTER COLUMN device_id TYPE varchar(64)" now fails outright: the
    #      continuous aggregate telemetry_socket_hourly reads that column, and
    #      PostgreSQL will not retype a column a view depends on. That failure is
    #      what crashed startup.
    #
    # Migrations own this schema now, and it was built by `migrate` against a
    # fresh database. The method is kept for reference only.

    def fix_database_schema(self):
        from django.db import connection
        print(" Checking and repairing telemetry database schema...")
        with connection.cursor() as cursor:
            # 1. Dynamically find and drop all foreign key constraints on telemetry_telemetryreading
            try:
                cursor.execute("""
                    SELECT tc.constraint_name 
                    FROM information_schema.table_constraints AS tc 
                    WHERE tc.table_name = 'telemetry_telemetryreading' 
                      AND tc.constraint_type = 'FOREIGN KEY';
                """)
                constraints = cursor.fetchall()
                for r in constraints:
                    constraint_name = r[0]
                    print(f"Dropping constraint {constraint_name}...")
                    cursor.execute(f"ALTER TABLE telemetry_telemetryreading DROP CONSTRAINT {constraint_name};")
                print(" Successfully dropped all foreign key constraints on telemetry_telemetryreading!")
            except Exception as e:
                print(f"Error dropping constraints: {e}")

            # 2. Clean up device_id non-numeric values
            try:
                cursor.execute("UPDATE telemetry_telemetryreading SET device_id = NULL WHERE device_id !~ '^[0-9]+$';")
            except Exception as e:
                pass
            
            # 3. Alter column device_id to varchar(64)
            try:
                cursor.execute("ALTER TABLE telemetry_telemetryreading ALTER COLUMN device_id TYPE varchar(64);")
                print(" Successfully converted device_id column to varchar(64)!")
            except Exception as e:
                print(f" device_id column alter failed: {e}")

            # 4. Drop NOT NULL on power column
            try:
                cursor.execute("ALTER TABLE telemetry_telemetryreading ALTER COLUMN power DROP NOT NULL;")
                print(" Successfully dropped NOT NULL constraint on power column!")
            except Exception as e:
                print(f" power column check skip: {e}")

            # 6. Drop NOT NULL on power_watts column
            try:
                cursor.execute("ALTER TABLE telemetry_telemetryreading ALTER COLUMN power_watts DROP NOT NULL;")
                print(" Successfully dropped NOT NULL constraint on power_watts column!")
            except Exception as e:
                print(f" power_watts column check skip: {e}")

            # 7. Dynamically add c1, c2, c3, c4 columns if they don't exist
            for col in ['c1', 'c2', 'c3', 'c4']:
                try:
                    cursor.execute(f"ALTER TABLE telemetry_telemetryreading ADD COLUMN {col} double precision DEFAULT 0.0;")
                    print(f" Successfully added column {col} to telemetry_telemetryreading!")
                except Exception as e:
                    pass

            # 8. Dynamically add appliance_id column if it doesn't exist
            try:
                cursor.execute("ALTER TABLE telemetry_telemetryreading ADD COLUMN appliance_id integer;")
                print(" Successfully added column appliance_id to telemetry_telemetryreading!")
            except Exception as e:
                pass


