import threading

from django.db import connection
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from users.models import User
from x_accounts.models import ContentDNA, XAccount

from . import services
from .models import ContentItem, ContentRevision, GenerationRun
from .test_generation import DNA

PASSWORD = 's3cret-pass'


class ContentApiTests(TestCase):
    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.boss = User.objects.create_user(username='boss', password=PASSWORD, role=User.Role.MILLIONAIRE, first_name='Mona')
        self.client.force_login(self.boss)
        self.token = self.client.get('/api/auth/csrf/').json()['csrfToken']
        self.omkar = User.objects.create_user(username='ravi', password=PASSWORD, role=User.Role.OMKAR)
        self.account = XAccount.objects.create(handle='om2_cricket', display_name='Cricket', assigned_omkar=self.omkar)
        ContentDNA.objects.create(x_account=self.account, **DNA)
        self.bare = XAccount.objects.create(handle='bare', display_name='Bare')

    def post(self, url, data=None):
        return self.client.post(url, data or {}, format='json', HTTP_X_CSRFTOKEN=self.token)

    def patch(self, url, data):
        return self.client.patch(url, data, format='json', HTTP_X_CSRFTOKEN=self.token)

    def manual(self, body='A post written by hand', account=None, **extra):
        response = self.post('/api/content/items/', {'x_account_id': (account or self.account).pk, 'format': 'TEXT', 'body': body, **extra})
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def url(self, item, suffix=''):
        return f'/api/content/items/{item["id"]}/{suffix}'

    # Provider and generation

    def test_provider_reports_mock(self):
        self.assertEqual(
            self.client.get('/api/content/provider/').json(),
            {'name': 'mock', 'model_name': 'mock-templates-v1', 'label': 'Mock provider (sample text, no AI)', 'is_mock': True},
        )

    def test_generate_for_several_accounts(self):
        response = self.post('/api/content/generate/', {'x_account_ids': [self.account.pk, self.bare.pk], 'count': 3, 'instructions': ' weekend '})
        self.assertEqual(response.status_code, 200, response.content)
        first, second = response.json()['results']
        self.assertEqual(first['x_account']['handle'], 'om2_cricket')
        self.assertEqual(len(first['items']), 3)
        self.assertEqual(first['run']['is_mock'], True)
        self.assertEqual(first['run']['item_count'], 3)
        self.assertEqual(first['run']['instructions'], 'weekend')
        self.assertTrue(all(i['generation']['is_mock'] for i in first['items']))
        self.assertIn('MOCK_CONTENT', [w['code'] for w in first['items'][0]['warnings']])
        self.assertEqual(second['error'], 'Content DNA is not configured for this account. Set it up before generating.')
        # Account data and assignment are untouched.
        self.account.refresh_from_db()
        self.assertEqual(self.account.assigned_omkar, self.omkar)

    def test_generate_validation(self):
        cases = [
            ({'x_account_ids': [], 'count': 1}, 'x_account_ids'),
            ({'x_account_ids': [999], 'count': 1}, 'x_account_ids'),
            ({'x_account_ids': list(range(1, 22)), 'count': 1}, 'x_account_ids'),
            ({'x_account_ids': [self.account.pk], 'count': 0}, 'count'),
            ({'x_account_ids': [self.account.pk], 'count': 6}, 'count'),
            ({'x_account_ids': [self.account.pk], 'count': 1, 'format': 'VIDEO'}, 'format'),
        ]
        for data, field in cases:
            with self.subTest(data=data):
                response = self.post('/api/content/generate/', data)
                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.json())
        self.assertFalse(GenerationRun.objects.exists())

    def test_runs_history(self):
        self.post('/api/content/generate/', {'x_account_ids': [self.account.pk], 'count': 2})
        runs = self.client.get(f'/api/content/runs/?x_account={self.account.pk}').json()
        self.assertEqual(runs['count'], 1)
        run = runs['results'][0]
        self.assertEqual((run['item_count'], run['requested_by']['username'], run['status']), (2, 'boss', 'SUCCEEDED'))
        self.assertNotIn('prompt', run)
        detail = self.client.get(f'/api/content/runs/{run["id"]}/').json()
        self.assertIn('Primary themes: Cricket, Telugu cinema', detail['prompt'])
        self.assertEqual(detail['dna_snapshot']['tone'], ['Witty'])
        self.assertEqual(self.post('/api/content/runs/', {}).status_code, 405)

    # Manual creation and editing

    def test_manual_creation(self):
        item = self.manual('  Hand written  ', theme='Cricket', language='ENGLISH')
        self.assertEqual((item['body'], item['source'], item['status'], item['version']), ('Hand written', 'MANUAL', 'DRAFT', 1))
        self.assertEqual(item['created_by']['display_name'], 'Mona')
        self.assertEqual(item['dna_snapshot']['primary_themes'], DNA['primary_themes'])
        self.assertIsNone(item['generation'])
        self.assertEqual(item['warnings'], [])

    def test_manual_thread_and_poll(self):
        thread = self.manual(format='THREAD', body='ignored', thread_posts=[' One ', 'Two'])
        self.assertEqual((thread['body'], thread['thread_posts']), ('', ['One', 'Two']))
        poll = self.manual(format='POLL', body='Pick one?', poll_options=['A', 'B'], thread_posts=['x'])
        self.assertEqual((poll['poll_options'], poll['thread_posts']), (['A', 'B'], []))

    def test_manual_validation(self):
        cases = [
            ({'format': 'TEXT', 'body': ''}, 'body'),
            ({'format': 'TEXT', 'body': 'x' * 281}, 'body'),
            ({'format': 'THREAD', 'thread_posts': ['only one']}, 'thread_posts'),
            ({'format': 'POLL', 'body': 'Q?', 'poll_options': ['A']}, 'poll_options'),
            ({'body': 'no format'}, 'format'),
            ({'format': 'TEXT', 'body': 'x', 'status': 'APPROVED'}, 'status'),
        ]
        for data, field in cases:
            with self.subTest(data=data):
                response = self.post('/api/content/items/', {'x_account_id': self.account.pk, **data})
                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.json())
        response = self.post('/api/content/items/', {'format': 'TEXT', 'body': 'x'})
        self.assertIn('x_account_id', response.json())
        response = self.post('/api/content/items/', {'x_account_id': 999, 'format': 'TEXT', 'body': 'x'})
        self.assertEqual(response.json()['x_account_id'], ['X account not found.'])
        self.assertFalse(ContentItem.objects.exists())

    def test_manual_without_dna_and_with_warnings(self):
        item = self.manual('Hello', account=self.bare)
        self.assertEqual([w['code'] for w in item['warnings']], ['NO_CONTENT_DNA'])
        item = self.manual('Talking politics today https://x.com', format='TEXT')
        self.assertEqual([w['code'] for w in item['warnings']], ['AVOIDED_TOPIC', 'CONTAINS_LINK'])

    def test_duplicates_are_flagged_across_accounts(self):
        other = XAccount.objects.create(handle='other', display_name='Other')
        first = self.manual('Rain at Uppal again, the chai stall never cancels', account=other)
        second = self.manual('rain at uppal again the chai stall never cancels!')
        flag = second['duplicate_flags'][0]
        self.assertEqual((flag['kind'], flag['scope'], flag['item_id']), ('EXACT', 'NETWORK', first['id']))
        self.assertIn('DUPLICATE', [w['code'] for w in second['warnings']])

    def test_edit_records_history_and_rechecks(self):
        item = self.manual('Original text here')
        response = self.patch(self.url(item), {'body': 'Now about politics', 'version': 1})
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual((body['body'], body['version']), ('Now about politics', 2))
        self.assertEqual([w['code'] for w in body['warnings']], ['AVOIDED_TOPIC'])
        revisions = self.client.get(self.url(item, 'revisions/')).json()
        self.assertEqual([(r['version'], r['action'], r['body']) for r in revisions], [(2, 'EDITED', 'Now about politics'), (1, 'CREATED', 'Original text here')])
        self.assertEqual(revisions[0]['changed_by']['username'], 'boss')

    def test_edit_can_change_format(self):
        item = self.manual('Original')
        body = self.patch(self.url(item), {'format': 'THREAD', 'thread_posts': ['One', 'Two']}).json()
        self.assertEqual((body['format'], body['body'], body['thread_posts']), ('THREAD', '', ['One', 'Two']))

    def test_edit_without_changes_keeps_version(self):
        item = self.manual('Same')
        self.assertEqual(self.patch(self.url(item), {'body': ' Same '}).json()['version'], 1)
        self.assertEqual(ContentRevision.objects.count(), 1)

    def test_stale_version_conflicts(self):
        item = self.manual('Original')
        self.patch(self.url(item), {'body': 'First edit'})
        response = self.patch(self.url(item), {'body': 'Second edit', 'version': 1})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(ContentItem.objects.get().body, 'First edit')

    def test_invalid_edit_changes_nothing(self):
        item = self.manual('Original')
        self.assertEqual(self.patch(self.url(item), {'body': 'x' * 281}).status_code, 400)
        self.assertEqual(self.patch(self.url(item), {'x_account_id': self.bare.pk}).status_code, 400)
        self.assertEqual(ContentItem.objects.get().body, 'Original')
        self.assertEqual(self.client.put(self.url(item), {'body': 'x'}, format='json', HTTP_X_CSRFTOKEN=self.token).status_code, 405)
        self.assertEqual(self.client.delete(self.url(item), HTTP_X_CSRFTOKEN=self.token).status_code, 405)

    def test_ai_item_loses_mock_warning_once_edited(self):
        result = self.post('/api/content/generate/', {'x_account_ids': [self.account.pk], 'count': 1, 'format': 'TEXT'}).json()
        item = result['results'][0]['items'][0]
        edited = self.patch(self.url(item), {'body': 'Rewritten by a person'}).json()
        self.assertNotIn('MOCK_CONTENT', [w['code'] for w in edited['warnings']])
        self.assertEqual(edited['source'], 'AI')

    # Review

    def test_approve_reject_restore(self):
        item = self.manual('Clean post')
        approved = self.post(self.url(item, 'approve/')).json()
        self.assertEqual((approved['status'], approved['reviewed_by']['username']), ('APPROVED', 'boss'))
        self.assertIsNotNone(approved['reviewed_at'])
        self.assertEqual(self.post(self.url(item, 'approve/')).status_code, 409)

        rejected = self.post(self.url(item, 'reject/'), {'reason': 'Off-brand'}).json()
        self.assertEqual((rejected['status'], rejected['rejection_reason']), ('REJECTED', 'Off-brand'))
        self.assertEqual(self.patch(self.url(item), {'body': 'Edit'}).status_code, 409)
        self.assertEqual(self.post(self.url(item, 'approve/')).status_code, 409)

        restored = self.post(self.url(item, 'restore/')).json()
        self.assertEqual((restored['status'], restored['rejection_reason'], restored['reviewed_by']), ('DRAFT', '', None))
        self.assertEqual(self.post(self.url(item, 'restore/')).status_code, 409)
        actions = [r['action'] for r in self.client.get(self.url(item, 'revisions/')).json()]
        self.assertEqual(actions, ['RESTORED', 'REJECTED', 'APPROVED', 'CREATED'])

    def test_approval_requires_acknowledging_warnings(self):
        item = self.manual('Talking politics')
        response = self.post(self.url(item, 'approve/'))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()['warnings'][0]['code'], 'AVOIDED_TOPIC')
        self.assertEqual(ContentItem.objects.get().status, 'DRAFT')
        response = self.post(self.url(item, 'approve/'), {'acknowledge_warnings': True})
        self.assertEqual(response.json()['status'], 'APPROVED')
        self.assertEqual(ContentRevision.objects.filter(action='APPROVED').get().note, 'Approved with warnings')

    def test_approval_rechecks_duplicates_added_later(self):
        item = self.manual('Unique for now')
        self.assertEqual(item['warnings'], [])
        self.manual('Unique for now!', account=self.bare)
        response = self.post(self.url(item, 'approve/'))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()['warnings'][0]['code'], 'DUPLICATE')

    def test_editing_approved_post_returns_it_to_draft(self):
        item = self.manual('Approved text')
        self.post(self.url(item, 'approve/'))
        body = self.patch(self.url(item), {'body': 'Changed after approval'}).json()
        self.assertEqual((body['status'], body['reviewed_by']), ('DRAFT', None))
        self.assertEqual(self.client.get(self.url(item, 'revisions/')).json()[0]['note'], 'Edited after approval; needs approval again.')

    def test_bulk_approve(self):
        clean = [self.manual(body) for body in ('Morning nets at Uppal', 'Biryani after the match')]
        flagged = self.manual('About politics')
        ids = [i['id'] for i in clean] + [flagged['id']]
        response = self.post('/api/content/items/bulk-approve/', {'ids': ids})
        self.assertEqual(response.status_code, 400)
        self.assertEqual([f['id'] for f in response.json()['flagged']], [flagged['id']])
        self.assertFalse(ContentItem.objects.filter(status='APPROVED').exists())

        response = self.post('/api/content/items/bulk-approve/', {'ids': ids, 'acknowledge_warnings': True})
        self.assertEqual(sorted(response.json()['approved']), sorted(ids))
        self.assertEqual(ContentItem.objects.filter(status='APPROVED').count(), 3)

        response = self.post('/api/content/items/bulk-approve/', {'ids': ids[:1]})
        self.assertIn('Only drafts', response.json()['ids'][0])
        self.assertIn('not found', self.post('/api/content/items/bulk-approve/', {'ids': [999]}).json()['ids'][0])

    # Library

    def test_library_filters(self):
        a = self.manual('First about cricket', theme='Cricket')
        b = self.manual('Second post', account=self.bare)
        c = self.manual('Third with politics')
        self.post(self.url(a, 'approve/'))
        self.post(self.url(b, 'reject/'))
        self.post('/api/content/generate/', {'x_account_ids': [self.account.pk], 'count': 1, 'format': 'POLL'})

        def ids(query):
            response = self.client.get(f'/api/content/items/?{query}')
            self.assertEqual(response.status_code, 200, response.content)
            return {i['id'] for i in response.json()['results']}

        self.assertEqual(ids(f'x_account={self.bare.pk}'), {b['id']})
        self.assertEqual(ids('status=approved'), {a['id']})
        self.assertEqual(ids('status=REJECTED'), {b['id']})
        self.assertEqual(len(ids('source=AI')), 1)
        self.assertEqual(ids('source=MANUAL'), {a['id'], b['id'], c['id']})
        self.assertEqual(len(ids('post_format=POLL')), 1)
        self.assertEqual(ids('search=CRICKET&source=MANUAL'), {a['id'], c['id']})  # theme or handle
        self.assertEqual(ids('search=politics'), {c['id']})
        self.assertIn(c['id'], ids('flagged=true'))
        self.assertNotIn(a['id'], ids('flagged=true'))
        self.assertEqual(len(ids('created_after=2000-01-01&created_before=2999-12-31')), 4)
        self.assertEqual(ids('created_after=2999-01-01'), set())
        for bad in ('status=LIVE', 'x_account=abc', 'created_after=yesterday', 'flagged=maybe', 'post_format=VIDEO'):
            self.assertEqual(self.client.get(f'/api/content/items/?{bad}').status_code, 400, bad)

    def test_search_matches_thread_and_poll_text(self):
        thread = self.manual(format='THREAD', thread_posts=['Opening', 'Mentions biryani here'])
        poll = self.manual(format='POLL', body='Pick?', poll_options=['Dosa', 'Idli'])
        self.assertEqual([i['id'] for i in self.client.get('/api/content/items/?search=biryani').json()['results']], [thread['id']])
        self.assertEqual([i['id'] for i in self.client.get('/api/content/items/?search=idli').json()['results']], [poll['id']])

    def test_pagination_and_query_count(self):
        for i in range(30):
            ContentItem.objects.create(x_account=self.account, source='MANUAL', format='TEXT', body=f'Post {i}', fingerprint=str(i))
        page = self.client.get('/api/content/items/').json()
        self.assertEqual((page['count'], len(page['results'])), (30, 25))
        self.assertEqual(len(self.client.get('/api/content/items/?page=2').json()['results']), 5)
        with self.assertNumQueries(4):  # session, user, count, page with joins
            self.client.get('/api/content/items/?page_size=100')

    # Access

    def test_access_control(self):
        item = self.manual('Protected')
        anonymous = APIClient()
        omkar = APIClient()
        omkar.force_login(self.omkar)
        urls = ['/api/content/provider/', '/api/content/items/', self.url(item), self.url(item, 'revisions/'), '/api/content/runs/']
        for url in urls:
            self.assertEqual(anonymous.get(url).status_code, 401, url)
            self.assertEqual(omkar.get(url).status_code, 403, url)
        for url, data in [('/api/content/generate/', {'x_account_ids': [self.account.pk], 'count': 1}), (self.url(item, 'approve/'), {}), ('/api/content/items/', {'x_account_id': self.account.pk, 'format': 'TEXT', 'body': 'x'})]:
            self.assertEqual(omkar.post(url, data, format='json').status_code, 403, url)
        self.assertEqual(ContentItem.objects.get().status, 'DRAFT')

    def test_csrf_required_for_writes(self):
        item = self.manual('Needs CSRF')
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.boss)
        for url, data in [
            ('/api/content/generate/', {'x_account_ids': [self.account.pk], 'count': 1}),
            ('/api/content/items/', {'x_account_id': self.account.pk, 'format': 'TEXT', 'body': 'x'}),
            (self.url(item, 'approve/'), {}),
            (self.url(item, 'reject/'), {}),
            ('/api/content/items/bulk-approve/', {'ids': [item['id']]}),
        ]:
            self.assertEqual(client.post(url, data, format='json').status_code, 403, url)
        self.assertEqual(client.patch(self.url(item), {'body': 'x'}, format='json').status_code, 403)
        self.assertEqual(ContentItem.objects.get().status, 'DRAFT')
        self.assertFalse(GenerationRun.objects.exists())

    def test_admin_is_read_only(self):
        self.manual('Admin view')
        root = User.objects.create_superuser(username='root', password=PASSWORD)
        client = APIClient()
        client.force_login(root)
        self.assertEqual(client.get('/admin/content/contentitem/').status_code, 200)
        self.assertEqual(client.get('/admin/content/contentitem/add/').status_code, 403)


class ConcurrentReviewTests(TransactionTestCase):
    def test_parallel_approvals_approve_once(self):
        boss = User.objects.create_user(username='boss', password=PASSWORD, role=User.Role.MILLIONAIRE)
        account = XAccount.objects.create(handle='acct', display_name='Acct')
        ContentDNA.objects.create(x_account=account, **DNA)
        item = services.create_manual(account, boss, fmt='TEXT', body='Approve me once')
        barrier = threading.Barrier(4)
        statuses = []

        def approve():
            try:
                client = APIClient()
                client.force_login(boss)
                barrier.wait()
                statuses.append(client.post(f'/api/content/items/{item.pk}/approve/', {}, format='json').status_code)
            finally:
                connection.close()

        threads = [threading.Thread(target=approve) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(statuses), [200, 409, 409, 409])
        self.assertEqual(ContentRevision.objects.filter(action='APPROVED').count(), 1)
