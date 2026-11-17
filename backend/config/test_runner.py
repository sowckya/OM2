"""Test runner: keeps tests away from real AI services and makes password hashing fast.

Production settings are untouched: these overrides exist only while tests run.
"""

from unittest import mock

from django.contrib.auth.hashers import PBKDF2PasswordHasher
from django.test import override_settings
from django.test.runner import DiscoverRunner


def _blocked_urlopen(*args, **kwargs):
    raise AssertionError('Tests must not make real HTTP requests (e.g. to Gemini). Inject a fake transport.')


class FastPBKDF2PasswordHasher(PBKDF2PasswordHasher):
    """The production algorithm (pbkdf2_sha256, same hash format) with test-only iterations.

    Django's default 1,000,000 iterations cost ~0.6 s per hash, paid for every create_user
    and login in tests; that was most of the suite's run time.
    """

    iterations = 1000


class OM2TestRunner(DiscoverRunner):
    """Forces the mock provider with no Gemini or TinyURL key, blocks urllib network calls and uses a fast hasher."""

    def setup_test_environment(self, **kwargs):
        super().setup_test_environment(**kwargs)
        self._settings = override_settings(
            CONTENT_AI_PROVIDER='mock',
            GEMINI_API_KEY='',
            TINYURL_API_TOKEN='',
            PASSWORD_HASHERS=['config.test_runner.FastPBKDF2PasswordHasher'],
        )
        self._settings.enable()
        self._network = mock.patch('urllib.request.urlopen', _blocked_urlopen)
        self._network.start()

    def teardown_test_environment(self, **kwargs):
        self._network.stop()
        self._settings.disable()
        super().teardown_test_environment(**kwargs)
