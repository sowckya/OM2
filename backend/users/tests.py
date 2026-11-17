from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.test import TestCase

from .models import User


class UserModelTests(TestCase):
    def test_auth_user_model_is_custom_user(self):
        self.assertIs(get_user_model(), User)

    def test_create_user_defaults_to_omkar(self):
        user = User.objects.create_user(username='omkar1', password='s3cret-pass')
        self.assertEqual(user.role, User.Role.OMKAR)
        self.assertTrue(user.check_password('s3cret-pass'))
        self.assertNotEqual(user.password, 's3cret-pass')
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)

    def test_create_millionaire(self):
        user = User.objects.create_user(
            username='millionaire1', password='s3cret-pass', role=User.Role.MILLIONAIRE
        )
        user.refresh_from_db()
        self.assertEqual(user.role, 'MILLIONAIRE')
        self.assertFalse(user.is_staff)

    def test_create_omkar(self):
        user = User.objects.create_user(username='omkar2', password='s3cret-pass', role=User.Role.OMKAR)
        user.refresh_from_db()
        self.assertEqual(user.role, 'OMKAR')

    def test_superuser_flags_independent_of_role(self):
        user = User.objects.create_superuser(username='admin', password='s3cret-pass', email='a@example.com')
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)
        self.assertEqual(user.role, User.Role.OMKAR)

    def test_invalid_role_rejected_by_validation(self):
        user = User(username='bad', role='ADMIN')
        user.set_password('s3cret-pass')
        with self.assertRaises(ValidationError) as ctx:
            user.full_clean()
        self.assertIn('role', ctx.exception.message_dict)


class UserAdminTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(username='admin', password='s3cret-pass', email='a@example.com')
        self.client.force_login(self.admin)

    def test_admin_user_pages_render_with_role(self):
        for url in ('/admin/users/user/', '/admin/users/user/add/', f'/admin/users/user/{self.admin.pk}/change/'):
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200, url)
            self.assertContains(response, 'role')


class TestHashingSafeguardTests(TestCase):
    """The fast hasher is a test-runner override only; production keeps Django's default."""

    def test_production_settings_keep_the_default_hasher(self):
        import config.settings as production
        from django.conf import global_settings

        self.assertFalse(hasattr(production, 'PASSWORD_HASHERS'))
        self.assertEqual(global_settings.PASSWORD_HASHERS[0], 'django.contrib.auth.hashers.PBKDF2PasswordHasher')

    def test_tests_use_the_same_algorithm_with_fewer_iterations(self):
        from django.contrib.auth.hashers import get_hasher, identify_hasher

        hasher = get_hasher()
        self.assertEqual((hasher.algorithm, hasher.iterations), ('pbkdf2_sha256', 1000))
        user = User.objects.create_user(username='hash_check', password='s3cret-pass')
        self.assertEqual(identify_hasher(user.password).algorithm, 'pbkdf2_sha256')
        self.assertTrue(user.check_password('s3cret-pass'))
