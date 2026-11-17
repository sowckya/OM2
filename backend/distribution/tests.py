import io
import json
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from content.models import ContentItem
from content.whatsapp import x_intent_url
from users.models import User
from x_accounts.models import XAccount

from . import services
from .models import DistributionMessage, DistributionMessageItem

PASSWORD = 's3cret-pass'
CANDIDATES = '/api/distribution/candidates/'
BATCHES = '/api/distribution/batches/'


def message_url(message_id, action):
    return f'/api/distribution/messages/{message_id}/{action}/'


def decoded(url):
    return parse_qs(urlsplit(url).query)['text'][0]


class DistributionTestCase(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient(enforce_csrf_checks=True)
        self.boss = User.objects.create_user(username='boss', password=PASSWORD, role=User.Role.MILLIONAIRE)
        self.client.force_login(self.boss)
        self.token = self.client.get('/api/auth/csrf/').json()['csrfToken']
        self.ravi = self.omkar('ravi', 'Ravi', '+919876543210')
        self.sita = self.omkar('sita', 'Sita', '+919812345678')
        self.cricket = XAccount.objects.create(handle='om2_cricket', display_name='Cricket', assigned_omkar=self.ravi)
        self.food = XAccount.objects.create(handle='om2_food', display_name='Food', assigned_omkar=self.ravi)
        self.films = XAccount.objects.create(handle='om2_films', display_name='Films', assigned_omkar=self.sita)

    def omkar(self, username, first_name, phone):
        return User.objects.create_user(
            username=username, password=PASSWORD, role=User.Role.OMKAR, first_name=first_name, phone_number=phone
        )

    def post_item(self, account, body='A post', status=ContentItem.Status.APPROVED, **fields):
        fields.setdefault('format', 'TEXT')
        return ContentItem.objects.create(x_account=account, source='MANUAL', status=status, body=body, fingerprint='x', **fields)

    def post(self, url, data=None):
        return self.client.post(url, data or {}, format='json', HTTP_X_CSRFTOKEN=self.token)

    def prepare(self, items, expected=201, **extra):
        response = self.post(BATCHES, {'item_ids': [i.pk for i in items], **extra})
        self.assertEqual(response.status_code, expected, response.content)
        return response.json()


class CandidateTests(DistributionTestCase):
    def test_groups_approved_posts_by_omkar_with_reasons(self):
        a = self.post_item(self.cricket, 'Cricket post')
        b = self.post_item(self.films, 'Film post')
        self.post_item(self.food, 'Draft only', status=ContentItem.Status.DRAFT)
        XAccount.objects.create(handle='loose', display_name='Loose')
        self.post_item(XAccount.objects.get(handle='loose'), 'Unassigned')
        User.objects.filter(pk=self.sita.pk).update(phone_number='')

        data = self.client.get(CANDIDATES).json()
        self.assertEqual(data['unassigned_count'], 1)
        ravi, sita = data['omkars']
        self.assertEqual(ravi['omkar']['display_name'], 'Ravi')
        self.assertEqual([a['handle'] for a in ravi['accounts']], ['om2_cricket', 'om2_food'])
        self.assertEqual([p['id'] for p in ravi['posts']], [a.pk])
        self.assertIsNone(ravi['unavailable_reason'])
        self.assertIsNone(ravi['posts'][0]['unavailable_reason'])
        self.assertEqual(sita['unavailable_reason'], 'Sita has no WhatsApp number saved.')
        self.assertEqual(sita['posts'][0]['id'], b.pk)
        self.assertEqual(sita['posts'][0]['unavailable_reason'], 'Sita has no WhatsApp number saved.')

    def test_inactive_omkars_and_paused_accounts(self):
        self.post_item(self.cricket)
        self.post_item(self.films)
        User.objects.filter(pk=self.sita.pk).update(is_active=False)
        XAccount.objects.filter(pk=self.cricket.pk).update(status='PAUSED')
        ravi, sita = self.client.get(CANDIDATES).json()['omkars']
        self.assertEqual(ravi['posts'][0]['unavailable_reason'], '@om2_cricket is paused.')
        self.assertEqual(sita['unavailable_reason'], 'Sita is inactive.')

    def test_millionaires_only(self):
        self.client.force_login(self.ravi)
        for url in (CANDIDATES, BATCHES, f'{BATCHES}1/'):
            self.assertEqual(self.client.get(url).status_code, 403)
        self.client.logout()
        self.assertIn(self.client.get(CANDIDATES).status_code, (401, 403))


class PrepareTests(DistributionTestCase):
    def test_groups_up_to_five_posts_per_message_per_omkar(self):
        ravi_items = [self.post_item(self.cricket if n % 2 else self.food, f'Ravi post {n} & more #{n}') for n in range(7)]
        sita_item = self.post_item(self.films, 'Sita post')
        batch = self.prepare([*ravi_items, sita_item])

        messages = batch['messages']
        self.assertEqual([(m['omkar']['display_name'], m['position'], m['of'], len(m['posts'])) for m in messages],
                         [('Ravi', 1, 2, 5), ('Ravi', 2, 2, 2), ('Sita', 1, 1, 1)])
        self.assertTrue(all(m['status'] == 'PENDING' for m in messages))
        first = messages[0]
        self.assertTrue(first['url'].startswith('https://wa.me/919876543210?text='))
        text = decoded(first['url'])
        self.assertEqual(text, first['text'])
        self.assertTrue(text.startswith('Hi Ravi,\n\nPlease post these 5 posts on X:\n\nPost 1 of 5 · @om2_cricket\n'))
        both = text + messages[1]['text']
        for item in ravi_items:
            # Complete post, its own handle and its own compose link.
            self.assertIn(f'@{item.x_account.handle}\n{item.body}\nOpen in X: {x_intent_url(item.body)}', both)
        self.assertTrue(text.endswith('Check that the right X account is active before you tap Post.'))
        self.assertEqual(decoded(messages[2]['url']).split('\n\n')[1:3], ['Please post this on X:', 'From @om2_films:\nSita post\nOpen in X: ' + x_intent_url('Sita post')])

    def test_threads_and_polls_keep_every_part(self):
        thread = self.post_item(self.cricket, '', format='THREAD', thread_posts=['One', 'Two', 'Three'])
        poll = self.post_item(self.food, 'Who wins?', format='POLL', poll_options=['CSK', 'MI'])
        text = self.prepare([thread, poll])['messages'][0]['text']
        self.assertIn(f'1/3\nOne\n2/3\nTwo\n3/3\nThree\nOpen in X: {x_intent_url("One")}\nThis opens post 1.', text)
        self.assertIn(f'Who wins?\nPoll options:\n• CSK\n• MI\nOpen in X: {x_intent_url("Who wins?")}\nAdd the poll options', text)

    def test_long_messages_are_split_and_oversized_ones_flagged(self):
        telugu = 'తెలుగు ' * 20  # ~9 encoded characters per letter, more inside the X link
        long_posts = [self.post_item(self.cricket, f'{telugu}{n}') for n in range(3)]
        huge = self.post_item(self.food, '', format='THREAD', thread_posts=[f'{telugu}{n}' for n in range(10)])
        messages = self.prepare([*long_posts, huge])['messages']
        self.assertGreater(len(messages), 2)
        for m in messages:
            if len(m['posts']) > 1:
                self.assertLessEqual(m['url_length'], services.MAX_WHATSAPP_URL_LENGTH)
        flagged = [m for m in messages if m['warnings']]
        self.assertEqual([m['posts'][0]['id'] for m in flagged], [huge.pk])
        self.assertEqual(flagged[0]['warnings'][0]['code'], 'LONG_MESSAGE')

    def test_refuses_unsendable_posts(self):
        ok = self.post_item(self.cricket)
        cases = [
            (self.post_item(self.cricket, status=ContentItem.Status.DRAFT), 'Only approved posts can be sent.'),
            (self.post_item(XAccount.objects.create(handle='loose', display_name='L')), '@loose has no Omkar assigned.'),
        ]
        for item, reason in cases:
            with self.subTest(reason):
                data = self.prepare([ok, item], expected=409)
                self.assertEqual(data['excluded'], [{'id': item.pk, 'reason': reason}])
        User.objects.filter(pk=self.ravi.pk).update(phone_number='')
        self.assertEqual(self.prepare([ok], expected=409)['excluded'][0]['reason'], 'Ravi has no WhatsApp number saved.')
        self.assertFalse(DistributionMessage.objects.exists())

    def test_validation(self):
        self.assertEqual(self.post(BATCHES, {'item_ids': []}).status_code, 400)
        self.assertEqual(self.post(BATCHES, {'item_ids': list(range(1, 202))}).status_code, 400)
        self.assertEqual(self.post(BATCHES, {'item_ids': [999]}).status_code, 409)

    def test_no_duplicate_batches(self):
        item = self.post_item(self.cricket)
        batch = self.prepare([item])
        data = self.prepare([item], expected=409)
        self.assertEqual(data['excluded'], [{'id': item.pk, 'reason': f'Already in batch {batch["id"]}.'}])
        # The database refuses a second active entry even if a request skipped the checks.
        message = DistributionMessage.objects.get()
        with self.assertRaises(IntegrityError), transaction.atomic():
            other = DistributionMessage.objects.create(batch=message.batch, omkar=self.ravi, position=2, phone_number='+1', text='x')
            DistributionMessageItem.objects.create(message=other, content_item=item, item_version=1, order=1)

    @override_settings(TINYURL_API_TOKEN='token-for-tests')
    def test_uses_tinyurl_links_when_available(self):
        item = self.post_item(self.cricket, 'Short me')
        body = json.dumps({'data': {'tiny_url': 'https://tinyurl.com/abc123'}, 'code': 0}).encode()
        with mock.patch('urllib.request.urlopen', return_value=io.BytesIO(body)) as urlopen:
            message = self.prepare([item])['messages'][0]
        self.assertEqual(urlopen.call_count, 1)
        self.assertIn('Short me\nOpen in X: https://tinyurl.com/abc123', message['text'])
        self.assertTrue(message['posts'][0]['short_link'])

    @override_settings(TINYURL_API_TOKEN='token-for-tests')
    def test_falls_back_to_full_links_when_tinyurl_fails(self):
        item = self.post_item(self.cricket, 'Keep me long')
        with mock.patch('urllib.request.urlopen', side_effect=TimeoutError), self.assertLogs('content.shortlinks', 'WARNING'):
            message = self.prepare([item])['messages'][0]
        self.assertIn(f'Open in X: {x_intent_url("Keep me long")}', message['text'])
        self.assertFalse(message['posts'][0]['short_link'])


class MessageStatusTests(DistributionTestCase):
    def setUp(self):
        super().setUp()
        self.item = self.post_item(self.cricket, 'Ready to go')
        self.batch = self.prepare([self.item])
        self.message_id = self.batch['messages'][0]['id']

    def act(self, action, expected=200):
        response = self.post(message_url(self.message_id, action))
        self.assertEqual(response.status_code, expected, response.content)
        return response.json()

    def test_open_then_confirm_sent(self):
        opened = self.act('open')
        self.assertEqual((opened['status'], opened['open_count']), ('OPENED', 1))
        self.assertEqual(opened['opened_by']['display_name'], 'boss')
        self.assertEqual(self.act('open')['open_count'], 2)

        sent = self.act('confirm-sent')
        self.assertEqual(sent['status'], 'SENT')
        self.assertIsNone(sent['url'])
        self.assertEqual(self.act('open', 409)['detail'], 'This message was already confirmed as sent.')
        self.assertEqual(self.act('confirm-sent', 409)['detail'], 'This message was already confirmed as sent.')
        self.assertEqual(self.act('cancel', 409)['detail'], 'A message confirmed as sent can’t be cancelled.')
        # Confirming the WhatsApp message never changes the post itself.
        self.item.refresh_from_db()
        self.assertEqual((self.item.status, self.item.version), ('APPROVED', 1))

    def test_sent_posts_are_excluded_by_default(self):
        self.act('confirm-sent')
        post = self.client.get(CANDIDATES).json()['omkars'][0]['posts'][0]
        self.assertIsNotNone(post['sent_at'])
        self.assertIsNone(post['active_batch_id'])
        self.assertEqual(self.prepare([self.item], expected=409)['excluded'][0]['reason'], 'Already sent.')
        self.assertEqual(len(self.prepare([self.item], include_sent=True)['messages']), 1)

    def test_cancel_releases_posts(self):
        self.assertEqual(self.act('cancel')['status'], 'CANCELLED')
        self.assertEqual(self.act('open', 409)['detail'], 'This message was cancelled.')
        self.assertIsNone(self.client.get(CANDIDATES).json()['omkars'][0]['posts'][0]['unavailable_reason'])
        self.prepare([self.item])

    def test_stale_messages_cannot_be_opened(self):
        changes = [
            (lambda: ContentItem.objects.filter(pk=self.item.pk).update(version=2), 'A post for @om2_cricket changed after this message was prepared.'),
            (lambda: User.objects.filter(pk=self.ravi.pk).update(phone_number='+911111111111'), 'Ravi’s WhatsApp number changed after this message was prepared.'),
            (lambda: XAccount.objects.filter(pk=self.cricket.pk).update(assigned_omkar=self.sita), '@om2_cricket is no longer assigned to Ravi.'),
            (lambda: XAccount.objects.filter(pk=self.cricket.pk).update(status='PAUSED'), '@om2_cricket is paused.'),
            (lambda: User.objects.filter(pk=self.ravi.pk).update(is_active=False), 'Ravi is inactive.'),
        ]
        for change, reason in changes:
            with self.subTest(reason), transaction.atomic():
                change()
                self.assertEqual(self.act('open', 409)['detail'], f'{reason} Cancel this message and prepare it again.')
                transaction.set_rollback(True)
        self.assertEqual(DistributionMessage.objects.get().status, 'PENDING')

    def test_batch_list_and_detail(self):
        self.act('open')
        listed = self.client.get(BATCHES).json()['results'][0]
        self.assertEqual(listed['id'], self.batch['id'])
        self.assertEqual(listed['counts'], {'PENDING': 0, 'OPENED': 1, 'SENT': 0, 'CANCELLED': 0})
        detail = self.client.get(f'{BATCHES}{self.batch["id"]}/').json()
        self.assertEqual(detail['messages'][0]['status'], 'OPENED')
        self.assertEqual(self.client.get(f'{BATCHES}999/').status_code, 404)

    def test_unknown_actions_and_messages(self):
        self.assertEqual(self.post(message_url(self.message_id, 'deliver')).status_code, 404)
        self.assertEqual(self.post(message_url(999, 'open')).status_code, 404)
        self.client.force_login(self.ravi)
        self.assertEqual(self.post(message_url(self.message_id, 'open')).status_code, 403)
