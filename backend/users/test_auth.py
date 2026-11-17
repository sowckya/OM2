from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.test import TestCase
from rest_framework.response import Response
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate
from rest_framework.views import APIView

from .models import User
from .permissions import IsMillionaire, IsOmkar

CSRF_URL = '/api/auth/csrf/'
LOGIN_URL = '/api/auth/login/'
LOGOUT_URL = '/api/auth/logout/'
ME_URL = '/api/auth/me/'
PASSWORD = 's3cret-pass'
INVALID = {'detail': 'Invalid username or password for this login type.'}


class AuthApiTestCase(TestCase):
    def setUp(self):
        cache.clear()  # reset login throttle counters
        self.client = APIClient(enforce_csrf_checks=True)
        self.user = User.objects.create_user(
            username='omkar1', password=PASSWORD, first_name='Ravi', last_name='Kumar'
        )

    def csrf_token(self):
        return self.client.get(CSRF_URL).json()['csrfToken']

    def login(self, username='omkar1', password=PASSWORD, expected_role='OMKAR'):
        return self.client.post(
            LOGIN_URL,
            {'username': username, 'password': password, 'expected_role': expected_role},
            format='json',
            HTTP_X_CSRFTOKEN=self.csrf_token(),
        )


class CsrfEndpointTests(AuthApiTestCase):
    def test_sets_cookie_and_returns_token(self):
        response = self.client.get(CSRF_URL)
        self.assertEqual(response.status_code, 200)
        self.assertIn('csrftoken', response.cookies)
        self.assertTrue(response.json()['csrfToken'])


class LoginTests(AuthApiTestCase):
    def test_successful_login_returns_user_without_password(self):
        response = self.login()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {'id': self.user.pk, 'username': 'omkar1', 'display_name': 'Ravi Kumar', 'role': 'OMKAR'},
        )
        self.assertNotIn('password', response.content.decode())
        self.assertEqual(self.client.get(ME_URL).status_code, 200)

    def test_login_rotates_session_key(self):
        self.client.get(CSRF_URL)
        session = self.client.session
        session['pre_login'] = True
        session.save()
        old_key = session.session_key
        self.client.cookies['sessionid'] = old_key
        self.login()
        self.assertNotEqual(self.client.cookies['sessionid'].value, old_key)

    def test_wrong_password_rejected(self):
        response = self.login(password='wrong-pass')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), INVALID)
        self.assertEqual(self.client.get(ME_URL).status_code, 401)

    def test_unknown_user_and_inactive_user_get_same_error(self):
        User.objects.create_user(username='inactive', password=PASSWORD, is_active=False)
        for username in ('nobody', 'inactive'):
            response = self.login(username=username)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json(), INVALID)

    def test_missing_fields_rejected(self):
        response = self.client.post(LOGIN_URL, {}, format='json', HTTP_X_CSRFTOKEN=self.csrf_token())
        self.assertEqual(response.status_code, 400)

    def test_login_without_csrf_token_rejected(self):
        response = self.client.post(
            LOGIN_URL,
            {'username': 'omkar1', 'password': PASSWORD, 'expected_role': 'OMKAR'},
            format='json',
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn('CSRF', response.json()['detail'])
        self.assertEqual(self.client.get(ME_URL).status_code, 401)

    def test_role_in_login_payload_is_ignored(self):
        response = self.client.post(
            LOGIN_URL,
            {'username': 'omkar1', 'password': PASSWORD, 'expected_role': 'OMKAR', 'role': 'MILLIONAIRE'},
            format='json',
            HTTP_X_CSRFTOKEN=self.csrf_token(),
        )
        self.assertEqual(response.json()['role'], 'OMKAR')
        self.user.refresh_from_db()
        self.assertEqual(self.user.role, User.Role.OMKAR)

    def test_login_is_throttled(self):
        for _ in range(10):
            self.login(password='wrong-pass')
        self.assertEqual(self.login().status_code, 429)


class LoginRoleTests(AuthApiTestCase):
    def setUp(self):
        super().setUp()
        self.millionaire = User.objects.create_user(
            username='millionaire1', password=PASSWORD, role=User.Role.MILLIONAIRE
        )

    def assert_no_session(self):
        # No stored session may belong to a user (anonymous CSRF/test sessions are fine).
        self.assertFalse(
            any('_auth_user_id' in s.get_decoded() for s in Session.objects.all())
        )
        self.assertEqual(self.client.get(ME_URL).status_code, 401)

    def test_omkar_logs_in_on_omkar_tab(self):
        response = self.login('omkar1', expected_role='OMKAR')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['role'], 'OMKAR')
        self.assertEqual(self.client.get(ME_URL).json()['username'], 'omkar1')

    def test_millionaire_logs_in_on_millionaire_tab(self):
        response = self.login('millionaire1', expected_role='MILLIONAIRE')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['role'], 'MILLIONAIRE')
        self.assertEqual(self.client.get(ME_URL).json()['username'], 'millionaire1')

    def test_omkar_rejected_on_millionaire_tab_without_session(self):
        response = self.login('omkar1', expected_role='MILLIONAIRE')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), INVALID)
        self.assertNotIn('sessionid', response.cookies)
        self.assert_no_session()

    def test_millionaire_rejected_on_omkar_tab_without_session(self):
        response = self.login('millionaire1', expected_role='OMKAR')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), INVALID)
        self.assertNotIn('sessionid', response.cookies)
        self.assert_no_session()

    def test_wrong_role_response_is_indistinguishable_from_wrong_password(self):
        wrong_role = self.login('millionaire1', expected_role='OMKAR')
        wrong_password = self.login('millionaire1', password='wrong-pass', expected_role='MILLIONAIRE')
        self.assertEqual(wrong_role.status_code, wrong_password.status_code)
        self.assertEqual(wrong_role.content, wrong_password.content)
        self.assertNotIn('MILLIONAIRE', wrong_role.content.decode())

    def test_expected_role_is_required(self):
        response = self.client.post(
            LOGIN_URL,
            {'username': 'omkar1', 'password': PASSWORD},
            format='json',
            HTTP_X_CSRFTOKEN=self.csrf_token(),
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('expected_role', response.json())
        self.assert_no_session()

    def test_unknown_expected_role_rejected(self):
        response = self.login('omkar1', expected_role='ADMIN')
        self.assertEqual(response.status_code, 400)
        self.assertIn('expected_role', response.json())
        self.assert_no_session()

    def test_wrong_role_attempts_are_throttled(self):
        for _ in range(10):
            self.login('millionaire1', expected_role='OMKAR')
        self.assertEqual(self.login('millionaire1', expected_role='MILLIONAIRE').status_code, 429)


class LogoutTests(AuthApiTestCase):
    def test_logout_invalidates_session(self):
        self.login()
        session_key = self.client.cookies['sessionid'].value
        response = self.client.post(LOGOUT_URL, HTTP_X_CSRFTOKEN=self.client.cookies['csrftoken'].value)
        self.assertEqual(response.status_code, 204)
        self.assertFalse(Session.objects.filter(session_key=session_key).exists())
        self.assertEqual(self.client.get(ME_URL).status_code, 401)

    def test_logout_without_csrf_token_rejected(self):
        self.login()
        response = self.client.post(LOGOUT_URL)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get(ME_URL).status_code, 200)

    def test_logout_requires_authentication(self):
        response = self.client.post(LOGOUT_URL, HTTP_X_CSRFTOKEN=self.csrf_token())
        self.assertEqual(response.status_code, 401)


class MeTests(AuthApiTestCase):
    def test_unauthenticated_returns_401(self):
        response = self.client.get(ME_URL)
        self.assertEqual(response.status_code, 401)

    def test_returns_current_user(self):
        self.login()
        response = self.client.get(ME_URL)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {'id', 'username', 'display_name', 'role'})

    def test_display_name_falls_back_to_username(self):
        User.objects.create_user(username='noname', password=PASSWORD)
        self.login(username='noname')
        self.assertEqual(self.client.get(ME_URL).json()['display_name'], 'noname')

    def test_cannot_change_role_through_me(self):
        self.login()
        token = self.client.cookies['csrftoken'].value
        for method in (self.client.put, self.client.patch):
            response = method(ME_URL, {'role': 'MILLIONAIRE'}, format='json', HTTP_X_CSRFTOKEN=token)
            self.assertEqual(response.status_code, 405)
        self.user.refresh_from_db()
        self.assertEqual(self.user.role, User.Role.OMKAR)


class MillionaireOnlyView(APIView):
    permission_classes = [IsMillionaire]

    def get(self, request):
        return Response({'ok': True})


class OmkarOnlyView(APIView):
    permission_classes = [IsOmkar]

    def get(self, request):
        return Response({'ok': True})


class RolePermissionTests(TestCase):
    def setUp(self):
        self.factory = APIRequestFactory()
        self.millionaire = User.objects.create_user(
            username='m1', password=PASSWORD, role=User.Role.MILLIONAIRE
        )
        self.omkar = User.objects.create_user(username='o1', password=PASSWORD, role=User.Role.OMKAR)

    def get_status(self, view_class, user=None):
        request = self.factory.get('/test/')
        if user is not None:
            force_authenticate(request, user=user)
        return view_class.as_view()(request).status_code

    def test_is_millionaire(self):
        self.assertEqual(self.get_status(MillionaireOnlyView, self.millionaire), 200)
        self.assertEqual(self.get_status(MillionaireOnlyView, self.omkar), 403)
        self.assertEqual(self.get_status(MillionaireOnlyView), 401)

    def test_is_omkar(self):
        self.assertEqual(self.get_status(OmkarOnlyView, self.omkar), 200)
        self.assertEqual(self.get_status(OmkarOnlyView, self.millionaire), 403)
        self.assertEqual(self.get_status(OmkarOnlyView), 401)

    def test_superuser_flag_does_not_grant_role(self):
        admin = User.objects.create_superuser(username='admin', password=PASSWORD, role=User.Role.OMKAR)
        self.assertEqual(self.get_status(MillionaireOnlyView, admin), 403)

    def test_inactive_user_denied(self):
        self.millionaire.is_active = False
        self.millionaire.save()
        self.assertEqual(self.get_status(MillionaireOnlyView, self.millionaire), 403)
