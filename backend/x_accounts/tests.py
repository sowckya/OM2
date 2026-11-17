from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from .models import XAccount


class XAccountModelTests(TestCase):
    def make(self, handle='om2_network', display_name='OM2 Network', **kwargs):
        account = XAccount(handle=handle, display_name=display_name, **kwargs)
        account.full_clean()
        account.save()
        return account

    def assert_field_error(self, field, **kwargs):
        account = XAccount(**{'handle': 'valid_handle', 'display_name': 'Valid', **kwargs})
        with self.assertRaises(ValidationError) as ctx:
            account.full_clean()
        self.assertIn(field, ctx.exception.message_dict)

    def assert_db_rejects(self, **fields):
        # bulk_create skips save()/full_clean(), so only the database can object.
        with self.assertRaises(IntegrityError), transaction.atomic():
            XAccount.objects.bulk_create([XAccount(**fields)])

    # Handle format

    def test_valid_handles(self):
        for handle in ('a', 'om2', 'Om2_Telugu', 'ABCDEFGHIJ12345', '_under_score_'):
            with self.subTest(handle=handle):
                account = self.make(handle=handle)
                self.assertEqual(account.handle, handle.lower())
                account.delete()

    def test_handle_normalized_to_lowercase_without_at_symbol(self):
        account = self.make(handle='  @OM2_Network  ')
        account.refresh_from_db()
        self.assertEqual(account.handle, 'om2_network')

    def test_save_normalizes_even_without_full_clean(self):
        account = XAccount.objects.create(handle='@MixedCase', display_name='Mixed')
        account.refresh_from_db()
        self.assertEqual(account.handle, 'mixedcase')

    def test_invalid_characters_rejected(self):
        for handle in ('om2-network', 'om2.network', 'om2 network', 'om2@network', '@@om2', 'tëlugu', 'om2!'):
            with self.subTest(handle=handle):
                self.assert_field_error('handle', handle=handle)

    def test_empty_handle_rejected(self):
        for handle in ('', '   ', '@'):
            with self.subTest(handle=handle):
                self.assert_field_error('handle', handle=handle)

    def test_handle_longer_than_15_characters_rejected(self):
        self.assert_field_error('handle', handle='a' * 16)
        self.make(handle='a' * 15)  # exactly 15 is allowed

    def test_at_symbol_does_not_count_towards_length(self):
        account = self.make(handle='@' + 'b' * 15)
        self.assertEqual(account.handle, 'b' * 15)

    def test_database_rejects_invalid_handle_format(self):
        for handle in ('UPPER', '@om2', 'om2-network', ''):
            with self.subTest(handle=handle):
                self.assert_db_rejects(handle=handle, display_name='Bypass')

    # Uniqueness

    def test_duplicate_handle_rejected_regardless_of_case(self):
        self.make(handle='om2_network')
        for handle in ('om2_network', 'OM2_Network', '@Om2_NETWORK'):
            with self.subTest(handle=handle):
                with self.assertRaises(ValidationError) as ctx:
                    XAccount(handle=handle, display_name='Duplicate').full_clean()
                self.assertIn('An X account with this handle already exists.', ctx.exception.messages)

    def test_database_enforces_case_insensitive_uniqueness(self):
        self.make(handle='om2_network')
        with self.assertRaises(IntegrityError), transaction.atomic():
            XAccount.objects.create(handle='OM2_NETWORK', display_name='Duplicate')
        self.assertEqual(XAccount.objects.count(), 1)

    # Status

    def test_default_status_is_active(self):
        account = self.make()
        self.assertEqual(account.status, XAccount.Status.ACTIVE)

    def test_paused_status_allowed_and_unknown_status_rejected(self):
        self.assertEqual(self.make(status=XAccount.Status.PAUSED).status, 'PAUSED')
        self.assert_field_error('status', status='DELETED')
        self.assert_db_rejects(handle='bypass', display_name='Bypass', status='DELETED')

    # Display name

    def test_display_name_required(self):
        for display_name in ('', '   ', '\t\n'):
            with self.subTest(display_name=display_name):
                self.assert_field_error('display_name', display_name=display_name)

    def test_display_name_trimmed(self):
        account = self.make(display_name='  OM2 Telugu  ')
        self.assertEqual(account.display_name, 'OM2 Telugu')

    def test_display_name_longer_than_100_characters_rejected(self):
        self.assert_field_error('display_name', display_name='x' * 101)

    def test_database_rejects_blank_display_name(self):
        for display_name in ('', '   '):
            with self.subTest(display_name=display_name):
                self.assert_db_rejects(handle='bypass', display_name=display_name)

    # Timestamps, string and ordering

    def test_timestamps_set_on_create_and_updated_on_save(self):
        before = timezone.now()
        account = self.make()
        self.assertIsNotNone(account.created_at.tzinfo)
        self.assertGreaterEqual(account.created_at, before)
        self.assertGreaterEqual(account.updated_at, account.created_at)

        created_at, first_updated_at = account.created_at, account.updated_at
        account.display_name = 'Renamed'
        account.save()
        account.refresh_from_db()
        self.assertEqual(account.created_at, created_at)
        self.assertGreater(account.updated_at, first_updated_at)

    def test_str_shows_handle_with_at_symbol(self):
        self.assertEqual(str(self.make(handle='OM2_Network')), '@om2_network')

    def test_default_ordering_by_handle(self):
        for handle in ('charlie', 'alpha', 'bravo'):
            self.make(handle=handle)
        self.assertEqual(list(XAccount.objects.values_list('handle', flat=True)), ['alpha', 'bravo', 'charlie'])


class XAccountAdminTests(TestCase):
    def test_admin_pages_render(self):
        from users.models import User

        admin = User.objects.create_superuser(username='admin', password='s3cret-pass')
        self.client.force_login(admin)
        account = XAccount.objects.create(handle='om2_network', display_name='OM2 Network')
        for url in (
            '/admin/x_accounts/xaccount/',
            '/admin/x_accounts/xaccount/add/',
            f'/admin/x_accounts/xaccount/{account.pk}/change/',
        ):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)

    def test_admin_add_form_normalizes_handle_and_rejects_case_duplicates(self):
        from users.models import User

        admin = User.objects.create_superuser(username='admin', password='s3cret-pass')
        self.client.force_login(admin)
        url = '/admin/x_accounts/xaccount/add/'
        data = {'handle': '@OM2_Network', 'display_name': 'OM2 Network', 'status': 'ACTIVE'}

        self.assertEqual(self.client.post(url, data).status_code, 302)
        self.assertEqual(XAccount.objects.get().handle, 'om2_network')

        response = self.client.post(url, {**data, 'handle': 'om2_NETWORK'})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'An X account with this handle already exists.')
        self.assertEqual(XAccount.objects.count(), 1)
