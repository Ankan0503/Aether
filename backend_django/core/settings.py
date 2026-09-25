import os
import dj_database_url # type: ignore
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.getenv('DJANGO_SECRET_KEY')

DEBUG = os.getenv('DEBUG', 'False') == 'True'

ALLOWED_HOSTS = os.getenv('ALLOWED_HOSTS', '').split(',')

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'telemetry.apps.TelemetryConfig',
    'accounts.apps.AccountsConfig',
    'devices.apps.DevicesConfig',
    'layout.apps.LayoutConfig',
    'anomaly.apps.AnomalyConfig',
    'recommendations.apps.RecommendationsConfig',
    'hazards.apps.HazardsConfig',
    'notifications.apps.NotificationsConfig',
]

MIDDLEWARE = [
    'telemetry.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'core.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'core.wsgi.application'

DATABASES = {
    'default': dj_database_url.config(
        default = os.getenv("DATABASE_URL"),
        conn_max_age = int(os.getenv("DATABASE_CONN_MAX_AGE", 0)), 
        ssl_require = True,
    )
}

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

LANGUAGE_CODE = 'en-us'

TIME_ZONE = 'UTC'

USE_I18N = True

USE_TZ = True


STATIC_URL = 'static/'

# Machine-learning service configuration. The artifact is produced by
# ML/scripts/train_phantom_current_model.py and loaded once per Django process.
ANOMALY_MODEL_PATH = os.getenv(
    'ANOMALY_MODEL_PATH',
    str(BASE_DIR / 'anomaly' / 'models' / 'phantom_current_iforest.joblib'),
)
ANOMALY_DEFAULT_VOLTAGE = float(os.getenv('ANOMALY_DEFAULT_VOLTAGE', 230.0))
PHANTOM_BASELINE_CURRENT = float(os.getenv('PHANTOM_BASELINE_CURRENT', 0.0))
APPLIANCE_STATE_MODEL_PATH = os.getenv(
    'APPLIANCE_STATE_MODEL_PATH',
    str(BASE_DIR / 'anomaly' / 'models' / 'appliance_state_rf.joblib'),
)
APPLIANCE_MODEL_MIN_ROWS = int(os.getenv('APPLIANCE_MODEL_MIN_ROWS', 50))
APPLIANCE_DEFAULT_VOLTAGE = float(os.getenv('APPLIANCE_DEFAULT_VOLTAGE', 230.0))
APPLIANCE_IDLE_CUTOFF_SECONDS = int(os.getenv('APPLIANCE_IDLE_CUTOFF_SECONDS', 8))
APPLIANCE_IDLE_POWER_THRESHOLD_WATTS = float(os.getenv('APPLIANCE_IDLE_POWER_THRESHOLD_WATTS', 2.0))
APPLIANCE_IDLE_CURRENT_THRESHOLD_AMPS = float(os.getenv('APPLIANCE_IDLE_CURRENT_THRESHOLD_AMPS', 0.02))
APPLIANCE_PHANTOM_CUTOFF_HITS = int(os.getenv('APPLIANCE_PHANTOM_CUTOFF_HITS', 3))
APPLIANCE_PHANTOM_CUTOFF_POWER_WATTS = float(os.getenv('APPLIANCE_PHANTOM_CUTOFF_POWER_WATTS', 25.0))
APPLIANCE_CUTOFF_CONFIRMATION_READINGS = int(os.getenv('APPLIANCE_CUTOFF_CONFIRMATION_READINGS', 3))
APPLIANCE_CUTOFF_COMMAND_TOPIC = os.getenv('APPLIANCE_CUTOFF_COMMAND_TOPIC', 'aether/pairing/command')
APPLIANCE_CUTOFF_ENABLED = os.getenv('APPLIANCE_CUTOFF_ENABLED', 'True') == 'True'
APPLIANCE_ELECTRICITY_RATE_PER_KWH = float(os.getenv('APPLIANCE_ELECTRICITY_RATE_PER_KWH', 8.0))

SOCKET_MODEL_DIR = os.getenv(
    'SOCKET_MODEL_DIR',
    str(BASE_DIR / 'models'),
)
SOCKET_MODEL_MIN_ROWS = int(os.getenv('SOCKET_MODEL_MIN_ROWS', 20))
SOCKET_BOOTSTRAP_MIN_ROWS = int(os.getenv('SOCKET_BOOTSTRAP_MIN_ROWS', 1))
SOCKET_BOOTSTRAP_CONFIDENCE_CAP = float(os.getenv('SOCKET_BOOTSTRAP_CONFIDENCE_CAP', 89.0))
SOCKET_MODEL_N_JOBS = int(os.getenv('SOCKET_MODEL_N_JOBS', 1))
SOCKET_AUTO_CUTOFF_ENABLED = os.getenv('SOCKET_AUTO_CUTOFF_ENABLED', 'True') == 'True'
SOCKET_CUTOFF_CONFIDENCE_THRESHOLD = float(os.getenv('SOCKET_CUTOFF_CONFIDENCE_THRESHOLD', 90.0))
SOCKET_CUTOFF_CONFIRMATION_MINUTES = int(os.getenv('SOCKET_CUTOFF_CONFIRMATION_MINUTES', 10))
SOCKET_CUTOFF_COMMAND_TOPIC = os.getenv('SOCKET_CUTOFF_COMMAND_TOPIC', 'aether/pairing/command')

# Energy recommendation engine defaults. Keep these environment-driven so
# deployments can tune thresholds for local tariffs and sensor calibration.
RECOMMENDATION_DEFAULT_VOLTAGE = float(os.getenv('RECOMMENDATION_DEFAULT_VOLTAGE', 230.0))
ELECTRICITY_RATE_PER_KWH = float(os.getenv('ELECTRICITY_RATE_PER_KWH', 8.0))
RECOMMENDATION_CURRENCY = os.getenv('RECOMMENDATION_CURRENCY', 'INR')
STANDBY_CURRENT_THRESHOLD = float(os.getenv('STANDBY_CURRENT_THRESHOLD', 0.05))
STANDBY_POWER_THRESHOLD_WATTS = float(os.getenv('STANDBY_POWER_THRESHOLD_WATTS', 8.0))
OCCUPANCY_POWER_THRESHOLD_WATTS = float(os.getenv('OCCUPANCY_POWER_THRESHOLD_WATTS', 15.0))
ABNORMAL_USAGE_TREND_PERCENT = float(os.getenv('ABNORMAL_USAGE_TREND_PERCENT', 25.0))
MIN_RECOMMENDATION_SAMPLES = int(os.getenv('MIN_RECOMMENDATION_SAMPLES', 12))
MAX_ENERGY_RECOMMENDATIONS = int(os.getenv('MAX_ENERGY_RECOMMENDATIONS', 12))

# Real-time gas/fire hazard risk scoring defaults. These mirror the firmware's
# active-low flame sensor convention and MQ2 danger threshold while staying tunable.
HAZARD_GAS_WARNING = int(os.getenv('HAZARD_GAS_WARNING', 1800))
HAZARD_GAS_DANGER = int(os.getenv('HAZARD_GAS_DANGER', 3500))
HAZARD_GAS_CRITICAL = int(os.getenv('HAZARD_GAS_CRITICAL', 4095))
HAZARD_FLAME_ACTIVE_VALUE = int(os.getenv('HAZARD_FLAME_ACTIVE_VALUE', 0))
HAZARD_FIRE_RISK_SCORE = int(os.getenv('HAZARD_FIRE_RISK_SCORE', 95))
HAZARD_BUZZER_SCORE = int(os.getenv('HAZARD_BUZZER_SCORE', 55))
HAZARD_SOLENOID_SCORE = int(os.getenv('HAZARD_SOLENOID_SCORE', 75))
HAZARD_NOTIFICATION_SCORE = int(os.getenv('HAZARD_NOTIFICATION_SCORE', 35))

# Browser Web Push configuration. Generate these with:
# python manage.py generate_vapid_keys
WEBPUSH_VAPID_PUBLIC_KEY = os.getenv('WEBPUSH_VAPID_PUBLIC_KEY', '')
WEBPUSH_VAPID_PRIVATE_KEY = os.getenv('WEBPUSH_VAPID_PRIVATE_KEY', '')
WEBPUSH_VAPID_SUBJECT = os.getenv('WEBPUSH_VAPID_SUBJECT', 'mailto:admin@example.com')


# ---------------------------------------------------------------------------
# Telemetry storage policy
# ---------------------------------------------------------------------------
# The gateway publishes every 2 seconds and a relay node writes one row per
# socket plus a combined one, so storing every sample is ~172,800 rows a day.
# Nearly all of them repeat the previous value. telemetry/store_policy.py keeps
# a sample only when something changed or a heartbeat falls due, which drops a
# steady load to ~1,440 rows a day per stream while recording every transition
# at full fidelity.
#
# Safety is exempt: a change in status or flame, or a gas reading crossing
# GAS_ALERT_THRESHOLD, is always stored immediately.
TELEMETRY_HEARTBEAT_SECONDS = 60          # store regardless after this long
TELEMETRY_CURRENT_DEADBAND_A = 0.05       # absolute floor, above ACS712 noise
TELEMETRY_CURRENT_DEADBAND_FRACTION = 0.10  # and at least this much relatively
TELEMETRY_GAS_DEADBAND = 150

# Master switch for telemetry history. False keeps the pipeline fully alive -
# payloads arrive, predictions run, the dashboard updates from live_state - but
# nothing is written to the database. Useful for watching the system work
# without spending storage, and for demos on a capped free tier.
#
# Read from the environment so it can be flipped without editing code, and so a
# deployment cannot accidentally inherit a paused setting from a developer's
# machine. Defaults to True: storing history is the normal state.
TELEMETRY_PERSIST = os.getenv("TELEMETRY_PERSIST", "True").strip().lower() in (
    "1", "true", "yes", "on",
)
