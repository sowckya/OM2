from decimal import Decimal

from django.core.exceptions import ImproperlyConfigured
from django.test import TestCase, override_settings

from users.models import User
from x_accounts.models import ContentDNA, XAccount

from . import services
from .models import ContentItem, ContentRevision, GenerationRun
from .providers import Candidate, ContentProvider, GenerationResult, ProviderError, get_provider
from .providers.mock import MockProvider

DNA = {
    'primary_themes': ['Cricket', 'Telugu cinema'],
    'secondary_themes': ['Hyderabad food'],
    'languages': ['ENGLISH', 'TINGLISH'],
    'tone': ['Witty'],
    'target_audience': 'Young cricket fans.',
    'writing_style': 'Short lines.',
    'allowed_formats': ['TEXT', 'THREAD', 'POLL'],
    'topics_to_avoid': ['Politics'],
    'example_posts': ['Example one.'],
    'daily_post_target': 3,
    'additional_instructions': 'No hashtags.',
}


class FixedProvider(ContentProvider):
    """Returns the given candidates in order, one batch per call."""

    name = 'fixed'
    model_name = 'fixed-1'
    input_price_per_million = Decimal('3')
    output_price_per_million = Decimal('15')

    def __init__(self, *batches):
        self.batches = list(batches)
        self.requests = []

    def generate(self, request):
        self.requests.append(request)
        return GenerationResult(candidates=self.batches.pop(0) if self.batches else [], input_tokens=1000, output_tokens=200)


def text(body, **kw):
    return Candidate(format='TEXT', body=body, theme='Cricket', language='ENGLISH', **kw)


class GenerationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='boss', password='x', role=User.Role.MILLIONAIRE)
        self.account = XAccount.objects.create(handle='om2_cricket', display_name='Cricket')
        self.dna = ContentDNA.objects.create(x_account=self.account, **DNA)

    def generate(self, provider, count=3, **kw):
        return services.generate_for_accounts([self.account.pk], self.user, count=count, provider=provider, **kw)[0]

    def test_mock_provider_is_registered_and_labelled(self):
        provider = get_provider()
        self.assertIsInstance(provider, MockProvider)
        self.assertTrue(provider.is_mock)
        self.assertEqual(provider.estimate_cost(10**6, 10**6), 0)
        with override_settings(CONTENT_AI_PROVIDER='nope'), self.assertRaises(ImproperlyConfigured):
            get_provider()

    def test_mock_generates_distinct_valid_options_from_dna(self):
        result = self.generate(MockProvider(seed=1), count=5)
        items = result['items']
        self.assertEqual(len(items), 5)
        self.assertEqual(len({i.fingerprint for i in items}), 5)
        self.assertEqual({i.format for i in items}, {'TEXT', 'THREAD', 'POLL'})
        themes = {*DNA['primary_themes'], *DNA['secondary_themes']}
        for item in items:
            self.assertIn(item.theme, themes)
            self.assertEqual(item.source, 'AI')
            self.assertEqual(item.status, 'DRAFT')
            self.assertIn('MOCK_CONTENT', [f['code'] for f in item.validation_flags])

    def test_requested_format_is_respected(self):
        items = self.generate(MockProvider(seed=2), count=3, fmt='POLL')['items']
        self.assertEqual([i.format for i in items], ['POLL'] * 3)
        self.assertTrue(all(2 <= len(i.poll_options) <= 4 for i in items))

    def test_run_records_snapshot_prompt_usage_and_cost(self):
        provider = FixedProvider([text('One'), text('Two')])
        run = self.generate(provider, count=2, instructions='Mention the weekend')['run']
        self.assertEqual(run.status, 'SUCCEEDED')
        self.assertEqual((run.provider, run.model_name, run.is_mock), ('fixed', 'fixed-1', False))
        self.assertEqual(run.dna_snapshot['primary_themes'], DNA['primary_themes'])
        self.assertIn('Mention the weekend', run.prompt)
        self.assertIn('Topics to avoid: Politics', run.prompt)
        self.assertEqual((run.input_tokens, run.output_tokens), (1000, 200))
        self.assertEqual(run.estimated_cost_usd, Decimal('0.006'))  # 1000 × $3/M + 200 × $15/M
        item = run.items.first()
        self.assertEqual(item.dna_snapshot, run.dna_snapshot)
        self.assertEqual(item.revisions.get().action, ContentRevision.Action.CREATED)

    def test_snapshot_is_unaffected_by_later_dna_edits(self):
        run = self.generate(FixedProvider([text('One')]), count=1)['run']
        self.dna.primary_themes = ['Changed']
        self.dna.save()
        run.refresh_from_db()
        self.assertEqual(run.dna_snapshot['primary_themes'], DNA['primary_themes'])

    def test_recent_posts_are_sent_to_the_provider(self):
        self.generate(FixedProvider([text('Earlier post')]), count=1)
        provider = FixedProvider([text('New post')])
        self.generate(provider, count=1)
        self.assertEqual(provider.requests[0].recent_posts, ('Earlier post',))
        self.assertIn('- Earlier post', provider.requests[0].user_prompt)

    def test_exact_duplicates_are_replaced(self):
        self.generate(FixedProvider([text('Existing post')]), count=1)
        provider = FixedProvider([text('Existing post!'), text('Fresh')], [text('Another fresh one')])
        items = self.generate(provider, count=2)['items']
        self.assertEqual([i.body for i in items], ['Fresh', 'Another fresh one'])
        self.assertEqual(provider.requests[1].avoid, ('Existing post!',))
        self.assertEqual(provider.requests[1].count, 1)

    def test_duplicates_kept_and_flagged_when_no_replacement_comes(self):
        self.generate(FixedProvider([text('Existing post')]), count=1)
        provider = FixedProvider([text('Existing post')], [text('Existing post')], [text('Existing post')])
        items = self.generate(provider, count=1)['items']
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].duplicate_flags[0]['kind'], 'EXACT')

    def test_invalid_and_wrong_format_candidates_are_dropped(self):
        provider = FixedProvider([text('x' * 281), Candidate(format='THREAD', thread_posts=('a', 'b')), Candidate(format='VIDEO', body='v'), text('Good')])
        result = self.generate(provider, count=4, fmt='TEXT')
        self.assertEqual([i.body for i in result['items']], ['Good'])

    def test_similar_options_within_a_batch_are_flagged(self):
        items = self.generate(FixedProvider([text('Chai at Uppal never cancels for rain'), text('Chai at Uppal never cancels in rain')]), count=2)['items']
        self.assertEqual(items[0].duplicate_flags, [])
        self.assertEqual(items[1].duplicate_flags[0]['scope'], 'ACCOUNT')
        self.assertEqual(items[1].duplicate_flags[0]['item_id'], items[0].pk)

    def test_provider_errors_are_recorded(self):
        class Broken(FixedProvider):
            def generate(self, request):
                raise ProviderError('Rate limited, try later.')

        result = self.generate(Broken())
        self.assertEqual(result['error'], 'Rate limited, try later.')
        self.assertEqual(result['run'].status, 'FAILED')
        self.assertFalse(ContentItem.objects.exists())

    def test_unexpected_errors_are_hidden(self):
        class Crashing(FixedProvider):
            def generate(self, request):
                raise RuntimeError('secret internals')

        with self.assertLogs('content.services', level='ERROR'):
            result = self.generate(Crashing())
        self.assertEqual(result['error'], services.PROVIDER_FAILED)

    def test_empty_result_fails_the_run(self):
        result = self.generate(FixedProvider([]), count=2)
        self.assertEqual(result['run'].status, 'FAILED')
        self.assertIn('no usable options', result['error'])

    def test_accounts_without_dna_are_skipped(self):
        bare = XAccount.objects.create(handle='bare', display_name='Bare')
        results = services.generate_for_accounts([bare.pk, self.account.pk], self.user, count=1, provider=MockProvider(seed=3))
        self.assertEqual((results[0]['error'], results[0]['run']), (services.NO_DNA, None))
        self.assertEqual(len(results[1]['items']), 1)
        self.assertEqual(GenerationRun.objects.count(), 1)
