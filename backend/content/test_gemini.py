"""Gemini provider tests. No test calls the real API: a fake transport stands in for HTTP."""

import io
import json
import urllib.error
from decimal import Decimal
from unittest import mock

from django.core.checks import run_checks
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from users.models import User
from x_accounts.models import ContentDNA, XAccount

from . import services
from .models import ContentItem, GenerationRun
from .prompts import SYSTEM_PROMPT
from .providers import get_provider
from .providers import gemini
from .providers.gemini import GeminiProvider
from .test_generation import DNA

KEY = 'test-key-not-real-0123456789'


def reply(*options, thoughts=0, finish='STOP', extra_parts=()):
    """A generateContent response body holding the given options as JSON text."""
    return {
        'candidates': [{
            'content': {'role': 'model', 'parts': [*extra_parts, {'text': json.dumps({'candidates': list(options)})}]},
            'finishReason': finish,
        }],
        'usageMetadata': {'promptTokenCount': 1200, 'candidatesTokenCount': 300, 'thoughtsTokenCount': thoughts},
        'modelVersion': 'gemini-test',
    }


def option(fmt='TEXT', body='', posts=(), choices=(), theme='Cricket', language='ENGLISH'):
    return {'format': fmt, 'language': language, 'theme': theme, 'body': body,
            'thread_posts': list(posts), 'poll_options': list(choices)}


def google_error(code, status, message='Error.', details=()):
    return {'error': {'code': code, 'status': status, 'message': message, 'details': list(details)}}


class FakeTransport:
    """Replays queued (status, body[, headers]) responses, or raises queued exceptions; records each call."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append({'url': url, 'headers': headers, 'payload': json.loads(body), 'timeout': timeout})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        status, data, *headers = response
        return status, data if isinstance(data, bytes) else json.dumps(data).encode(), headers[0] if headers else {}


class GeminiTestCase(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='boss', password='x', role=User.Role.MILLIONAIRE)
        self.account = XAccount.objects.create(handle='om2_cricket', display_name='Cricket')
        self.dna = ContentDNA.objects.create(x_account=self.account, **DNA)
        self.sleeps = []

    def provider(self, *responses, api_key=KEY, model='gemini-test-model'):
        self.transport = FakeTransport(*responses)
        return GeminiProvider(api_key=api_key, model=model, transport=self.transport, sleep=self.sleeps.append)

    def generate(self, provider, count=3, accounts=None, **kw):
        ids = accounts or [self.account.pk]
        results = services.generate_for_accounts(ids, self.user, count=count, provider=provider, **kw)
        return results if accounts else results[0]


class GeminiGenerationTests(GeminiTestCase):
    def test_generates_text_thread_and_poll_in_the_account_languages(self):
        provider = self.provider((200, reply(
            option(body='Powerplay lo first over chusthe match mood telisipothundi. Meeru agree aa?', language='TINGLISH'),
            option('THREAD', posts=['Why tail-enders deserve more credit 🧵', 'They walk in when the game is already decided.'], theme='Cricket'),
            option('POLL', body='ఈ వారం ఏ సినిమా చూస్తున్నారు?', choices=['థియేటర్‌లో', 'OTT లో'], theme='Telugu cinema', language='TELUGU'),
            thoughts=100,
        )))
        result = self.generate(provider, count=3)
        run = result['run']
        self.assertIsNone(result['error'])
        self.assertEqual((run.status, run.provider, run.model_name, run.is_mock), ('SUCCEEDED', 'gemini', 'gemini-test-model', False))
        # Thinking tokens count as output; cost uses the configured prices ($0.30 / $2.50 per million).
        self.assertEqual((run.input_tokens, run.output_tokens), (1200, 400))
        self.assertEqual(run.estimated_cost_usd, Decimal('0.00136'))
        items = result['items']
        self.assertEqual([i.format for i in items], ['TEXT', 'THREAD', 'POLL'])
        self.assertEqual([i.language for i in items], ['TINGLISH', 'ENGLISH', 'TELUGU'])
        self.assertEqual(items[1].thread_posts[0], 'Why tail-enders deserve more credit 🧵')
        self.assertEqual(items[2].poll_options, ['థియేటర్‌లో', 'OTT లో'])
        self.assertEqual(items[2].theme, 'Telugu cinema')
        for item in items:
            self.assertEqual((item.source, item.status), ('AI', 'DRAFT'))
            self.assertEqual(item.dna_snapshot, run.dna_snapshot)
            self.assertNotIn('MOCK_CONTENT', [f['code'] for f in item.validation_flags])
            self.assertEqual(item.revisions.get().note.split(' from ')[-1], 'gemini')

    def test_request_sends_key_in_a_header_and_the_dna_prompt_and_schema(self):
        provider = self.provider((200, reply(option(body='One'), option(body='Two'))))
        self.generate(provider, count=2, fmt='TEXT', instructions='Focus on the weekend match')
        call = self.transport.calls[0]
        self.assertEqual(call['url'], 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent')
        self.assertNotIn(KEY, call['url'])
        self.assertEqual(call['headers']['x-goog-api-key'], KEY)
        self.assertEqual(call['timeout'], 60)
        payload = call['payload']
        self.assertEqual(payload['systemInstruction']['parts'][0]['text'], SYSTEM_PROMPT)
        prompt = payload['contents'][0]['parts'][0]['text']
        for expected in ['Account: @om2_cricket', 'Topics to avoid: Politics', 'Focus on the weekend match', 'Return exactly 2 options']:
            self.assertIn(expected, prompt)
        config = payload['generationConfig']
        self.assertEqual(config['responseMimeType'], 'application/json')
        # Minimal reasoning by default: short posts don't need Gemini 3's default "high" thinking.
        self.assertEqual(config['thinkingConfig'], {'thinkingLevel': 'minimal'})
        items = config['responseSchema']['properties']['candidates']
        self.assertEqual((items['minItems'], items['maxItems']), (2, 2))
        props = items['items']['properties']
        self.assertEqual(props['format']['enum'], ['TEXT'])
        self.assertEqual(props['language']['enum'], ['ENGLISH', 'TINGLISH'])
        self.assertEqual(props['theme']['enum'], ['Cricket', 'Telugu cinema', 'Hyderabad food'])
        # The stored audit prompt is the same text Gemini receives.
        self.assertIn(SYSTEM_PROMPT, GenerationRun.objects.get().prompt)

    def test_any_format_uses_the_accounts_allowed_formats(self):
        self.dna.allowed_formats = ['TEXT', 'POLL']
        self.dna.save()
        self.generate(self.provider((200, reply(option(body='One')))), count=1)
        schema = self.transport.calls[0]['payload']['generationConfig']['responseSchema']
        self.assertEqual(schema['properties']['candidates']['items']['properties']['format']['enum'], ['TEXT', 'POLL'])

    @override_settings(GEMINI_THINKING_LEVEL='low', GEMINI_TIMEOUT_SECONDS=20, GEMINI_MAX_OUTPUT_TOKENS=2048)
    def test_settings_shape_the_request(self):
        self.generate(self.provider((200, reply(option(body='One')))), count=1)
        call = self.transport.calls[0]
        self.assertEqual(call['payload']['generationConfig']['thinkingConfig'], {'thinkingLevel': 'low'})
        self.assertEqual(call['payload']['generationConfig']['maxOutputTokens'], 2048)
        self.assertEqual(call['timeout'], 20)

    @override_settings(GEMINI_THINKING_LEVEL='default')
    def test_default_thinking_level_sends_no_thinking_config(self):
        self.generate(self.provider((200, reply(option(body='One')))), count=1)
        self.assertNotIn('thinkingConfig', self.transport.calls[0]['payload']['generationConfig'])

    def test_unsupported_thinking_levels_step_down_and_stay_down_for_the_batch(self):
        other = XAccount.objects.create(handle='om2_food', display_name='Food')
        ContentDNA.objects.create(x_account=other, **DNA)
        rejected = (400, google_error(400, 'INVALID_ARGUMENT', 'Thinking level MINIMAL is not supported for this model.'))
        provider = self.provider(rejected, (200, reply(option(body='One'))), (200, reply(option(body='Two'))))
        with self.assertLogs('content.providers.gemini', 'WARNING') as logs:
            results = self.generate(provider, count=1, accounts=[self.account.pk, other.pk])
        self.assertEqual([r['items'][0].body for r in results], ['One', 'Two'])
        levels = [c['payload']['generationConfig'].get('thinkingConfig') for c in self.transport.calls]
        self.assertEqual(levels, [{'thinkingLevel': 'minimal'}, {'thinkingLevel': 'low'}, {'thinkingLevel': 'low'}])
        self.assertIn('rejected thinking level "minimal"; using low', logs.output[0])
        self.assertEqual(self.sleeps, [])

    def test_falls_back_to_the_model_default_when_no_level_is_accepted(self):
        rejected = (400, google_error(400, 'INVALID_ARGUMENT', 'thinkingLevel is not supported.'))
        provider = self.provider(rejected, rejected, (200, reply(option(body='One'))))
        with self.assertLogs('content.providers.gemini', 'WARNING'):
            items = self.generate(provider, count=1)['items']
        self.assertEqual(len(items), 1)
        self.assertNotIn('thinkingConfig', self.transport.calls[2]['payload']['generationConfig'])

    def test_logs_timing_and_token_diagnostics_without_content_or_key(self):
        body = reply(option(body='Secret draft text about cricket'), thoughts=42)
        provider = self.provider((200, body, {'Server-Timing': 'gfet4t7; dur=812'}))
        with self.assertLogs('content', 'INFO') as logs:
            run = self.generate(provider, count=1, instructions='Confidential batch instruction')['run']
        output = '\n'.join(logs.output)
        call = next(line for line in logs.output if 'Gemini call:' in line)
        for expected in ['model=gemini-test', 'thinking=minimal', 'status=200', 'attempts=1', 'google_ms=812',
                         'prompt_tokens=1200', 'output_tokens=300', 'thinking_tokens=42', 'options=1', 'finish=STOP']:
            self.assertIn(expected, call)
        summary = next(line for line in logs.output if 'Generation run' in line)
        for expected in [f'Generation run {run.pk} for x_account {self.account.pk}', 'provider=gemini', 'status=SUCCEEDED',
                         'options=1/1', 'provider_calls=1', 'input_tokens=1200', 'output_tokens=342']:
            self.assertIn(expected, summary)
        for secret in [KEY, 'Secret draft text', 'Confidential batch instruction', 'om2_cricket', 'Politics']:
            self.assertNotIn(secret, output)

    def test_duplicates_are_replaced_with_a_follow_up_request(self):
        self.generate(self.provider((200, reply(option(body='Existing post')))), count=1)
        provider = self.provider(
            (200, reply(option(body='Existing post'), option(body='Fresh one'))),
            (200, reply(option(body='Another fresh one'))),
        )
        items = self.generate(provider, count=2)['items']
        self.assertEqual([i.body for i in items], ['Fresh one', 'Another fresh one'])
        follow_up = self.transport.calls[1]['payload']['contents'][0]['parts'][0]['text']
        self.assertIn('duplicated existing posts', follow_up)
        self.assertIn('- Existing post', follow_up)
        self.assertIn('Return exactly 1 option as JSON', follow_up)

    def test_invalid_options_are_dropped_and_replaced(self):
        provider = self.provider(
            (200, reply(option(body='x' * 281), option('POLL', body='Pick one', choices=['Only one']), 'not an object', option(body='Good one'))),
            (200, reply(option(body='Good two'), option(body='Good three'), option(body='One too many'))),
        )
        items = self.generate(provider, count=3)['items']
        self.assertEqual([i.body for i in items], ['Good one', 'Good two', 'Good three'])
        self.assertIn('Return exactly 2 options', self.transport.calls[1]['payload']['contents'][0]['parts'][0]['text'])

    def test_similar_ideas_are_flagged_for_review(self):
        provider = self.provider((200, reply(
            option(body='Chai at Uppal never cancels for rain'), option(body='Chai at Uppal never cancels in rain'),
        )))
        items = self.generate(provider, count=2)['items']
        self.assertEqual(items[1].duplicate_flags[0]['kind'], 'SIMILAR')

    def test_reply_wrapped_in_a_code_fence_and_thought_parts_are_handled(self):
        body = reply(option(body='Fenced'), extra_parts=[{'text': 'planning…', 'thought': True}])
        part = body['candidates'][0]['content']['parts'][1]
        part['text'] = f'```json\n{part["text"]}\n```'
        items = self.generate(self.provider((200, body)), count=1)['items']
        self.assertEqual([i.body for i in items], ['Fenced'])


class GeminiErrorTests(GeminiTestCase):
    def assertFails(self, provider, message, count=1):
        result = self.generate(provider, count=count)
        self.assertEqual(result['run'].status, 'FAILED')
        self.assertEqual(result['error'], message)
        # Never a silent fallback: no content at all, mock or otherwise.
        self.assertFalse(ContentItem.objects.exists())
        return result

    def test_missing_key_fails_without_calling_gemini(self):
        self.assertFails(self.provider(api_key='  '), gemini.NOT_CONFIGURED)
        self.assertEqual(self.transport.calls, [])

    def test_rate_limit_is_not_retried_and_pauses_the_rest_of_the_batch(self):
        other = XAccount.objects.create(handle='om2_food', display_name='Food')
        ContentDNA.objects.create(x_account=other, **DNA)
        retry = {'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '37s'}
        provider = self.provider((429, google_error(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', [retry])))
        results = self.generate(provider, count=1, accounts=[self.account.pk, other.pk])
        self.assertEqual([r['error'] for r in results], [gemini.RATE_LIMITED] * 2)
        self.assertEqual(len(self.transport.calls), 1)
        self.assertEqual(self.sleeps, [])
        self.assertEqual(GenerationRun.objects.filter(status='FAILED').count(), 2)

    def test_daily_quota_has_its_own_message(self):
        quota = {'@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                 'violations': [{'quotaId': 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'}]}
        self.assertFails(self.provider((429, google_error(429, 'RESOURCE_EXHAUSTED', details=[quota]))), gemini.DAILY_LIMIT)

    def test_server_errors_are_retried_with_backoff(self):
        provider = self.provider((503, google_error(503, 'UNAVAILABLE')), (200, reply(option(body='After retry'))))
        items = self.generate(provider, count=1)['items']
        self.assertEqual([i.body for i in items], ['After retry'])
        self.assertEqual(len(self.sleeps), 1)

    @override_settings(GEMINI_MAX_RETRIES=1)
    def test_persistent_server_errors_fail_after_the_retries(self):
        provider = self.provider((503, google_error(503, 'UNAVAILABLE')), (500, b'<html>oops</html>'))
        with self.assertLogs('content.providers.gemini', 'WARNING'):
            self.assertFails(provider, gemini.UNAVAILABLE)
        self.assertEqual(len(self.transport.calls), 2)

    @override_settings(GEMINI_MAX_RETRIES=0, GEMINI_TIMEOUT_SECONDS=15)
    def test_timeouts_and_network_errors(self):
        message = 'Gemini did not respond within 15 seconds. Please try again.'
        with self.assertLogs('content.providers.gemini', 'WARNING'):
            self.assertFails(self.provider(TimeoutError('read timed out')), message)
            # urlopen wraps connect timeouts in URLError.
            self.assertFails(self.provider(urllib.error.URLError(TimeoutError('connect'))), message)
            self.assertFails(self.provider(urllib.error.URLError('Name or service not known')), gemini.UNREACHABLE)

    def test_http_errors_map_to_clear_messages(self):
        key_invalid = {'@type': 'type.googleapis.com/google.rpc.ErrorInfo', 'reason': 'API_KEY_INVALID'}
        cases = [
            ((400, google_error(400, 'INVALID_ARGUMENT', 'API key not valid.', [key_invalid])), gemini.BAD_KEY),
            ((403, google_error(403, 'PERMISSION_DENIED')), gemini.DENIED),
            ((404, google_error(404, 'NOT_FOUND')), 'Gemini model “gemini-test-model” was not found. Check GEMINI_MODEL in backend/.env.'),
            ((400, google_error(400, 'FAILED_PRECONDITION', 'User location is not supported.')), gemini.PRECONDITION),
            ((400, google_error(400, 'INVALID_ARGUMENT', 'Unknown name "foo".')), 'Gemini rejected the request: Unknown name "foo".'),
            ((400, b'not json'), 'Gemini rejected the request.'),
            # A thinking complaint is only a fallback trigger when thinking was sent; otherwise it's a plain 400.
            ((400, google_error(400, 'INVALID_ARGUMENT', 'Bad thinking.')), 'Gemini rejected the request: Bad thinking.'),
        ]
        for response, message in cases:
            with self.subTest(message=message), self.assertLogs('content.providers.gemini', 'WARNING'), \
                    override_settings(GEMINI_THINKING_LEVEL='default'):
                self.assertFails(self.provider(response), message)
            self.assertEqual(self.sleeps, [])  # client errors are never retried

    def test_malformed_and_blocked_responses(self):
        def text_reply(text, finish='STOP'):
            return {'candidates': [{'content': {'parts': [{'text': text}]}, 'finishReason': finish}]}

        with self.assertLogs('content.providers.gemini', 'WARNING'):
            self.assertFails(self.provider((200, b'<html>')), gemini.MALFORMED)
        cases = [
            ((200, {}), gemini.EMPTY),
            ((200, {'candidates': [{'content': {'parts': []}, 'finishReason': 'STOP'}]}), gemini.EMPTY),
            ((200, text_reply('Sure! Here are some posts')), gemini.MALFORMED),
            ((200, text_reply('{"posts": []}')), gemini.MALFORMED),
            ((200, text_reply('{"candidates": [{"format": "TE', finish='MAX_TOKENS')), gemini.TRUNCATED),
            ((200, {'promptFeedback': {'blockReason': 'PROHIBITED_CONTENT'}}), gemini.BLOCKED.format(reason='prohibited content')),
            ((200, text_reply('', finish='SAFETY')), gemini.BLOCKED.format(reason='safety')),
        ]
        for response, message in cases:
            with self.subTest(message=message):
                self.assertFails(self.provider(response), message)

    def test_no_usable_options_fails_the_run(self):
        invalid = (200, reply(option(body='x' * 300)))
        self.assertFails(self.provider(invalid, invalid, invalid), 'The provider returned no usable options. Please try again.')
        self.assertEqual(len(self.transport.calls), 3)  # the first try plus two replacement rounds

    def test_the_key_never_appears_in_errors_logs_or_repr(self):
        echo = google_error(400, 'INVALID_ARGUMENT', f'Bad request for key {KEY}')
        provider = self.provider((400, echo))
        with self.assertLogs('content.providers.gemini', 'WARNING') as logs:
            result = self.assertFails(provider, 'Gemini rejected the request: Bad request for key ***')
        self.assertNotIn(KEY, '\n'.join(logs.output))
        self.assertNotIn(KEY, result['run'].error + result['run'].prompt)
        self.assertNotIn(KEY, repr(provider))


class GeminiTransportTests(TestCase):
    """The default urllib transport, with urlopen patched so nothing leaves the machine."""

    def test_posts_json_with_the_key_header(self):
        response = mock.MagicMock(status=200, headers={'Server-Timing': 'gfet4t7; dur=5'})
        response.read.return_value = b'{"ok": true}'
        response.__enter__.return_value = response
        with mock.patch('urllib.request.urlopen', return_value=response) as urlopen:
            result = gemini._urllib_transport('https://example.test/x', {'x-goog-api-key': KEY}, b'{}', 9)
        request = urlopen.call_args.args[0]
        self.assertEqual(result, (200, b'{"ok": true}', {'Server-Timing': 'gfet4t7; dur=5'}))
        self.assertEqual((request.get_method(), request.full_url, request.data), ('POST', 'https://example.test/x', b'{}'))
        self.assertEqual(request.get_header('X-goog-api-key'), KEY)
        self.assertEqual(urlopen.call_args.kwargs['timeout'], 9)

    def test_http_errors_return_status_and_body(self):
        error = urllib.error.HTTPError('https://example.test/x', 429, 'Too Many Requests', {}, io.BytesIO(b'{"error": {}}'))
        with mock.patch('urllib.request.urlopen', side_effect=error):
            self.assertEqual(gemini._urllib_transport('https://example.test/x', {}, b'{}', 9), (429, b'{"error": {}}', {}))


class GeminiConfigurationTests(TestCase):
    @override_settings(CONTENT_AI_PROVIDER='gemini', GEMINI_MODEL='gemini-3.5-flash-lite')
    def test_gemini_is_selectable_and_reported_as_real_ai(self):
        provider = get_provider()
        self.assertIsInstance(provider, GeminiProvider)
        self.assertFalse(provider.is_mock)
        boss = User.objects.create_user(username='boss', password='x', role=User.Role.MILLIONAIRE)
        client = APIClient()
        client.force_login(boss)
        self.assertEqual(
            client.get('/api/content/provider/').json(),
            {'name': 'gemini', 'model_name': 'gemini-3.5-flash-lite', 'label': 'Google Gemini', 'is_mock': False},
        )

    def test_tests_never_use_real_gemini(self):
        # The test runner overrides backend/.env so no test can call the real API.
        self.assertEqual(get_provider().name, 'mock')
        with self.assertRaisesMessage(AssertionError, 'must not make real HTTP requests'):
            gemini._urllib_transport('https://generativelanguage.googleapis.com/v1beta/models', {}, b'{}', 5)

    def test_system_checks(self):
        def ids():
            return [m.id for m in run_checks() if m.id and m.id.startswith('content.')]

        self.assertEqual(ids(), [])
        with override_settings(CONTENT_AI_PROVIDER='gemini', GEMINI_API_KEY=''):
            self.assertEqual(ids(), ['content.W001'])
        with override_settings(CONTENT_AI_PROVIDER='gemini', GEMINI_API_KEY=KEY):
            self.assertEqual(ids(), [])
        with override_settings(CONTENT_AI_PROVIDER='claude', GEMINI_INPUT_USD_PER_MILLION='abc', GEMINI_THINKING_LEVEL='turbo'):
            self.assertEqual(ids(), ['content.E001', 'content.E003', 'content.E002'])
