"""Test settings: run against a local SQLite database.

    python manage.py test --settings=core.settings_test

Tiger Cloud refuses to create the throwaway database Django's test runner wants
("database test_tsdb is not an allowed database name"), and pointing tests at
the real service would be worse anyway - the runner drops and recreates the
database it is given.

Migrations are switched off and the schema is built straight from the models.
Several existing migrations contain PostgreSQL-only SQL - 0007 casts with
`::text`, 0011 calls create_hypertable - which SQLite cannot parse. Replaying
them here would test the migration history rather than the code under test, and
the history is already verified by having applied cleanly against the real Tiger
Cloud service.

The consequence: anything that depends on hypertables or continuous aggregates
must be checked against the real service, not here.
"""

from .settings import *  # noqa: F401,F403

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': ':memory:',
    }
}


class _NoMigrations:
    """Tell Django every app has no migration module, so it builds from models."""

    def __contains__(self, item):
        return True

    def __getitem__(self, item):
        return None


MIGRATION_MODULES = _NoMigrations()

# Keep the default on, so tests have to opt out explicitly and a test that
# forgets to set it still exercises the normal path.
TELEMETRY_PERSIST = True

PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']
