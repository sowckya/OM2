from unittest import mock

from django.test import TestCase
from rest_framework.test import APIClient

from users.models import User

from .models import XAccount
from .serializers import XAccountSerializer

LIST_URL = '/api/x-accounts/'
PASSWORD = 's3cret-pass'
FIELDS = {'id', 'handle', 'display_name', 'status', 'assigned_omkar', 'content_dna_configured', 'created_at', 'updated_at'}
DUPLICATE = 'An X account with this handle already exists.'


def detail_url(pk):
    return f'{LIST_URL}{pk}/'


class XAccountApiTestCase(TestCase):
    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.millionaire = User.objects.create_user(
            username='millionaire1', password=PASSWORD, role=User.Role.MILLIONAIRE
        )
        self.omkar = User.objects.create_user(username='omkar1', password=PASSWORD, role=User.Role.OMKAR)

    def sign_in(self, user=None):
        self.client.force_login(user or self.millionaire)
        self.token = self.client.get('/api/auth/csrf/').json()['csrfToken']

    def post(self, data, **extra):
        return self.client.post(LIST_URL, data, format='json', HTTP_X_CSRFTOKEN=self.token, **extra)

    def patch(self, pk, data):
        return self.client.patch(detail_url(pk), data, format='json', HTTP_X_CSRFTOKEN=self.token)

    def make(self, handle, display_name=None, **kwargs):
        return XAccount.objects.create(handle=handle, display_name=display_name or handle.title(), **kwargs)


class CrudTests(XAccountApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()

    def test_create(self):
        response = self.post({'handle': '@OM2_Telugu', 'display_name': '  OM2 Telugu  '})
        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(set(body), FIELDS)
        self.assertEqual(body['handle'], 'om2_telugu')
        self.assertEqual(body['display_name'], 'OM2 Telugu')
        self.assertEqual(body['status'], 'ACTIVE')
        account = XAccount.objects.get()
        self.assertEqual((account.pk, account.handle), (body['id'], 'om2_telugu'))

    def test_create_with_paused_status(self):
        response = self.post({'handle': 'paused_one', 'display_name': 'Paused', 'status': 'PAUSED'})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()['status'], 'PAUSED')

    def test_list(self):
        self.make('bravo')
        self.make('alpha')
        response = self.client.get(LIST_URL)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {'count', 'next', 'previous', 'results'})
        self.assertEqual(body['count'], 2)
        self.assertEqual([a['handle'] for a in body['results']], ['alpha', 'bravo'])
        self.assertEqual(set(body['results'][0]), FIELDS)

    def test_retrieve(self):
        account = self.make('om2_network', 'OM2 Network')
        response = self.client.get(detail_url(account.pk))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['handle'], 'om2_network')
        self.assertEqual(response.json()['display_name'], 'OM2 Network')

    def test_retrieve_missing_returns_404(self):
        self.assertEqual(self.client.get(detail_url(99999)).status_code, 404)
        self.assertEqual(self.client.get(detail_url('abc')).status_code, 404)

    def test_partial_update(self):
        account = self.make('om2_network', 'OM2 Network')
        response = self.patch(account.pk, {'status': 'PAUSED'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'PAUSED')
        self.assertEqual(response.json()['display_name'], 'OM2 Network')

        response = self.patch(account.pk, {'handle': '@New_Handle', 'display_name': ' Renamed '})
        self.assertEqual(response.status_code, 200)
        account.refresh_from_db()
        self.assertEqual((account.handle, account.display_name, account.status), ('new_handle', 'Renamed', 'PAUSED'))

    def test_update_keeping_own_handle_is_not_a_duplicate(self):
        account = self.make('om2_network')
        response = self.patch(account.pk, {'handle': 'OM2_Network', 'display_name': 'Same handle'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['handle'], 'om2_network')

    def test_read_only_fields_cannot_be_changed(self):
        account = self.make('om2_network')
        original = (account.pk, account.created_at)
        response = self.patch(
            account.pk,
            {'id': 999, 'created_at': '2000-01-01T00:00:00Z', 'updated_at': '2000-01-01T00:00:00Z'},
        )
        self.assertEqual(response.status_code, 200)
        account.refresh_from_db()
        self.assertEqual((account.pk, account.created_at), original)
        self.assertGreater(account.updated_at.year, 2000)
        self.assertFalse(XAccount.objects.filter(pk=999).exists())

        response = self.post({'handle': 'second', 'display_name': 'Second', 'id': 12345, 'created_at': '2000-01-01T00:00:00Z'})
        self.assertEqual(response.status_code, 201)
        self.assertNotEqual(response.json()['id'], 12345)
        self.assertGreater(XAccount.objects.get(handle='second').created_at.year, 2000)

    def test_put_and_delete_not_allowed(self):
        account = self.make('om2_network')
        url = detail_url(account.pk)
        for method in (self.client.put, self.client.delete):
            with self.subTest(method=method.__name__):
                response = method(url, {'handle': 'x', 'display_name': 'X'}, format='json', HTTP_X_CSRFTOKEN=self.token)
                self.assertEqual(response.status_code, 405)
        self.assertEqual(self.client.delete(LIST_URL, HTTP_X_CSRFTOKEN=self.token).status_code, 405)
        self.assertTrue(XAccount.objects.filter(pk=account.pk).exists())


class ValidationTests(XAccountApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()

    def assert_error(self, response, field):
        self.assertEqual(response.status_code, 400)
        body = response.json()
        self.assertIn(field, body)
        self.assertTrue(all(isinstance(m, str) for m in body[field]))
        text = response.content.decode().lower()
        for internal in ('constraint', 'traceback', 'integrity', 'x_account_'):
            self.assertNotIn(internal, text)
        self.assertEqual(XAccount.objects.filter(handle='never_saved').count(), 0)

    def test_invalid_handles_rejected(self):
        for handle in ('om2-network', 'om2 net', 'om2.net', '@@om2', 'tëlugu', '', '@', 'a' * 16):
            with self.subTest(handle=handle):
                self.assert_error(self.post({'handle': handle, 'display_name': 'Name'}), 'handle')
        self.assertEqual(XAccount.objects.count(), 0)

    def test_handle_error_message_is_clear(self):
        response = self.post({'handle': 'om2-network', 'display_name': 'Name'})
        self.assertEqual(
            response.json()['handle'],
            ['Enter a valid X handle: 1–15 letters, numbers or underscores, without @.'],
        )

    def test_duplicate_handle_rejected_regardless_of_case(self):
        self.make('om2_network')
        for handle in ('om2_network', 'OM2_NETWORK', '@Om2_Network'):
            with self.subTest(handle=handle):
                response = self.post({'handle': handle, 'display_name': 'Dup'})
                self.assert_error(response, 'handle')
                self.assertEqual(response.json()['handle'], [DUPLICATE])
        self.assertEqual(XAccount.objects.count(), 1)

    def test_duplicate_handle_rejected_on_update(self):
        self.make('taken')
        other = self.make('other')
        response = self.patch(other.pk, {'handle': '@TAKEN'})
        self.assert_error(response, 'handle')
        self.assertEqual(response.json()['handle'], [DUPLICATE])
        other.refresh_from_db()
        self.assertEqual(other.handle, 'other')

    def test_concurrent_duplicate_returns_400_not_500(self):
        # Simulate a race: validation passes, then the database unique index rejects the insert.
        self.make('om2_network')
        with mock.patch.object(XAccountSerializer, 'validate', lambda self, attrs: attrs):
            response = self.post({'handle': 'om2_network', 'display_name': 'Racer'})
        self.assert_error(response, 'handle')
        self.assertEqual(response.json()['handle'], [DUPLICATE])
        self.assertEqual(XAccount.objects.count(), 1)

    def test_blank_display_name_rejected(self):
        for display_name in ('', '   ', '\t'):
            with self.subTest(display_name=repr(display_name)):
                self.assert_error(self.post({'handle': 'never_saved', 'display_name': display_name}), 'display_name')
        account = self.make('om2_network', 'Keep')
        self.assert_error(self.patch(account.pk, {'display_name': '  '}), 'display_name')
        account.refresh_from_db()
        self.assertEqual(account.display_name, 'Keep')

    def test_too_long_display_name_rejected(self):
        self.assert_error(self.post({'handle': 'never_saved', 'display_name': 'x' * 101}), 'display_name')

    def test_invalid_status_rejected(self):
        for status in ('DELETED', 'active', ''):
            with self.subTest(status=status):
                response = self.post({'handle': 'never_saved', 'display_name': 'Name', 'status': status})
                self.assert_error(response, 'status')

    def test_required_fields(self):
        response = self.post({})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(response.json()), {'handle', 'display_name'})

    def test_wrong_types_rejected(self):
        self.assert_error(self.post({'handle': ['a'], 'display_name': 'Name'}), 'handle')
        self.assert_error(self.post({'handle': 'never_saved', 'display_name': {'x': 1}}), 'display_name')

    def test_malformed_json_returns_400(self):
        response = self.client.post(
            LIST_URL, '{bad json', content_type='application/json', HTTP_X_CSRFTOKEN=self.token
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('detail', response.json())


class ListQueryTests(XAccountApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()
        self.make('om2_telugu', 'Telugu Thoughts')
        self.make('om2_cricket', 'Cricket Daily', status=XAccount.Status.PAUSED)
        self.make('daily_poems', 'Evening Poetry')

    def handles(self, query):
        response = self.client.get(LIST_URL + query)
        self.assertEqual(response.status_code, 200)
        return [a['handle'] for a in response.json()['results']]

    def test_search_by_handle(self):
        self.assertEqual(self.handles('?search=om2'), ['om2_cricket', 'om2_telugu'])
        self.assertEqual(self.handles('?search=@OM2_TEL'), ['om2_telugu'])

    def test_search_by_display_name_case_insensitive(self):
        self.assertEqual(self.handles('?search=poetry'), ['daily_poems'])
        self.assertEqual(self.handles('?search=DAILY'), ['daily_poems', 'om2_cricket'])

    def test_search_with_no_match(self):
        self.assertEqual(self.handles('?search=nothing'), [])

    def test_filter_by_status(self):
        self.assertEqual(self.handles('?status=PAUSED'), ['om2_cricket'])
        self.assertEqual(self.handles('?status=active'), ['daily_poems', 'om2_telugu'])

    def test_search_and_status_combined(self):
        self.assertEqual(self.handles('?search=om2&status=ACTIVE'), ['om2_telugu'])

    def test_invalid_status_filter_rejected(self):
        response = self.client.get(LIST_URL + '?status=DELETED')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {'status': ['Must be one of: ACTIVE, PAUSED.']})


class PaginationTests(XAccountApiTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()
        XAccount.objects.bulk_create(
            [XAccount(handle=f'acct_{i:03d}', display_name=f'Account {i}') for i in range(120)]
        )

    def test_default_page_size_is_50_with_stable_ordering(self):
        first = self.client.get(LIST_URL).json()
        self.assertEqual(first['count'], 120)
        self.assertEqual(len(first['results']), 50)
        self.assertIsNone(first['previous'])
        self.assertIn('page=2', first['next'])

        handles = []
        url = LIST_URL
        while url:
            page = self.client.get(url).json()
            handles += [a['handle'] for a in page['results']]
            url = page['next']
        self.assertEqual(handles, sorted(handles))
        self.assertEqual(len(handles), len(set(handles)), 120)

    def test_page_size_param_capped_at_100(self):
        self.assertEqual(len(self.client.get(LIST_URL + '?page_size=100').json()['results']), 100)
        self.assertEqual(len(self.client.get(LIST_URL + '?page_size=500').json()['results']), 100)
        self.assertEqual(len(self.client.get(LIST_URL + '?page_size=10').json()['results']), 10)

    def test_out_of_range_page_returns_404(self):
        self.assertEqual(self.client.get(LIST_URL + '?page=99').status_code, 404)


class AccessControlTests(XAccountApiTestCase):
    def setUp(self):
        super().setUp()
        self.account = self.make('om2_network')

    def requests(self):
        token = getattr(self, 'token', '')
        url = detail_url(self.account.pk)
        return [
            ('list', lambda: self.client.get(LIST_URL)),
            ('retrieve', lambda: self.client.get(url)),
            ('create', lambda: self.client.post(LIST_URL, {'handle': 'new_one', 'display_name': 'New'}, format='json', HTTP_X_CSRFTOKEN=token)),
            ('update', lambda: self.client.patch(url, {'status': 'PAUSED'}, format='json', HTTP_X_CSRFTOKEN=token)),
        ]

    def assert_unchanged(self):
        self.account.refresh_from_db()
        self.assertEqual(self.account.status, 'ACTIVE')
        self.assertFalse(XAccount.objects.filter(handle='new_one').exists())

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

    def test_inactive_millionaire_denied(self):
        self.millionaire.is_active = False
        self.millionaire.save()
        self.sign_in()
        for name, request in self.requests():
            with self.subTest(name):
                self.assertIn(request().status_code, (401, 403))
        self.assert_unchanged()

    def test_superuser_without_millionaire_role_denied(self):
        admin = User.objects.create_superuser(username='admin', password=PASSWORD)
        self.sign_in(admin)
        self.assertEqual(self.client.get(LIST_URL).status_code, 403)

    def test_writes_require_csrf_token(self):
        self.sign_in()
        url = detail_url(self.account.pk)
        create = self.client.post(LIST_URL, {'handle': 'new_one', 'display_name': 'New'}, format='json')
        update = self.client.patch(url, {'status': 'PAUSED'}, format='json')
        wrong = self.client.patch(url, {'status': 'PAUSED'}, format='json', HTTP_X_CSRFTOKEN='wrong' * 8)
        for response in (create, update, wrong):
            self.assertEqual(response.status_code, 403)
            self.assertIn('CSRF', response.json()['detail'])
        self.assert_unchanged()

    def test_reads_do_not_require_csrf_token(self):
        self.sign_in()
        self.assertEqual(self.client.get(LIST_URL).status_code, 200)
