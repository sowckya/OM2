from django.test import SimpleTestCase, TestCase

from x_accounts.models import XAccount

from . import checks
from .models import ContentItem

DNA = {'allowed_formats': ['TEXT', 'POLL'], 'topics_to_avoid': ['Politics', 'Match fixing']}


class ValidationTests(SimpleTestCase):
    def test_text_limits(self):
        self.assertEqual(checks.validation_errors('TEXT', '', [], []), {'body': ['Write the post.']})
        self.assertEqual(checks.validation_errors('TEXT', 'x' * 280, [], []), {})
        self.assertEqual(checks.validation_errors('TEXT', 'x' * 281, [], []), {'body': ['The post is 281 characters; the limit is 280.']})

    def test_thread_rules(self):
        self.assertIn('A thread needs 2 to 10 posts.', checks.validation_errors('THREAD', '', ['one'], [])['thread_posts'])
        errors = checks.validation_errors('THREAD', '', ['one', '', 'x' * 281], [])['thread_posts']
        self.assertEqual(errors, ['Post 2 is empty.', 'Post 3 is 281 characters; the limit is 280.'])
        self.assertEqual(checks.validation_errors('THREAD', '', ['a'] * 10, []), {})

    def test_poll_rules(self):
        self.assertEqual(checks.validation_errors('POLL', '', [], ['a', 'b']), {'body': ['Write the poll question.']})
        errors = checks.validation_errors('POLL', 'Q?', [], ['Yes', 'yes', '', 'x' * 26, 'e'])['poll_options']
        self.assertEqual(
            errors,
            ['A poll needs 2 to 4 options.', 'Option 2 repeats another option.', 'Option 3 is empty.', 'Option 4 is longer than 25 characters.'],
        )

    def test_clean_parts_trims_and_drops_other_formats(self):
        self.assertEqual(checks.clean_parts('TEXT', ' hi ', ['x'], ['y']), ('hi', [], []))
        self.assertEqual(checks.clean_parts('THREAD', 'hi', [' a ', 'b'], ['y']), ('', ['a', 'b'], []))
        self.assertEqual(checks.clean_parts('POLL', ' Q ', ['x'], [' A ', 'B']), ('Q', [], ['A', 'B']))

    def test_flags(self):
        codes = lambda *a, **k: [f['code'] for f in checks.validation_flags(*a, **k)]
        self.assertEqual(codes('TEXT', 'Plain text', DNA), [])
        self.assertEqual(codes('THREAD', 'x', DNA), ['FORMAT_NOT_ALLOWED'])
        self.assertEqual(codes('TEXT', 'No more POLITICS please', DNA), ['AVOIDED_TOPIC'])
        self.assertEqual(codes('TEXT', 'about match-fixing', DNA), ['AVOIDED_TOPIC'])
        self.assertEqual(codes('TEXT', 'politically speaking', DNA), [])
        self.assertEqual(codes('TEXT', 'see https://example.com', DNA), ['CONTAINS_LINK'])
        self.assertEqual(codes('TEXT', '#a #b #c', DNA), ['MANY_HASHTAGS'])
        self.assertEqual(codes('TEXT', 'x', None), ['NO_CONTENT_DNA'])
        self.assertEqual(codes('TEXT', 'x', DNA, is_mock=True), ['MOCK_CONTENT'])

    def test_similarity(self):
        self.assertEqual(checks.fingerprint('Rain, again!'), checks.fingerprint('rain again'))
        self.assertGreaterEqual(checks.similarity('Chai at Uppal never cancels for rain', 'Rain? Chai at Uppal never cancels!'), 0.6)
        self.assertLess(checks.similarity('Chai at Uppal never cancels', 'Biryani tonight in Old City'), 0.2)
        self.assertEqual(checks.similarity('the a of', 'the a of'), 0.0)


class DuplicateTests(TestCase):
    def setUp(self):
        self.mine = XAccount.objects.create(handle='mine', display_name='Mine')
        self.other = XAccount.objects.create(handle='other', display_name='Other')

    def add(self, account, body, status=ContentItem.Status.DRAFT):
        return ContentItem.objects.create(
            x_account=account, source='MANUAL', format='TEXT', body=body, status=status, fingerprint=checks.fingerprint(body)
        )

    def test_exact_and_similar_matches_account_first(self):
        network = self.add(self.other, 'Chai at Uppal never cancels for rain')
        exact = self.add(self.mine, 'Chai at Uppal never cancels for rain!', status=ContentItem.Status.REJECTED)
        flags = checks.duplicate_flags(self.mine.pk, 'chai at uppal never cancels for rain')
        self.assertEqual([(f['kind'], f['scope'], f['item_id']) for f in flags][:1], [('EXACT', 'ACCOUNT', exact.pk)])
        self.assertIn(('EXACT', 'NETWORK', network.pk), [(f['kind'], f['scope'], f['item_id']) for f in flags])
        self.assertEqual(flags[0]['label'], '@mine · Rejected')

    def test_similar_only_above_threshold_and_excludes_self(self):
        item = self.add(self.mine, 'Rain at Uppal again, but the chai stall never cancels')
        self.add(self.mine, 'Biryani tonight in the Old City')
        self.assertEqual(checks.duplicate_flags(self.mine.pk, item.body, exclude_id=item.pk), [])
        flags = checks.duplicate_flags(self.mine.pk, 'Rain at Uppal again and the chai stall never cancels')
        self.assertEqual([(f['kind'], f['item_id']) for f in flags], [('SIMILAR', item.pk)])
