from unittest import mock

from django.contrib.auth.hashers import identify_hasher
from django.test import TestCase
from rest_framework.test import APIClient

from .models import User
from .serializers import OmkarCreateSerializer

LIST_URL = '/api/omkars/'
PASSWORD = 's3cret-pass'
STRONG = 'Vivid-Mango-2026!'
FIELDS = {'id', 'username', 'first_name', 'last_name', 'email', 'phone_number', 'is_active', 'date_joined', 'x_accounts'}


def detail_url(pk):
    return f'{LIST_URL}{pk}/'


def new_omkar(**overrides):
    return {
        'username': 'ravi_k',
        'first_name': 'Ravi',
        'last_name': 'Kumar',
        'email': 'ravi@example.com',
        'password': STRONG,
        **overrides,
    }


class OmkarApiTestCase(TestCase):
    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.millionaire = User.objects.create_user(
            username='millionaire1', password=PASSWORD, role=User.Role.MILLIONAIRE, email='boss@example.com'
        )

    def sign_in(self, user=None):
        self.client.force_login(user or self.millionaire)
        self.token = self.client.get('/api/auth/csrf/').json()['csrfToken']

    def post(self, data):
        return self.client.post(LIST_URL, data, format='json', HTTP_X_CSRFTOKEN=self.token)

    def patch(self, pk, data):
        return self.client.patch(detail_url(pk), data, format='json', HTTP_X_CSRFTOKEN=self.token)

    def make_omkar(self, username, **kwargs):
        kwargs.setdefault('email', f'{username}@example.com')
        kwargs.setdefault('first_name', username.title())
        return User.objects.create_user(username=username, password=PASSWORD, role=User.Role.OMKAR, **kwargs)

    def assert_no_secrets(self, response):
        text = response.content.decode()
        self.assertNotIn('password', text)
        self.assertNotIn('pbkdf2', text)
        self.assertNotIn(STRONG, text)


class CreateTests(OmkarApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()

    def test_create_omkar_with_phone_number(self):
        response = self.post(new_omkar(phone_number='+91 98765 43210'))
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()['phone_number'], '+919876543210')

    def test_create_omkar(self):
        response = self.post(new_omkar(email=' Ravi@EXAMPLE.com '))
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(set(body), FIELDS)
        self.assertEqual(
            {k: body[k] for k in ('username', 'first_name', 'last_name', 'email', 'is_active')},
            {'username': 'ravi_k', 'first_name': 'Ravi', 'last_name': 'Kumar', 'email': 'Ravi@example.com', 'is_active': True},
        )
        self.assert_no_secrets(response)

        omkar = User.objects.get(username='ravi_k')
        self.assertEqual(omkar.role, User.Role.OMKAR)
        self.assertFalse(omkar.is_staff)
        self.assertFalse(omkar.is_superuser)
        self.assertTrue(omkar.is_active)

    def test_password_is_hashed_and_new_omkar_can_log_in(self):
        self.post(new_omkar())
        omkar = User.objects.get(username='ravi_k')
        self.assertNotEqual(omkar.password, STRONG)
        self.assertEqual(identify_hasher(omkar.password).algorithm, 'pbkdf2_sha256')
        self.assertTrue(omkar.check_password(STRONG))

        login_client = APIClient(enforce_csrf_checks=True)
        token = login_client.get('/api/auth/csrf/').json()['csrfToken']
        response = login_client.post(
            '/api/auth/login/',
            {'username': 'ravi_k', 'password': STRONG, 'expected_role': 'OMKAR'},
            format='json',
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['role'], 'OMKAR')

    def test_last_name_optional(self):
        data = new_omkar()
        del data['last_name']
        response = self.post(data)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()['last_name'], '')

    def test_required_fields(self):
        response = self.post({})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(response.json()), {'username', 'first_name', 'email', 'password'})

    def test_blank_first_name_and_email_rejected(self):
        response = self.post(new_omkar(first_name='   ', email=''))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(response.json()), {'first_name', 'email'})

    def test_server_controls_role_and_admin_flags(self):
        for field, value in (
            ('role', 'MILLIONAIRE'),
            ('is_staff', True),
            ('is_superuser', True),
            ('is_active', False),
            ('groups', [1]),
            ('user_permissions', [1]),
            ('id', 999),
        ):
            with self.subTest(field=field):
                response = self.post(new_omkar(**{field: value}))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {field: ['This field cannot be set.']})
        self.assertFalse(User.objects.filter(username='ravi_k').exists())

    def test_invalid_username_rejected(self):
        for username in ('bad name', 'bad/name', 'bad!', 'x' * 151, ''):
            with self.subTest(username=username):
                response = self.post(new_omkar(username=username))
                self.assertEqual(response.status_code, 400)
                self.assertIn('username', response.json())

    def test_invalid_email_rejected(self):
        for email in ('not-an-email', 'ravi@', '@example.com', 'ravi example@x.com'):
            with self.subTest(email=email):
                response = self.post(new_omkar(email=email))
                self.assertEqual(response.status_code, 400)
                self.assertIn('email', response.json())


class DuplicateTests(OmkarApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()
        self.existing = self.make_omkar('ravi_k', email='ravi@example.com')

    def test_duplicate_username_rejected_ignoring_case(self):
        for username in ('ravi_k', 'RAVI_K', 'Ravi_K'):
            with self.subTest(username=username):
                response = self.post(new_omkar(username=username, email='other@example.com'))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {'username': ['A user with this username already exists.']})

    def test_username_cannot_reuse_a_millionaire_username(self):
        response = self.post(new_omkar(username='Millionaire1', email='other@example.com'))
        self.assertEqual(response.status_code, 400)
        self.assertIn('username', response.json())

    def test_duplicate_omkar_email_rejected_ignoring_case(self):
        for email in ('ravi@example.com', 'RAVI@EXAMPLE.COM', ' Ravi@Example.com '):
            with self.subTest(email=email):
                response = self.post(new_omkar(username='someone_else', email=email))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {'email': ['An Omkar with this email address already exists.']})

    def test_duplicate_email_rejected_on_update(self):
        other = self.make_omkar('sita', email='sita@example.com')
        response = self.patch(other.pk, {'email': 'RAVI@example.com'})
        self.assertEqual(response.status_code, 400)
        self.assertIn('email', response.json())
        other.refresh_from_db()
        self.assertEqual(other.email, 'sita@example.com')

    def test_keeping_own_email_is_not_a_duplicate(self):
        response = self.patch(self.existing.pk, {'email': 'RAVI@example.com'})
        self.assertEqual(response.status_code, 200)

    def test_email_check_is_scoped_to_omkars(self):
        # The Millionaire's email is not part of the Omkar uniqueness rule.
        response = self.post(new_omkar(username='new_one', email='boss@example.com'))
        self.assertEqual(response.status_code, 201)

    def test_concurrent_duplicate_username_returns_400_not_500(self):
        # Simulate a race: validation passes, then the database unique index rejects the insert.
        with mock.patch.object(OmkarCreateSerializer, 'validate_username', lambda self, value: value):
            response = self.post(new_omkar(username='ravi_k', email='race@example.com'))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {'username': ['A user with this username already exists.']})


class PasswordValidationTests(OmkarApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()

    def assert_password_rejected(self, password, fragment, **overrides):
        response = self.post(new_omkar(password=password, **overrides))
        self.assertEqual(response.status_code, 400)
        messages = response.json()['password']
        self.assertTrue(any(fragment in m for m in messages), messages)
        self.assertFalse(User.objects.filter(username=overrides.get('username', 'ravi_k')).exists())

    def test_too_short(self):
        self.assert_password_rejected('Ab1!', 'too short')

    def test_too_common(self):
        self.assert_password_rejected('password123', 'too common')

    def test_entirely_numeric(self):
        self.assert_password_rejected('8364920174', 'entirely numeric')

    def test_too_similar_to_user_attributes(self):
        self.assert_password_rejected('ravikumar_k', 'too similar', username='ravikumar_k')

    def test_password_not_trimmed(self):
        response = self.post(new_omkar(password=f' {STRONG} '))
        self.assertEqual(response.status_code, 201)
        self.assertTrue(User.objects.get(username='ravi_k').check_password(f' {STRONG} '))


class ListAndDetailTests(OmkarApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()
        self.ravi = self.make_omkar('ravi_k', first_name='Ravi', last_name='Kumar', email='ravi@example.com')
        self.sita = self.make_omkar('Sita', first_name='Sita', last_name='Rao', email='sita@mail.test', is_active=False)
        self.anil = self.make_omkar('anil', first_name='Anil', last_name='Kumar', email='anil@example.com')
        self.superuser = User.objects.create_superuser(username='root', password=PASSWORD)  # role OMKAR by default

    def usernames(self, query=''):
        response = self.client.get(LIST_URL + query)
        self.assertEqual(response.status_code, 200)
        return [u['username'] for u in response.json()['results']]

    def test_list_only_omkars_in_stable_order(self):
        response = self.client.get(LIST_URL)
        body = response.json()
        self.assertEqual(set(body), {'count', 'next', 'previous', 'results'})
        self.assertEqual(body['count'], 3)
        self.assertEqual([u['username'] for u in body['results']], ['anil', 'ravi_k', 'Sita'])
        self.assertEqual(set(body['results'][0]), FIELDS)
        self.assert_no_secrets(response)

    def test_millionaires_and_superusers_are_not_exposed(self):
        self.assertNotIn('millionaire1', self.usernames())
        self.assertNotIn('root', self.usernames())
        for user in (self.millionaire, self.superuser):
            with self.subTest(user=user.username):
                self.assertEqual(self.client.get(detail_url(user.pk)).status_code, 404)
                self.assertEqual(self.patch(user.pk, {'is_active': False}).status_code, 404)
                user.refresh_from_db()
                self.assertTrue(user.is_active)

    def test_retrieve(self):
        response = self.client.get(detail_url(self.ravi.pk))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['email'], 'ravi@example.com')
        self.assert_no_secrets(response)
        self.assertEqual(self.client.get(detail_url(99999)).status_code, 404)

    def test_search_by_username_name_or_email(self):
        self.assertEqual(self.usernames('?search=ravi'), ['ravi_k'])
        self.assertEqual(self.usernames('?search=kumar'), ['anil', 'ravi_k'])
        self.assertEqual(self.usernames('?search=mail.test'), ['Sita'])
        self.assertEqual(self.usernames('?search=SITA'), ['Sita'])
        self.assertEqual(self.usernames('?search=anil kumar'), ['anil'])
        self.assertEqual(self.usernames('?search=nobody'), [])
        self.assertEqual(self.usernames('?search=millionaire1'), [])

    def test_filter_by_active_status(self):
        self.assertEqual(self.usernames('?is_active=true'), ['anil', 'ravi_k'])
        self.assertEqual(self.usernames('?is_active=false'), ['Sita'])
        self.assertEqual(self.usernames('?is_active=true&search=kumar'), ['anil', 'ravi_k'])

    def test_invalid_active_filter_rejected(self):
        response = self.client.get(LIST_URL + '?is_active=maybe')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {'is_active': ['Must be true or false.']})


class UpdateTests(OmkarApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()
        self.omkar = self.make_omkar('ravi_k', first_name='Ravi', last_name='Kumar', email='ravi@example.com')
        self.original_hash = self.omkar.password

    def test_update_profile_fields(self):
        response = self.patch(self.omkar.pk, {'first_name': 'Ravi Teja', 'last_name': '', 'email': 'RT@Example.COM'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), FIELDS)
        self.omkar.refresh_from_db()
        self.assertEqual((self.omkar.first_name, self.omkar.last_name, self.omkar.email), ('Ravi Teja', '', 'RT@example.com'))

    def test_phone_number_is_normalised_and_can_be_cleared(self):
        for entered, saved in [('+91 98765-43210', '+919876543210'), ('0044 (20) 7946 0958', '+442079460958'), ('', '')]:
            with self.subTest(entered):
                response = self.patch(self.omkar.pk, {'phone_number': entered})
                self.assertEqual(response.status_code, 200, response.content)
                self.assertEqual(response.json()['phone_number'], saved)

    def test_phone_number_needs_country_code(self):
        for entered in ('98765 43210', '+0123456789', '+91 98', 'call me', '+1234567890123456'):
            with self.subTest(entered):
                response = self.patch(self.omkar.pk, {'phone_number': entered})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()['phone_number'], ['Enter the number with its country code, e.g. +91 98765 43210.'])
        self.omkar.refresh_from_db()
        self.assertEqual(self.omkar.phone_number, '')

    def test_deactivate_and_reactivate(self):
        self.assertFalse(self.patch(self.omkar.pk, {'is_active': False}).json()['is_active'])
        self.omkar.refresh_from_db()
        self.assertFalse(self.omkar.is_active)
        self.assertTrue(self.patch(self.omkar.pk, {'is_active': True}).json()['is_active'])

    def test_deactivated_omkar_cannot_log_in_or_use_existing_session(self):
        omkar_client = APIClient()
        omkar_client.force_login(self.omkar)
        self.assertEqual(omkar_client.get('/api/auth/me/').status_code, 200)

        self.patch(self.omkar.pk, {'is_active': False})
        self.assertEqual(omkar_client.get('/api/auth/me/').status_code, 401)
        self.assertFalse(APIClient().login(username='ravi_k', password=PASSWORD))

    def test_protected_fields_cannot_be_changed(self):
        for field, value in (
            ('username', 'hijacked'),
            ('password', 'Another-Pass-2026'),
            ('role', 'MILLIONAIRE'),
            ('is_staff', True),
            ('is_superuser', True),
            ('date_joined', '2000-01-01T00:00:00Z'),
            ('id', 999),
        ):
            with self.subTest(field=field):
                response = self.patch(self.omkar.pk, {field: value, 'first_name': 'Changed'})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {field: ['This field cannot be set.']})

        self.omkar.refresh_from_db()
        self.assertEqual(self.omkar.username, 'ravi_k')
        self.assertEqual(self.omkar.first_name, 'Ravi')
        self.assertEqual(self.omkar.password, self.original_hash)
        self.assertEqual(self.omkar.role, User.Role.OMKAR)
        self.assertFalse(self.omkar.is_staff or self.omkar.is_superuser)

    def test_invalid_updates_rejected(self):
        for data, field in (({'first_name': '  '}, 'first_name'), ({'email': 'nope'}, 'email'), ({'is_active': 'sometimes'}, 'is_active')):
            with self.subTest(data=data):
                response = self.patch(self.omkar.pk, data)
                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.json())

    def test_patch_without_email_works_for_existing_blank_email(self):
        legacy = self.make_omkar('legacy', email='')
        response = self.patch(legacy.pk, {'first_name': 'Legacy'})
        self.assertEqual(response.status_code, 200)

    def test_put_and_delete_not_allowed(self):
        url = detail_url(self.omkar.pk)
        put = self.client.put(url, {'first_name': 'X'}, format='json', HTTP_X_CSRFTOKEN=self.token)
        delete = self.client.delete(url, HTTP_X_CSRFTOKEN=self.token)
        self.assertEqual((put.status_code, delete.status_code), (405, 405))
        self.assertEqual(self.client.delete(LIST_URL, HTTP_X_CSRFTOKEN=self.token).status_code, 405)
        self.assertTrue(User.objects.filter(pk=self.omkar.pk).exists())


class PaginationTests(OmkarApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()
        User.objects.bulk_create(
            [User(username=f'omkar_{i:03d}', email=f'o{i}@example.com', role=User.Role.OMKAR) for i in range(75)]
        )

    def test_default_page_size_and_stable_ordering(self):
        first = self.client.get(LIST_URL).json()
        self.assertEqual(first['count'], 75)
        self.assertEqual(len(first['results']), 50)
        self.assertIn('page=2', first['next'])
        second = self.client.get(first['next']).json()
        self.assertEqual(len(second['results']), 25)
        names = [u['username'] for u in first['results'] + second['results']]
        self.assertEqual(names, sorted(names))
        self.assertEqual(len(set(names)), 75)

    def test_page_size_capped_at_100(self):
        self.assertEqual(len(self.client.get(LIST_URL + '?page_size=10').json()['results']), 10)
        self.assertEqual(len(self.client.get(LIST_URL + '?page_size=500').json()['results']), 75)
        self.assertEqual(self.client.get(LIST_URL + '?page=9').status_code, 404)


class AccessControlTests(OmkarApiTestCase):
    def setUp(self):
        super().setUp()
        self.omkar = self.make_omkar('ravi_k')

    def requests(self):
        token = getattr(self, 'token', '')
        url = detail_url(self.omkar.pk)
        return [
            ('list', lambda: self.client.get(LIST_URL)),
            ('retrieve', lambda: self.client.get(url)),
            ('create', lambda: self.client.post(LIST_URL, new_omkar(username='intruder', email='i@example.com'), format='json', HTTP_X_CSRFTOKEN=token)),
            ('update', lambda: self.client.patch(url, {'is_active': False}, format='json', HTTP_X_CSRFTOKEN=token)),
        ]

    def assert_unchanged(self):
        self.omkar.refresh_from_db()
        self.assertTrue(self.omkar.is_active)
        self.assertFalse(User.objects.filter(username='intruder').exists())

    def test_unauthenticated_denied(self):
        for name, request in self.requests():
            with self.subTest(name):
                self.assertEqual(request().status_code, 401)
        self.assert_unchanged()

    def test_omkar_denied(self):
        self.sign_in(self.omkar)
        for name, request in self.requests():
            with self.subTest(name):
                response = request()
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json(), {'detail': 'Millionaire role required.'})
        self.assert_unchanged()

    def test_superuser_without_millionaire_role_denied(self):
        self.sign_in(User.objects.create_superuser(username='root', password=PASSWORD))
        for name, request in self.requests():
            with self.subTest(name):
                self.assertEqual(request().status_code, 403)
        self.assert_unchanged()

    def test_writes_require_csrf_token(self):
        self.sign_in()
        url = detail_url(self.omkar.pk)
        responses = [
            self.client.post(LIST_URL, new_omkar(username='intruder', email='i@example.com'), format='json'),
            self.client.patch(url, {'is_active': False}, format='json'),
            self.client.patch(url, {'is_active': False}, format='json', HTTP_X_CSRFTOKEN='wrong' * 8),
        ]
        for response in responses:
            self.assertEqual(response.status_code, 403)
            self.assertIn('CSRF', response.json()['detail'])
        self.assert_unchanged()
