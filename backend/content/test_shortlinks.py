import io
import json
import urllib.error
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from users.models import User
from x_accounts.models import XAccount

from . import shortlinks
from .models import ContentItem, ShortLink
from .whatsapp import x_intent_url

PASSWORD = 's3cret-pass'
TOKEN = 'test-tinyurl-token-123'
TWEET = 'Dew at Chepauk tonight? Bowl first & keep it simple. 100% #CSK'
SHORT = 'https://tinyurl.com/om2test1'


def tinyurl_response(short_url=SHORT):
    body = json.dumps({'data': {'tiny_url': short_url, 'domain': 'tinyurl.com'}, 'code': 0, 'errors': []})
    return io.BytesIO(body.encode())


def http_error(code):
    return urllib.error.HTTPError(shortlinks.TINYURL_CREATE_URL, code, 'error', {}, io.BytesIO(b'{}'))


def message_of(share):
    return parse_qs(urlsplit(share['url']).query)['text'][0]


class FakeTinyUrl:
    """Stands in for urllib.request.urlopen; records requests instead of calling TinyURL."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


@override_settings(TINYURL_API_TOKEN=TOKEN, TINYURL_TIMEOUT_SECONDS=4)
class ShortLinkTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient(enforce_csrf_checks=True)
        self.boss = User.objects.create_user(username='boss', password=PASSWORD, role=User.Role.MILLIONAIRE)
        self.client.force_login(self.boss)
        self.token = self.client.get('/api/auth/csrf/').json()['csrfToken']
        omkar = User.objects.create_user(
            username='ravi', password=PASSWORD, role=User.Role.OMKAR, first_name='Ravi', phone_number='+919876543210'
        )
        self.account = XAccount.objects.create(handle='om2_cricket', display_name='Cricket', assigned_omkar=omkar)

    def item(self, status=ContentItem.Status.APPROVED, body=TWEET):
        return ContentItem.objects.create(x_account=self.account, source='MANUAL', status=status, format='TEXT', body=body, fingerprint='x')

    def get(self, item):
        response = self.client.get(f'/api/content/items/{item.pk}/')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['whatsapp']

    def approve(self, item):
        response = self.client.post(f'/api/content/items/{item.pk}/approve/', {'acknowledge_warnings': True}, format='json', HTTP_X_CSRFTOKEN=self.token)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['whatsapp']

    def test_approving_shortens_the_x_link_once_and_keeps_the_message(self):
        item = self.item(status=ContentItem.Status.DRAFT)
        fake = FakeTinyUrl(tinyurl_response())
        with mock.patch('urllib.request.urlopen', fake):
            share = self.approve(item)
            again = self.get(item)
            listed = self.client.get('/api/content/items/').json()['results'][0]['whatsapp']

        # One official API call, authenticated with the token from settings.
        self.assertEqual(len(fake.requests), 1)
        request, timeout = fake.requests[0]
        self.assertEqual((request.full_url, request.get_method(), timeout), ('https://api.tinyurl.com/create', 'POST', 4))
        self.assertEqual(request.get_header('Authorization'), f'Bearer {TOKEN}')
        self.assertEqual(json.loads(request.data), {'url': x_intent_url(TWEET), 'domain': 'tinyurl.com'})

        message = message_of(share)
        self.assertTrue(share['x_link_shortened'])
        self.assertIn(f'Open X with this post ready:\n{SHORT}\n', message)
        self.assertNotIn('x.com/intent', message)
        self.assertIn('Please post this on X from @om2_cricket:', message)
        self.assertIn(TWEET, message)
        self.assertIn('Check that @om2_cricket is the active account before you tap Post.', message)
        # Cached: the detail view and the list reuse it without calling TinyURL again.
        self.assertEqual(again['url'], share['url'])
        self.assertEqual(listed['url'], share['url'])
        self.assertEqual(ShortLink.objects.get().short_url, SHORT)

    def test_opening_a_post_approved_earlier_shortens_it(self):
        item = self.item()  # approved before any token was set: nothing cached
        with mock.patch('urllib.request.urlopen', FakeTinyUrl(tinyurl_response())) as fake:
            listed = self.client.get('/api/content/items/').json()['results'][0]['whatsapp']
            opened = self.get(item)
        self.assertFalse(listed['x_link_shortened'])
        self.assertTrue(opened['x_link_shortened'])
        self.assertEqual(len(fake.requests), 1)
        self.assertIn(SHORT, message_of(opened))

    def test_lists_never_call_tinyurl(self):
        self.item()
        with mock.patch('urllib.request.urlopen', FakeTinyUrl()) as fake:
            share = self.client.get('/api/content/items/').json()['results'][0]['whatsapp']
        self.assertEqual(fake.requests, [])
        self.assertFalse(share['x_link_shortened'])
        self.assertIn(x_intent_url(TWEET), message_of(share))

    def test_falls_back_to_the_full_x_link_when_shortening_fails(self):
        failures = [
            http_error(500),
            urllib.error.URLError('offline'),
            TimeoutError(),
            io.BytesIO(b'not json'),
            tinyurl_response('https://evil.example/x'),
        ]
        for failure in failures:
            with self.subTest(repr(failure)):
                with mock.patch('urllib.request.urlopen', FakeTinyUrl(failure)), self.assertLogs('content.shortlinks', 'WARNING') as logs:
                    share = self.get(self.item())
                self.assertFalse(share['x_link_shortened'])
                message = message_of(share)
                self.assertIn(f'Open X with this post ready:\n{x_intent_url(TWEET)}\n', message)
                self.assertIn(TWEET, message)
                self.assertNotIn(TOKEN, '\n'.join(logs.output))
        self.assertFalse(ShortLink.objects.exists())

    def test_refusals_pause_tinyurl_calls(self):
        for code in (401, 403, 429):
            with self.subTest(code):
                cache.clear()
                fake = FakeTinyUrl(http_error(code))
                with mock.patch('urllib.request.urlopen', fake), self.assertLogs('content.shortlinks', 'WARNING'):
                    self.assertIsNone(shortlinks.shorten('https://x.com/intent/tweet?text=a'))
                    # Cooling down: no second request.
                    self.assertIsNone(shortlinks.shorten('https://x.com/intent/tweet?text=b'))
                self.assertEqual(len(fake.requests), 1)

    @override_settings(TINYURL_API_TOKEN='')
    def test_without_a_token_nothing_is_called(self):
        item = self.item(status=ContentItem.Status.DRAFT)
        with mock.patch('urllib.request.urlopen', FakeTinyUrl()) as fake:
            share = self.approve(item)
        self.assertEqual(fake.requests, [])
        self.assertFalse(share['x_link_shortened'])
        self.assertIn(x_intent_url(TWEET), message_of(share))

    def test_unsendable_and_unapproved_posts_are_not_shortened(self):
        XAccount.objects.filter(pk=self.account.pk).update(assigned_omkar=None)
        with mock.patch('urllib.request.urlopen', FakeTinyUrl()) as fake:
            self.assertIsNone(self.get(self.item())['url'])
            self.assertIsNone(self.get(self.item(status=ContentItem.Status.DRAFT)))
        self.assertEqual(fake.requests, [])

    def test_bulk_approve_shortens_each_post(self):
        items = [self.item(status=ContentItem.Status.DRAFT, body=f'{TWEET} {n}') for n in range(2)]
        fake = FakeTinyUrl(tinyurl_response('https://tinyurl.com/a1'), tinyurl_response('https://tinyurl.com/b2'))
        with mock.patch('urllib.request.urlopen', fake):
            response = self.client.post(
                '/api/content/items/bulk-approve/', {'ids': [i.pk for i in items], 'acknowledge_warnings': True}, format='json', HTTP_X_CSRFTOKEN=self.token
            )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(len(fake.requests), 2)
        self.assertEqual(sorted(ShortLink.objects.values_list('short_url', flat=True)), ['https://tinyurl.com/a1', 'https://tinyurl.com/b2'])
        # Approval itself is unaffected by shortening.
        self.assertEqual(set(ContentItem.objects.values_list('status', flat=True)), {'APPROVED'})
