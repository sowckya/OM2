from urllib.parse import parse_qs, unquote, urlsplit

from django.test import TestCase
from rest_framework.test import APIClient

from users.models import User
from x_accounts.models import XAccount

from .models import ContentItem, ContentRevision
from .whatsapp import x_intent_url

PASSWORD = 's3cret-pass'
TWEET = 'Dew at Chepauk tonight? Bowl first & keep it simple. 100% #CSK'


def decoded_text(url):
    """The prefilled text of a wa.me or X intent link, decoded exactly once as the app would."""
    return parse_qs(urlsplit(url).query)['text'][0]


class WhatsAppShareTests(TestCase):
    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        self.boss = User.objects.create_user(username='boss', password=PASSWORD, role=User.Role.MILLIONAIRE)
        self.client.force_login(self.boss)
        self.token = self.client.get('/api/auth/csrf/').json()['csrfToken']
        self.omkar = User.objects.create_user(
            username='ravi', password=PASSWORD, role=User.Role.OMKAR, first_name='Ravi', phone_number='+919876543210'
        )
        self.account = XAccount.objects.create(handle='om2_cricket', display_name='Cricket', assigned_omkar=self.omkar)

    def item(self, status=ContentItem.Status.APPROVED, **fields):
        fields.setdefault('format', 'TEXT')
        fields.setdefault('body', TWEET)
        return ContentItem.objects.create(x_account=self.account, source='MANUAL', status=status, fingerprint='x', **fields)

    def share(self, item):
        response = self.client.get(f'/api/content/items/{item.pk}/')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['whatsapp']

    def test_approved_post_gets_prefilled_whatsapp_link(self):
        share = self.share(self.item())
        self.assertEqual(share['unavailable_reason'], None)
        self.assertEqual(share['recipient'], {'id': self.omkar.pk, 'display_name': 'Ravi'})
        url = share['url']
        self.assertTrue(url.startswith('https://wa.me/919876543210?text='))
        message = decoded_text(url)
        self.assertIn('Please post this on X from @om2_cricket:', message)
        self.assertIn(TWEET, message)
        self.assertIn('Check that @om2_cricket is the active account before you tap Post.', message)
        # The X link survives WhatsApp's decoding still encoded, and opens the composer with the full post.
        intent = next(line for line in message.splitlines() if line.startswith('https://x.com/intent/tweet?text='))
        self.assertNotIn(' ', intent)
        self.assertNotIn('&', intent.split('?', 1)[1].removeprefix('text='))
        self.assertEqual(decoded_text(intent), TWEET)

    def test_x_intent_encodes_reserved_characters(self):
        text = 'a&b=c #tag 50% ?/+\nline two తెలుగు'
        url = x_intent_url(text)
        self.assertEqual(url.split('?text=')[1], url.split('?text=')[1].strip())
        self.assertEqual(unquote(url.split('?text=')[1]), text)
        self.assertEqual(decoded_text(url), text)

    def test_thread_includes_every_post_and_opens_the_first(self):
        share = self.share(self.item(format='THREAD', body='', thread_posts=['First post', 'Second post', 'Third post']))
        message = decoded_text(share['url'])
        for i, post in enumerate(['First post', 'Second post', 'Third post'], 1):
            self.assertIn(f'{i}/3\n{post}', message)
        intent = next(line for line in message.splitlines() if line.startswith('https://x.com/'))
        self.assertEqual(decoded_text(intent), 'First post')
        self.assertIn('Reply to it with the other posts in order.', message)

    def test_poll_lists_options(self):
        share = self.share(self.item(format='POLL', body='Who wins tonight?', poll_options=['CSK', 'MI']))
        message = decoded_text(share['url'])
        self.assertIn('Who wins tonight?\n\nPoll options:\n• CSK\n• MI', message)
        intent = next(line for line in message.splitlines() if line.startswith('https://x.com/'))
        self.assertEqual(decoded_text(intent), 'Who wins tonight?')

    def test_unavailable_reasons(self):
        item = self.item()
        cases = [
            (lambda: User.objects.filter(pk=self.omkar.pk).update(phone_number=''), 'Ravi has no WhatsApp number saved.'),
            (lambda: User.objects.filter(pk=self.omkar.pk).update(is_active=False), 'Ravi is inactive.'),
            (lambda: XAccount.objects.filter(pk=self.account.pk).update(assigned_omkar=None), '@om2_cricket has no Omkar assigned.'),
            (lambda: XAccount.objects.filter(pk=self.account.pk).update(status='PAUSED'), '@om2_cricket is paused.'),
        ]
        for change, reason in cases:
            with self.subTest(reason):
                change()
                share = self.share(item)
                self.assertEqual(share['unavailable_reason'], reason)
                self.assertIsNone(share['url'])

    def test_only_approved_posts_are_shareable(self):
        for status in (ContentItem.Status.DRAFT, ContentItem.Status.REJECTED):
            with self.subTest(status):
                self.assertIsNone(self.share(self.item(status=status)))

    def test_listing_is_millionaire_only_and_changes_nothing(self):
        item = self.item()
        listed = self.client.get('/api/content/items/?status=APPROVED').json()['results']
        self.assertTrue(listed[0]['whatsapp']['url'])
        item.refresh_from_db()
        self.assertEqual((item.status, item.version), (ContentItem.Status.APPROVED, 1))
        self.assertFalse(ContentRevision.objects.exists())

        self.client.force_login(self.omkar)
        self.assertEqual(self.client.get(f'/api/content/items/{item.pk}/').status_code, 403)
        self.client.logout()
        self.assertIn(self.client.get(f'/api/content/items/{item.pk}/').status_code, (401, 403))
