import threading

from django.core.exceptions import ValidationError
from django.db import connection
from django.test import TestCase, TransactionTestCase
from rest_framework import serializers
from rest_framework.test import APIClient

from users.models import User

from .assignment import INACTIVE_OMKAR, LIMIT_REACHED, NOT_ASSIGNABLE, OMKAR_NOT_FOUND, assign_x_account
from .models import XAccount

PASSWORD = 's3cret-pass'


def make_omkar(username, **kwargs):
    return User.objects.create_user(username=username, password=PASSWORD, role=User.Role.OMKAR, **kwargs)


def make_account(handle, **kwargs):
    return XAccount.objects.create(handle=handle, display_name=handle.title(), **kwargs)


class AssignmentApiTests(TestCase):
    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.millionaire = User.objects.create_user(
            username='millionaire1', password=PASSWORD, role=User.Role.MILLIONAIRE
        )
        self.client.force_login(self.millionaire)
        self.token = self.client.get('/api/auth/csrf/').json()['csrfToken']
        self.ravi = make_omkar('ravi', first_name='Ravi', last_name='Kumar')
        self.sita = make_omkar('sita')
        self.a1, self.a2, self.a3 = (make_account(h) for h in ('acct_one', 'acct_two', 'acct_three'))

    def assign(self, account, omkar_id, **extra):
        return self.client.patch(
            f'/api/x-accounts/{account.pk}/',
            {'assigned_omkar_id': omkar_id, **extra},
            format='json',
            HTTP_X_CSRFTOKEN=self.token,
        )

    def owner(self, account):
        account.refresh_from_db()
        return account.assigned_omkar

    def assert_rejected(self, response, message):
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {'assigned_omkar_id': [message]})

    def test_assign_returns_owner_details(self):
        response = self.assign(self.a1, self.ravi.pk)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()['assigned_omkar'],
            {'id': self.ravi.pk, 'username': 'ravi', 'display_name': 'Ravi Kumar', 'is_active': True},
        )
        self.assertNotIn('assigned_omkar_id', response.json())
        self.assertEqual(self.owner(self.a1), self.ravi)

    def test_unassigned_accounts_show_null(self):
        response = self.client.get(f'/api/x-accounts/{self.a1.pk}/')
        self.assertIsNone(response.json()['assigned_omkar'])

    def test_reassign_to_another_omkar(self):
        self.assign(self.a1, self.ravi.pk)
        response = self.assign(self.a1, self.sita.pk)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.owner(self.a1), self.sita)
        self.assertEqual(self.ravi.x_accounts.count(), 0)

    def test_unassign(self):
        self.assign(self.a1, self.ravi.pk)
        response = self.assign(self.a1, None)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()['assigned_omkar'])
        self.assertIsNone(self.owner(self.a1))

    def test_two_account_limit(self):
        self.assertEqual(self.assign(self.a1, self.ravi.pk).status_code, 200)
        self.assertEqual(self.assign(self.a2, self.ravi.pk).status_code, 200)
        self.assert_rejected(self.assign(self.a3, self.ravi.pk), LIMIT_REACHED)
        self.assertIsNone(self.owner(self.a3))
        self.assertEqual(self.ravi.x_accounts.count(), 2)

    def test_reassigning_into_a_full_omkar_rejected_and_original_owner_kept(self):
        self.assign(self.a1, self.ravi.pk)
        self.assign(self.a2, self.ravi.pk)
        self.assign(self.a3, self.sita.pk)
        self.assert_rejected(self.assign(self.a3, self.ravi.pk), LIMIT_REACHED)
        self.assertEqual(self.owner(self.a3), self.sita)

    def test_reassigning_own_account_at_limit_is_allowed(self):
        self.assign(self.a1, self.ravi.pk)
        self.assign(self.a2, self.ravi.pk)
        self.assertEqual(self.assign(self.a1, self.ravi.pk).status_code, 200)
        self.assertEqual(self.ravi.x_accounts.count(), 2)

    def test_after_unassigning_the_limit_frees_up(self):
        self.assign(self.a1, self.ravi.pk)
        self.assign(self.a2, self.ravi.pk)
        self.assign(self.a1, None)
        self.assertEqual(self.assign(self.a3, self.ravi.pk).status_code, 200)

    def test_account_has_only_one_owner(self):
        self.assign(self.a1, self.ravi.pk)
        self.assign(self.a1, self.sita.pk)
        self.assertEqual(XAccount.objects.filter(pk=self.a1.pk, assigned_omkar__isnull=False).count(), 1)
        self.assertEqual([a.pk for a in self.sita.x_accounts.all()], [self.a1.pk])
        self.assertFalse(self.ravi.x_accounts.exists())

    def test_inactive_omkar_rejected(self):
        self.ravi.is_active = False
        self.ravi.save()
        self.assert_rejected(self.assign(self.a1, self.ravi.pk), INACTIVE_OMKAR)
        self.assertIsNone(self.owner(self.a1))

    def test_non_omkar_users_rejected(self):
        staff_omkar = make_omkar('staff_omkar', is_staff=True)
        superuser = User.objects.create_superuser(username='root', password=PASSWORD)  # role OMKAR
        for user in (self.millionaire, staff_omkar, superuser):
            with self.subTest(user=user.username):
                self.assert_rejected(self.assign(self.a1, user.pk), NOT_ASSIGNABLE)
        self.assertIsNone(self.owner(self.a1))

    def test_unknown_or_malformed_omkar_id_rejected(self):
        self.assert_rejected(self.assign(self.a1, 999999), OMKAR_NOT_FOUND)
        response = self.assign(self.a1, 'abc')
        self.assertEqual(response.status_code, 400)
        self.assertIn('assigned_omkar_id', response.json())

    def test_existing_assignment_kept_when_omkar_deactivated_and_account_still_editable(self):
        self.assign(self.a1, self.ravi.pk)
        self.ravi.is_active = False
        self.ravi.save()
        response = self.client.patch(
            f'/api/x-accounts/{self.a1.pk}/', {'display_name': 'Renamed'}, format='json', HTTP_X_CSRFTOKEN=self.token
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['assigned_omkar']['is_active'], False)
        self.assertEqual(self.owner(self.a1), self.ravi)
        self.assertEqual(self.assign(self.a1, None).status_code, 200)

    def test_assignment_preserves_account_fields_and_status(self):
        paused = make_account('paused_acct', status=XAccount.Status.PAUSED)
        before = XAccount.objects.filter(pk=paused.pk).values('handle', 'display_name', 'status', 'created_at').get()
        self.assign(paused, self.ravi.pk)
        after = XAccount.objects.filter(pk=paused.pk).values('handle', 'display_name', 'status', 'created_at').get()
        self.assertEqual(before, after)

    def test_rejected_assignment_rolls_back_other_changes_in_same_request(self):
        self.assign(self.a1, self.ravi.pk)
        self.assign(self.a2, self.ravi.pk)
        response = self.assign(self.a3, self.ravi.pk, display_name='Should Not Save')
        self.assertEqual(response.status_code, 400)
        self.a3.refresh_from_db()
        self.assertEqual(self.a3.display_name, 'Acct_Three')

    def test_create_with_assignment(self):
        response = self.client.post(
            '/api/x-accounts/',
            {'handle': 'brand_new', 'display_name': 'Brand New', 'assigned_omkar_id': self.ravi.pk},
            format='json',
            HTTP_X_CSRFTOKEN=self.token,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()['assigned_omkar']['id'], self.ravi.pk)

    def test_create_with_invalid_assignment_creates_nothing(self):
        self.ravi.is_active = False
        self.ravi.save()
        response = self.client.post(
            '/api/x-accounts/',
            {'handle': 'brand_new', 'display_name': 'Brand New', 'assigned_omkar_id': self.ravi.pk},
            format='json',
            HTTP_X_CSRFTOKEN=self.token,
        )
        self.assert_rejected(response, INACTIVE_OMKAR)
        self.assertFalse(XAccount.objects.filter(handle='brand_new').exists())

    def test_filters_by_assignment(self):
        self.assign(self.a1, self.ravi.pk)
        self.assign(self.a2, self.sita.pk)

        def handles(query):
            return [a['handle'] for a in self.client.get('/api/x-accounts/' + query).json()['results']]

        self.assertEqual(handles('?assigned=false'), ['acct_three'])
        self.assertEqual(handles('?assigned=true'), ['acct_one', 'acct_two'])
        self.assertEqual(handles(f'?omkar={self.ravi.pk}'), ['acct_one'])
        self.assertEqual(self.client.get('/api/x-accounts/?assigned=maybe').status_code, 400)
        self.assertEqual(self.client.get('/api/x-accounts/?omkar=abc').status_code, 400)

    def test_omkar_api_lists_assigned_accounts(self):
        self.assign(self.a2, self.ravi.pk)
        self.assign(self.a1, self.ravi.pk)
        body = self.client.get(f'/api/omkars/{self.ravi.pk}/').json()
        self.assertEqual([a['handle'] for a in body['x_accounts']], ['acct_one', 'acct_two'])
        self.assertEqual(set(body['x_accounts'][0]), {'id', 'handle', 'display_name', 'status'})
        listed = {o['username']: o['x_accounts'] for o in self.client.get('/api/omkars/').json()['results']}
        self.assertEqual(listed['sita'], [])

    def test_omkar_list_query_count_does_not_grow_per_omkar(self):
        for i in range(10):
            omkar = make_omkar(f'bulk_{i}')
            assign_x_account(make_account(f'bulk_acct_{i}').pk, omkar.pk)
        with self.assertNumQueries(5):  # session, user, count, page, prefetch
            self.client.get('/api/omkars/')

    def test_deleting_an_omkar_keeps_the_x_account(self):
        self.assign(self.a1, self.ravi.pk)
        self.ravi.delete()
        self.a1.refresh_from_db()
        self.assertIsNone(self.a1.assigned_omkar)
        self.assertEqual(self.a1.status, XAccount.Status.ACTIVE)


class AssignmentAccessTests(TestCase):
    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.omkar = make_omkar('ravi')
        self.account = make_account('acct_one')
        self.url = f'/api/x-accounts/{self.account.pk}/'

    def attempt(self, token=''):
        return self.client.patch(self.url, {'assigned_omkar_id': self.omkar.pk}, format='json', HTTP_X_CSRFTOKEN=token)

    def assert_unassigned(self):
        self.account.refresh_from_db()
        self.assertIsNone(self.account.assigned_omkar)

    def test_unauthenticated_denied(self):
        self.assertEqual(self.attempt().status_code, 401)
        self.assert_unassigned()

    def test_omkar_cannot_assign_accounts_to_themselves(self):
        self.client.force_login(self.omkar)
        token = self.client.get('/api/auth/csrf/').json()['csrfToken']
        self.assertEqual(self.attempt(token).status_code, 403)
        self.assert_unassigned()

    def test_csrf_required(self):
        millionaire = User.objects.create_user(username='m1', password=PASSWORD, role=User.Role.MILLIONAIRE)
        self.client.force_login(millionaire)
        response = self.attempt()
        self.assertEqual(response.status_code, 403)
        self.assertIn('CSRF', response.json()['detail'])
        self.assert_unassigned()


class ModelValidationTests(TestCase):
    """Django admin and other full_clean() callers get the same rules (without locking)."""

    def setUp(self):
        self.omkar = make_omkar('ravi')

    def test_full_clean_enforces_limit_and_active(self):
        make_account('one', assigned_omkar=self.omkar)
        make_account('two', assigned_omkar=self.omkar)
        third = XAccount(handle='three', display_name='Three', assigned_omkar=self.omkar)
        with self.assertRaises(ValidationError) as ctx:
            third.full_clean()
        self.assertEqual(ctx.exception.message_dict['assigned_omkar'], [LIMIT_REACHED])

        inactive = make_omkar('gone', is_active=False)
        with self.assertRaises(ValidationError):
            XAccount(handle='four', display_name='Four', assigned_omkar=inactive).full_clean()

    def test_full_clean_rejects_millionaire_via_limit_choices_to(self):
        millionaire = User.objects.create_user(username='m1', password=PASSWORD, role=User.Role.MILLIONAIRE)
        with self.assertRaises(ValidationError) as ctx:
            XAccount(handle='four', display_name='Four', assigned_omkar=millionaire).full_clean()
        self.assertIn('assigned_omkar', ctx.exception.message_dict)

    def test_admin_form_enforces_limit(self):
        admin = User.objects.create_superuser(username='root', password=PASSWORD, role=User.Role.MILLIONAIRE)
        self.client.force_login(admin)
        make_account('one', assigned_omkar=self.omkar)
        make_account('two', assigned_omkar=self.omkar)
        response = self.client.post(
            '/admin/x_accounts/xaccount/add/',
            {'handle': 'three', 'display_name': 'Three', 'status': 'ACTIVE', 'assigned_omkar': self.omkar.pk},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, LIMIT_REACHED)
        self.assertFalse(XAccount.objects.filter(handle='three').exists())


class ConcurrentAssignmentTests(TransactionTestCase):
    """Real parallel transactions (separate DB connections) racing for the same Omkar."""

    def run_in_parallel(self, jobs):
        barrier = threading.Barrier(len(jobs))
        results = [None] * len(jobs)

        def worker(index, job):
            try:
                barrier.wait()
                job()
                results[index] = 'assigned'
            except serializers.ValidationError as exc:
                results[index] = exc.detail['assigned_omkar_id'][0]
            finally:
                connection.close()

        threads = [threading.Thread(target=worker, args=(i, job)) for i, job in enumerate(jobs)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        return results

    def test_parallel_assignments_never_exceed_two(self):
        omkar = make_omkar('ravi')
        accounts = [make_account(f'race_{i}') for i in range(5)]
        results = self.run_in_parallel([lambda pk=a.pk: assign_x_account(pk, omkar.pk) for a in accounts])
        self.assertEqual(results.count('assigned'), 2, results)
        self.assertEqual(results.count(LIMIT_REACHED), 3, results)
        self.assertEqual(XAccount.objects.filter(assigned_omkar=omkar).count(), 2)

    def test_parallel_assignment_when_one_slot_left(self):
        omkar = make_omkar('ravi')
        assign_x_account(make_account('existing').pk, omkar.pk)
        accounts = [make_account(f'race_{i}') for i in range(3)]
        results = self.run_in_parallel([lambda pk=a.pk: assign_x_account(pk, omkar.pk) for a in accounts])
        self.assertEqual(results.count('assigned'), 1, results)
        self.assertEqual(XAccount.objects.filter(assigned_omkar=omkar).count(), 2)

    def test_parallel_claims_on_one_account_leave_a_single_owner(self):
        account = make_account('contested')
        omkars = [make_omkar(f'omkar_{i}') for i in range(4)]
        results = self.run_in_parallel([lambda pk=o.pk: assign_x_account(account.pk, pk) for o in omkars])
        self.assertEqual(results.count('assigned'), 4, results)  # reassignment: last writer wins
        account.refresh_from_db()
        self.assertIn(account.assigned_omkar_id, [o.pk for o in omkars])
        self.assertEqual(sum(o.x_accounts.count() for o in omkars), 1)
