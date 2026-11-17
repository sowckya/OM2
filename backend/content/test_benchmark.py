"""benchmark_ai command tests. Offline: Gemini is replaced by a fake transport."""

import io
import json
import os
import tempfile
from unittest import mock

from django.core.management import CommandError, call_command
from django.test import TestCase

from users.models import User
from x_accounts.models import ContentDNA, XAccount

from . import benchmark
from .models import ContentItem, ContentRevision, GenerationRun
from .providers.gemini import GeminiProvider
from .test_gemini import KEY, google_error, option, reply
from .test_generation import DNA

CATALOGUE = {'models': [
    {'name': 'models/model-a', 'displayName': 'Model A', 'supportedGenerationMethods': ['generateContent'], 'outputTokenLimit': 65536, 'thinking': True},
    {'name': 'models/model-b', 'displayName': 'Model B', 'supportedGenerationMethods': ['generateContent', 'countTokens']},
    {'name': 'models/model-b-tts', 'displayName': 'Model B TTS', 'supportedGenerationMethods': ['generateContent']},
    {'name': 'models/embedder', 'displayName': 'Embedder', 'supportedGenerationMethods': ['embedContent']},
]}


class FakeGoogle:
    """GET /models returns CATALOGUE; POST generateContent replies per model from a queue."""

    def __init__(self, replies):
        self.replies = replies
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        assert headers['x-goog-api-key'] == KEY and KEY not in url
        if body is None:
            self.calls.append(('list', url))
            return 200, json.dumps(CATALOGUE).encode(), {}
        model = url.split('/models/')[1].split(':')[0]
        self.calls.append((model, json.loads(body)))
        status, data = self.replies[model].pop(0)
        return status, json.dumps(data).encode(), {'Server-Timing': 'gfet4t7; dur=700'}


class BenchmarkCommandTests(TestCase):
    def setUp(self):
        self.google = FakeGoogle({
            'model-a': [(200, reply(option(body='Toss gelichi batting teesukunte?', language='TINGLISH'),
                                    option('POLL', body='Best biryani spot?', choices=['Paradise', 'Bawarchi'], theme='Hyderabad food'),
                                    option(body='x' * 300), thoughts=12))] * 2,
            'model-b': [(429, google_error(429, 'RESOURCE_EXHAUSTED'))],
        })
        patcher = mock.patch.object(benchmark, 'make_provider', side_effect=self.make_provider)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.made = []

    def make_provider(self, name, model=None, **options):
        provider = GeminiProvider(api_key=KEY, model=model, transport=self.google, sleep=lambda s: None, **options)
        self.made.append((model, options))
        return provider

    def call(self, *args):
        out = io.StringIO()
        with mock.patch('time.sleep'):
            call_command('benchmark_ai', *args, stdout=out)
        return out.getvalue()

    def generation_calls(self):
        return [c for c in self.google.calls if c[0] != 'list']

    def test_dry_run_makes_no_calls(self):
        out = self.call('--models', 'model-a,model-b')
        self.assertIn('Plan: 2 call(s)', out)
        self.assertIn('Dry run: no API calls made', out)
        self.assertEqual(self.google.calls, [])

    def test_live_run_needs_confirmation(self):
        with mock.patch('sys.stdin.isatty', return_value=True), mock.patch('builtins.input', return_value='no'):
            with self.assertRaisesMessage(CommandError, 'Cancelled: no generation calls made'):
                self.call('--models', 'model-a', '--run')
        # Non-interactive runs can't confirm, so they are refused too.
        with mock.patch('sys.stdin.isatty', return_value=False), self.assertRaisesMessage(CommandError, 'confirm with --yes'):
            self.call('--models', 'model-a', '--run')
        self.assertEqual(self.generation_calls(), [])

    def test_typed_yes_runs_it(self):
        with mock.patch('sys.stdin.isatty', return_value=True), mock.patch('builtins.input', return_value='yes'):
            self.call('--models', 'model-a', '--run')
        self.assertEqual(len(self.generation_calls()), 1)

    def test_unavailable_models_are_rejected_before_generating(self):
        with self.assertRaisesMessage(CommandError, 'Not available to this API key: model-z'):
            self.call('--models', 'model-a,model-z', '--run', '--yes')
        self.assertEqual(self.generation_calls(), [])

    def test_compares_models_on_the_same_request_without_saving_anything(self):
        user = User.objects.create_user(username='boss', password='x', role=User.Role.MILLIONAIRE)
        account = XAccount.objects.create(handle='om2_cricket', display_name='Cricket')
        ContentDNA.objects.create(x_account=account, **DNA)
        existing = ContentItem.objects.create(x_account=account, format='TEXT', body='Old post', created_by=user, fingerprint='f')
        before = (ContentItem.objects.count(), GenerationRun.objects.count(), ContentRevision.objects.count())

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'results.json')
            out = self.call('--models', 'model-a,model-b', '--account', '@OM2_cricket', '--count', '3', '--repeat', '2',
                            '--thinking', 'low', '--show-text', '--json', path, '--run', '--yes')
            saved = json.load(open(path, encoding='utf-8'))

        # Models interleaved; model-b's rate limit makes its second call fail fast without a request.
        self.assertEqual([c[0] for c in self.generation_calls()], ['model-a', 'model-b', 'model-a'])
        a, b = self.generation_calls()[0][1], self.generation_calls()[1][1]
        self.assertEqual(a['contents'], b['contents'])
        self.assertEqual(a['systemInstruction'], b['systemInstruction'])
        self.assertIn('Account: @om2_cricket', a['contents'][0]['parts'][0]['text'])
        self.assertIn('- Old post', a['contents'][0]['parts'][0]['text'])
        self.assertEqual(a['generationConfig']['thinkingConfig'], {'thinkingLevel': 'low'})

        row_a = next(line for line in out.splitlines() if line.startswith('model-a '))
        self.assertIn('2/2', row_a)  # successful calls
        self.assertIn('4/6', row_a)  # valid options: the 300-character one fails validation
        self.assertIn('0.70s', row_a)  # Google's processing time
        self.assertIn('0/2', next(line for line in out.splitlines() if line.startswith('model-b ')))
        self.assertIn('rate limit', out)
        self.assertIn('[model-a #2]\nBest biryani spot?\nParadise\nBawarchi', out)
        self.assertEqual(saved['summary'][0]['valid'], 4)
        self.assertEqual(saved['attempts'][0]['texts'][0], 'Toss gelichi batting teesukunte?')
        self.assertNotIn(KEY, json.dumps(saved) + out)

        self.assertEqual((ContentItem.objects.count(), GenerationRun.objects.count(), ContentRevision.objects.count()), before)
        existing.refresh_from_db()
        self.assertEqual((existing.body, existing.status), ('Old post', 'DRAFT'))

    def test_list_models_shows_text_models_without_generating(self):
        out = self.call('--list-models')
        self.assertIn('2 of 3 generateContent models', out)
        self.assertIn('model-a', out)
        self.assertNotIn('model-b-tts', out)
        self.assertNotIn('embedder', out)
        self.assertIn('model-b-tts', self.call('--list-models', '--all'))
        self.assertEqual(self.generation_calls(), [])

    def test_argument_validation(self):
        for args, message in [
            ((), 'Name the models to compare'),
            (('--models', 'a,b,c,d'), 'up to 3 different models'),
            (('--models', 'a,a'), 'up to 3 different models'),
            (('--models', 'a', '--count', '6'), '--count must be between 1 and 5'),
            (('--models', 'a', '--repeat', '9'), '--repeat must be between 1 and 5'),
            (('--models', 'a', '--account', 'nobody'), 'No X account @nobody'),
        ]:
            with self.subTest(args=args), self.assertRaisesMessage(CommandError, message):
                self.call(*args)


class OfflineBenchmarkTests(TestCase):
    def test_mock_provider_runs_offline_without_confirmation(self):
        out = io.StringIO()
        call_command('benchmark_ai', '--provider', 'mock', '--count', '2', '--run', stdout=out)
        self.assertIn('mock-templates-v1', out.getvalue())
        self.assertIn('2/2', out.getvalue())
        self.assertFalse(GenerationRun.objects.exists())

    def test_mock_has_no_model_choice(self):
        with self.assertRaisesMessage(ValueError, 'no model choice'):
            benchmark.make_provider('mock', 'some-model')

    def test_gemini_without_a_key_cannot_list_models(self):
        # The test runner clears GEMINI_API_KEY, so the real API is never reached.
        with self.assertRaisesMessage(CommandError, 'Gemini is not configured'):
            call_command('benchmark_ai', '--list-models', stdout=io.StringIO())
