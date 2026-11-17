import threading

from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from users.models import User

from .models import ContentDNA, XAccount
from .views import CONTENT_DNA_EXISTS, CONTENT_DNA_MISSING

PASSWORD = 's3cret-pass'

VALID = {
    'primary_themes': ['Cricket', 'Telugu cinema'],
    'secondary_themes': ['Hyderabad food'],
    'languages': ['ENGLISH', 'TINGLISH'],
    'tone': ['Witty', 'Warm'],
    'target_audience': 'Young Telugu speakers who follow cricket.',
    'writing_style': 'Short, conversational lines with a light punchline.',
    'allowed_formats': ['TEXT', 'POLL'],
    'topics_to_avoid': ['Politics'],
    'example_posts': ['Rain at Uppal again, but the chai stall never cancels.'],
    'daily_post_target': 4,
    'additional_instructions': 'Avoid hashtags.',
}

FIELDS = set(VALID) | {'x_account', 'created_at', 'updated_at'}


def make_dna(account, **overrides):
    return ContentDNA.objects.create(x_account=account, **{**VALID, **overrides})


class ContentDNAApiTests(TestCase):
    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.millionaire = User.objects.create_user(username='boss', password=PASSWORD, role=User.Role.MILLIONAIRE)
        self.client.force_login(self.millionaire)
        self.token = self.client.get('/api/auth/csrf/').json()['csrfToken']
        self.omkar = User.objects.create_user(username='ravi', password=PASSWORD, role=User.Role.OMKAR)
        self.account = XAccount.objects.create(
            handle='om2_cricket', display_name='Cricket Daily', status=XAccount.Status.PAUSED, assigned_omkar=self.omkar
        )
        self.url = f'/api/x-accounts/{self.account.pk}/content-dna/'

    def send(self, method, data, url=None):
        return getattr(self.client, method)(url or self.url, data, format='json', HTTP_X_CSRFTOKEN=self.token)

    def assert_field_error(self, response, field, message):
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn(message, response.json()[field])

    # Missing and configured state

    def test_missing_profile_returns_404_with_configured_false(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {'detail': CONTENT_DNA_MISSING, 'configured': False})

    def test_patch_missing_profile_returns_404_and_creates_nothing(self):
        response = self.send('patch', {'tone': ['Calm']})
        self.assertEqual(response.status_code, 404)
        self.assertFalse(ContentDNA.objects.exists())

    def test_unknown_account_returns_404(self):
        for method in ('get', 'post', 'patch'):
            response = self.send(method, VALID, url='/api/x-accounts/999999/content-dna/')
            self.assertEqual(response.status_code, 404, method)
            self.assertNotIn('configured', response.json())

    def test_x_accounts_report_configured_state(self):
        other = XAccount.objects.create(handle='om2_food', display_name='Food')
        make_dna(other)
        results = {a['handle']: a['content_dna_configured'] for a in self.client.get('/api/x-accounts/').json()['results']}
        self.assertEqual(results, {'om2_cricket': False, 'om2_food': True})
        self.assertTrue(self.client.get(f'/api/x-accounts/{other.pk}/').json()['content_dna_configured'])

    def test_listing_accounts_does_not_query_per_account(self):
        for i in range(5):
            make_dna(XAccount.objects.create(handle=f'acct_{i}', display_name='A'))
        with self.assertNumQueries(4):  # session, user, count, page (with joins)
            self.client.get('/api/x-accounts/')

    # Creation

    def test_create_returns_normalized_profile(self):
        response = self.send(
            'post',
            {
                **VALID,
                'primary_themes': ['  Cricket ', 'Telugu cinema'],
                'languages': ['english', ' Tinglish'],
                'target_audience': '  Young Telugu speakers who follow cricket.  ',
            },
        )
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertEqual(set(body), FIELDS)
        self.assertEqual(body['x_account'], self.account.pk)
        self.assertEqual(body['primary_themes'], ['Cricket', 'Telugu cinema'])
        self.assertEqual(body['languages'], ['ENGLISH', 'TINGLISH'])
        self.assertEqual(body['target_audience'], 'Young Telugu speakers who follow cricket.')
        self.assertEqual(self.client.get(self.url).json(), body)

    def test_optional_fields_default_to_empty(self):
        required = {k: VALID[k] for k in ('primary_themes', 'languages', 'tone', 'target_audience', 'writing_style', 'allowed_formats', 'daily_post_target')}
        response = self.send('post', required)
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        for field in ('secondary_themes', 'topics_to_avoid', 'example_posts'):
            self.assertEqual(body[field], [])
        self.assertEqual(body['additional_instructions'], '')

    def test_required_fields_are_reported(self):
        response = self.send('post', {})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            set(response.json()),
            {'primary_themes', 'languages', 'tone', 'target_audience', 'writing_style', 'allowed_formats', 'daily_post_target'},
        )

    def test_create_preserves_account_and_assignment(self):
        before = XAccount.objects.filter(pk=self.account.pk).values().get()
        self.assertEqual(self.send('post', VALID).status_code, 201)
        self.assertEqual(XAccount.objects.filter(pk=self.account.pk).values().get(), before)

    def test_second_create_conflicts_and_keeps_original(self):
        make_dna(self.account, tone=['Calm'])
        response = self.send('post', VALID)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {'detail': CONTENT_DNA_EXISTS, 'configured': True})
        self.assertEqual(ContentDNA.objects.get().tone, ['Calm'])

    def test_one_profile_per_account_in_database(self):
        make_dna(self.account)
        with self.assertRaises(IntegrityError), transaction.atomic():
            ContentDNA.objects.create(x_account=self.account, **VALID)

    # Editing

    def test_patch_updates_only_given_fields(self):
        dna = make_dna(self.account)
        response = self.send('patch', {'tone': ['Calm', ' Curious '], 'daily_post_target': 6})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['tone'], ['Calm', 'Curious'])
        dna.refresh_from_db()
        self.assertEqual((dna.tone, dna.daily_post_target, dna.primary_themes), (['Calm', 'Curious'], 6, VALID['primary_themes']))

    def test_patch_can_remove_entries_and_clear_optional_text(self):
        make_dna(self.account)
        response = self.send('patch', {'example_posts': [], 'topics_to_avoid': [], 'additional_instructions': ''})
        self.assertEqual(response.status_code, 200, response.content)
        dna = ContentDNA.objects.get()
        self.assertEqual((dna.example_posts, dna.topics_to_avoid, dna.additional_instructions), ([], [], ''))

    def test_rejected_patch_changes_nothing(self):
        make_dna(self.account)
        response = self.send('patch', {'tone': ['Calm'], 'daily_post_target': 0})
        self.assert_field_error(response, 'daily_post_target', 'Set a target of at least 1 post per day.')
        self.assertEqual(ContentDNA.objects.get().tone, VALID['tone'])

    def test_patch_validates_against_stored_values(self):
        make_dna(self.account)
        response = self.send('patch', {'secondary_themes': ['cricket']})
        self.assert_field_error(response, 'secondary_themes', '“cricket” is already a primary theme.')

    def test_read_only_fields_are_ignored(self):
        other = XAccount.objects.create(handle='other', display_name='Other')
        make_dna(self.account)
        self.send('patch', {'x_account': other.pk, 'created_at': '2000-01-01T00:00:00Z'})
        dna = ContentDNA.objects.get()
        self.assertEqual(dna.x_account_id, self.account.pk)
        self.assertNotEqual(dna.created_at.year, 2000)

    def test_put_and_delete_are_not_allowed(self):
        make_dna(self.account)
        for method in ('put', 'delete'):
            self.assertEqual(self.send(method, VALID).status_code, 405, method)
        self.assertTrue(ContentDNA.objects.exists())

    # Validation

    def test_list_validation(self):
        cases = [
            ('primary_themes', [], 'Add at least one primary theme.'),
            ('primary_themes', ['a', 'b', 'c', 'd', 'e', 'f'], 'Use at most 5 primary theme.'),
            ('primary_themes', ['Cricket', '   '], 'Entry 2 is blank.'),
            ('primary_themes', ['Cricket', 'CRICKET'], '“CRICKET” is listed more than once.'),
            ('primary_themes', ['x' * 61], 'Entry 1 is longer than 60 characters.'),
            ('tone', [], 'Add at least one tone.'),
            ('languages', [], 'Add at least one language.'),
            ('languages', ['HINDI'], '“HINDI” is not a valid option. Choose from: English, Telugu, Tinglish.'),
            ('allowed_formats', ['VIDEO'], '“VIDEO” is not a valid option. Choose from: Text, Thread, Poll.'),
            ('allowed_formats', [], 'Add at least one format.'),
            ('example_posts', ['x' * 1001], 'Entry 1 is longer than 1000 characters.'),
            ('topics_to_avoid', ['Politics', 'cricket'], '“cricket” is also one of this account’s themes.'),
            ('secondary_themes', ['Telugu Cinema'], '“Telugu Cinema” is already a primary theme.'),
        ]
        for field, value, message in cases:
            with self.subTest(field=field, value=value):
                self.assert_field_error(self.send('post', {**VALID, field: value}), field, message)
        self.assertFalse(ContentDNA.objects.exists())

    def test_all_field_errors_are_reported_together(self):
        response = self.send('post', {**VALID, 'primary_themes': [], 'languages': ['HINDI'], 'target_audience': ' ', 'daily_post_target': 0})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(response.json()), {'primary_themes', 'languages', 'target_audience', 'daily_post_target'})
        self.assertEqual(response.json()['daily_post_target'], ['Set a target of at least 1 post per day.'])

    def test_wrong_types_are_rejected(self):
        for field, value in [('tone', 'Witty'), ('tone', [{'a': 1}]), ('languages', [None]), ('daily_post_target', 'four'), ('daily_post_target', True), ('daily_post_target', 2.5)]:
            with self.subTest(field=field, value=value):
                response = self.send('post', {**VALID, field: value})
                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.json())

    def test_daily_target_range(self):
        for value, ok in [(0, False), (-1, False), (1, True), (20, True), (21, False)]:
            with self.subTest(value=value):
                ContentDNA.objects.all().delete()
                self.assertEqual(self.send('post', {**VALID, 'daily_post_target': value}).status_code, 201 if ok else 400)

    def test_blank_and_long_text(self):
        self.assert_field_error(self.send('post', {**VALID, 'target_audience': '   '}), 'target_audience', 'This field cannot be blank.')
        self.assertIn('writing_style', self.send('post', {**VALID, 'writing_style': ''}).json())
        response = self.send('post', {**VALID, 'additional_instructions': 'x' * 2001})
        self.assertIn('additional_instructions', response.json())
        self.assertFalse(ContentDNA.objects.exists())

    # Access

    def test_requires_authentication(self):
        anonymous = APIClient()
        self.assertEqual(anonymous.get(self.url).status_code, 401)
        self.assertEqual(anonymous.post(self.url, VALID, format='json').status_code, 401)

    def test_omkar_is_forbidden_even_for_own_account(self):
        make_dna(self.account)
        client = APIClient()
        client.force_login(self.omkar)
        self.assertEqual(client.get(self.url).status_code, 403)
        self.assertEqual(client.patch(self.url, {'tone': ['Calm']}, format='json').status_code, 403)
        self.assertEqual(ContentDNA.objects.get().tone, VALID['tone'])

    def test_csrf_required_for_writes(self):
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.millionaire)
        self.assertEqual(client.post(self.url, VALID, format='json').status_code, 403)
        self.assertFalse(ContentDNA.objects.exists())
        make_dna(self.account)
        self.assertEqual(client.patch(self.url, {'tone': ['Calm']}, format='json').status_code, 403)
        self.assertEqual(ContentDNA.objects.get().tone, VALID['tone'])


class ContentDNAModelTests(TestCase):
    def setUp(self):
        self.account = XAccount.objects.create(handle='acct', display_name='Acct')

    def test_full_clean_reports_field_messages(self):
        dna = ContentDNA(x_account=self.account, **{**VALID, 'languages': ['KLINGON'], 'tone': []})
        with self.assertRaises(ValidationError) as ctx:
            dna.full_clean()
        self.assertIn('languages', ctx.exception.message_dict)
        self.assertEqual(ctx.exception.message_dict['tone'], ['Add at least one tone.'])

    def test_database_constraints_block_invalid_rows(self):
        for overrides in [
            {'daily_post_target': 0},
            {'daily_post_target': 21},
            {'primary_themes': []},
            {'tone': []},
            {'languages': ['KLINGON']},
            {'allowed_formats': []},
            {'target_audience': '  '},
        ]:
            with self.subTest(overrides=overrides), self.assertRaises(IntegrityError), transaction.atomic():
                # .update() skips save() normalisation and model validation.
                dna = make_dna(self.account)
                ContentDNA.objects.filter(pk=dna.pk).update(**overrides)

    def test_deleting_account_deletes_profile(self):
        make_dna(self.account)
        self.account.delete()
        self.assertFalse(ContentDNA.objects.exists())

    def test_admin_is_read_only(self):
        admin = User.objects.create_superuser(username='root', password=PASSWORD)
        self.client.force_login(admin)
        dna = make_dna(self.account)
        self.assertEqual(self.client.get('/admin/x_accounts/contentdna/').status_code, 200)
        self.assertEqual(self.client.get('/admin/x_accounts/contentdna/add/').status_code, 403)
        self.client.post(f'/admin/x_accounts/contentdna/{dna.pk}/change/', {'tone': 'Changed'})
        dna.refresh_from_db()
        self.assertEqual(dna.tone, VALID['tone'])


class ConcurrentCreateTests(TransactionTestCase):
    def test_parallel_creates_make_one_profile(self):
        millionaire = User.objects.create_user(username='boss', password=PASSWORD, role=User.Role.MILLIONAIRE)
        account = XAccount.objects.create(handle='acct', display_name='Acct')
        url = f'/api/x-accounts/{account.pk}/content-dna/'
        barrier = threading.Barrier(4)
        statuses = []

        def create(tone):
            try:
                client = APIClient()
                client.force_login(millionaire)
                barrier.wait()
                statuses.append(client.post(url, {**VALID, 'tone': [tone]}, format='json').status_code)
            finally:
                connection.close()

        threads = [threading.Thread(target=create, args=(f'Tone {i}',)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(statuses), [201, 409, 409, 409])
        self.assertEqual(ContentDNA.objects.count(), 1)
