"""Google Gemini via the generateContent REST API (generativelanguage.googleapis.com).

Uses only the standard library. The API key is read from settings (GEMINI_API_KEY in
backend/.env) and sent in the x-goog-api-key header, never in the URL; it is never
logged, stored or included in error messages. There is no fallback: when Gemini fails,
the run fails with a clear message and no mock content is produced.

Usage limits (requests per minute/day, tokens) and whether usage is billed are set by
the Google project that owns the key. This code never changes billing or tiers.
"""

import json
import logging
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal

from django.conf import settings

from ..models import POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX_LENGTH, POST_MAX_LENGTH, THREAD_MAX_POSTS, THREAD_MIN_POSTS
from .base import Candidate, ContentProvider, GenerationRequest, GenerationResult, ProviderError

logger = logging.getLogger(__name__)

API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'

NOT_CONFIGURED = 'Gemini is not configured. Set GEMINI_API_KEY in backend/.env and restart the backend.'
RATE_LIMITED = (
    'Gemini’s rate limit for this Google project was reached. Wait a minute and try again with fewer accounts. '
    'Limits depend on the project’s settings in Google AI Studio.'
)
DAILY_LIMIT = (
    'Gemini’s daily request limit for this Google project was reached. Try again tomorrow, or review the '
    'project’s limits in Google AI Studio.'
)
UNAVAILABLE = 'Gemini is temporarily unavailable or overloaded. Please try again in a few minutes.'
UNREACHABLE = 'Could not reach Gemini. Check the server’s internet connection and try again.'
BAD_KEY = 'Gemini rejected the API key. Check GEMINI_API_KEY in backend/.env.'
DENIED = 'Gemini denied access for this API key’s Google project. Check the project in Google AI Studio.'
PRECONDITION = (
    'Gemini can’t serve this Google project (for example, the free tier isn’t offered in its region). '
    'Check the project in Google AI Studio.'
)
MALFORMED = 'Gemini returned a response OM2 could not read. Please try again.'
EMPTY = 'Gemini returned no content. Please try again.'
TRUNCATED = 'Gemini’s reply was cut off. Try fewer options, or raise GEMINI_MAX_OUTPUT_TOKENS.'
BLOCKED = 'Gemini declined to write this ({reason}). Adjust the batch instructions or Content DNA and try again.'

# Statuses worth retrying after a short pause. 429 is not retried: OM2 waits instead (see _blocked_until).
_RETRY_STATUSES = {500, 502, 503, 504}
# Finish reasons that mean the model refused or stopped for policy reasons.
_BLOCK_REASONS = {'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE'}
# Without a retry hint, a rate limit pauses further calls in this batch for this long.
_DEFAULT_RATE_LIMIT_PAUSE = 30
# Thinking levels to try, lowest first, when a model rejects the configured one. None sends
# no thinkingConfig, i.e. the model's default (which is "high" for Gemini 3 models).
_THINKING_FALLBACKS = {'minimal': ['minimal', 'low', None], 'default': [None]}
# Google's front-end processing time, e.g. "gfet4t7; dur=1234".
_SERVER_TIMING = re.compile(r'dur=([0-9.]+)')


class _ThinkingRejected(Exception):
    """The model doesn't accept the thinking level that was sent."""


def _urllib_transport(url, headers, body, timeout):
    """POSTs JSON (or GETs when body is None); returns (status, bytes, headers). Raises OSError on failure."""
    request = urllib.request.Request(url, data=body, headers=headers, method='GET' if body is None else 'POST')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, exc.read(), dict(exc.headers or {})


class GeminiProvider(ContentProvider):
    name = 'gemini'
    label = 'Google Gemini'
    supports_model_choice = True

    def __init__(self, *, api_key=None, model=None, thinking_level=None, transport=_urllib_transport, sleep=time.sleep):
        self._api_key = (settings.GEMINI_API_KEY if api_key is None else api_key).strip()
        self.model_name = model or settings.GEMINI_MODEL
        self.timeout = settings.GEMINI_TIMEOUT_SECONDS
        self.max_retries = settings.GEMINI_MAX_RETRIES
        self.max_output_tokens = settings.GEMINI_MAX_OUTPUT_TOKENS
        level = thinking_level or settings.GEMINI_THINKING_LEVEL
        # The levels still to try; a rejected level is dropped for the rest of this batch.
        self._thinking_levels = list(_THINKING_FALLBACKS.get(level, [level, None]))
        self.input_price_per_million = Decimal(settings.GEMINI_INPUT_USD_PER_MILLION)
        self.output_price_per_million = Decimal(settings.GEMINI_OUTPUT_USD_PER_MILLION)
        self._transport = transport
        self._sleep = sleep
        # After a rate limit, later accounts in the same batch fail fast instead of piling on.
        self._blocked_until = 0.0
        self._blocked_message = RATE_LIMITED

    def __repr__(self):
        # Never show the key, e.g. in debug pages or logged locals.
        return f'<GeminiProvider model={self.model_name!r}>'

    def generate(self, request: GenerationRequest) -> GenerationResult:
        if not self._api_key:
            raise ProviderError(NOT_CONFIGURED)
        if time.monotonic() < self._blocked_until:
            raise ProviderError(self._blocked_message)
        started = time.monotonic()
        while True:
            try:
                data, stats = self._post(self._payload(request))
                break
            except _ThinkingRejected:
                rejected = self._thinking_levels.pop(0)
                logger.warning(
                    'Gemini model %s rejected thinking level "%s"; using %s. Set GEMINI_THINKING_LEVEL to a level it supports.',
                    self.model_name, rejected, self._thinking_levels[0] or 'the model default',
                )
        stats['provider_ms'] = _ms(started)
        return self._parse(data, stats)

    @property
    def thinking_level(self):
        """The thinking level sent with requests, or None for the model default."""
        return self._thinking_levels[0]

    def list_models(self):
        """Models this key can call with generateContent (a free metadata request; no tokens used)."""
        if not self._api_key:
            raise ProviderError(NOT_CONFIGURED)
        models, token = [], ''
        for _ in range(20):  # pages; guards against a looping page token
            query = '?pageSize=1000' + (f'&pageToken={urllib.parse.quote(token)}' if token else '')
            try:
                status, raw, _headers = self._transport(f'{API_ROOT}/models{query}', {'x-goog-api-key': self._api_key}, None, self.timeout)
            except OSError:
                raise ProviderError(UNREACHABLE) from None
            if status != 200:
                raise self._http_error(status, raw)
            try:
                data = json.loads(raw)
            except ValueError:
                raise ProviderError(MALFORMED) from None
            for model in data.get('models', []):
                if 'generateContent' in model.get('supportedGenerationMethods', []):
                    models.append({
                        'name': str(model.get('name', '')).removeprefix('models/'),
                        'display_name': model.get('displayName', ''),
                        'version': model.get('version', ''),
                        'output_token_limit': model.get('outputTokenLimit'),
                        'thinking': bool(model.get('thinking')),
                    })
            token = data.get('nextPageToken', '')
            if not token:
                break
        return sorted(models, key=lambda m: m['name'])

    # Request

    def _payload(self, request):
        config = {
            'responseMimeType': 'application/json',
            'responseSchema': response_schema(request),
            'maxOutputTokens': self.max_output_tokens,
        }
        # Short posts need little reasoning; Gemini 3 otherwise defaults to high thinking, which is slow.
        if self.thinking_level:
            config['thinkingConfig'] = {'thinkingLevel': self.thinking_level}
        return {
            'systemInstruction': {'parts': [{'text': request.system_prompt}]},
            'contents': [{'role': 'user', 'parts': [{'text': user_message(request)}]}],
            'generationConfig': config,
        }

    def _post(self, payload):
        url = f'{API_ROOT}/models/{self.model_name}:generateContent'
        headers = {'Content-Type': 'application/json', 'x-goog-api-key': self._api_key}
        body = json.dumps(payload).encode()
        for attempt in range(self.max_retries + 1):
            last = attempt == self.max_retries
            sent = time.monotonic()
            try:
                status, raw, response_headers = self._transport(url, headers, body, self.timeout)
            except OSError as exc:
                # Includes URLError; urlopen wraps connect timeouts in one. No key in its text (it's a header).
                if isinstance(exc, TimeoutError) or isinstance(getattr(exc, 'reason', None), TimeoutError):
                    logger.warning('Gemini timed out after %ss (model %s, attempt %d)', self.timeout, self.model_name, attempt + 1)
                    if last:
                        raise ProviderError(f'Gemini did not respond within {self.timeout} seconds. Please try again.') from None
                else:
                    logger.warning('Gemini unreachable (model %s, attempt %d): %s', self.model_name, attempt + 1, type(exc).__name__)
                    if last:
                        raise ProviderError(UNREACHABLE) from None
            else:
                stats = {
                    'attempts': attempt + 1,
                    'http_status': status,
                    'http_ms': _ms(sent),
                    'server_ms': _server_ms(response_headers),
                    'request_bytes': len(body),
                    'response_bytes': len(raw),
                }
                if status == 200:
                    try:
                        return json.loads(raw), stats
                    except ValueError:
                        logger.warning('Gemini sent invalid JSON (model %s)', self.model_name)
                        raise ProviderError(MALFORMED) from None
                if status == 400 and self.thinking_level and 'thinking' in str(_error_body(raw).get('message', '')).lower():
                    raise _ThinkingRejected
                if status not in _RETRY_STATUSES or last:
                    raise self._http_error(status, raw)
                logger.warning('Gemini HTTP %s (model %s, attempt %d); retrying', status, self.model_name, attempt + 1)
            self._sleep(min(2**attempt, 8) + random.uniform(0, 0.5))
        raise ProviderError(UNAVAILABLE)  # Not reached: the last attempt always returns or raises.

    def _http_error(self, status, raw):
        error = _error_body(raw)
        google_status = error.get('status', '')
        reasons = {d.get('reason', '') for d in error.get('details', []) if isinstance(d, dict)}
        logger.warning('Gemini HTTP %s %s %s (model %s)', status, google_status, ','.join(sorted(filter(None, reasons))), self.model_name)

        if status == 429:
            daily = 'PerDay' in json.dumps(error.get('details', []))
            delay = _retry_delay(error) or _DEFAULT_RATE_LIMIT_PAUSE
            self._blocked_message = DAILY_LIMIT if daily else RATE_LIMITED
            self._blocked_until = time.monotonic() + delay
            return ProviderError(self._blocked_message)
        if 'API_KEY_INVALID' in reasons or status == 401:
            return ProviderError(BAD_KEY)
        if status == 403:
            return ProviderError(DENIED)
        if status == 404:
            return ProviderError(f'Gemini model “{self.model_name}” was not found. Check GEMINI_MODEL in backend/.env.')
        if google_status == 'FAILED_PRECONDITION':
            return ProviderError(PRECONDITION)
        if status == 400:
            detail = str(error.get('message', '')).replace(self._api_key, '***')[:200]
            return ProviderError(f'Gemini rejected the request: {detail}' if detail else 'Gemini rejected the request.')
        return ProviderError(UNAVAILABLE)

    # Response

    def _parse(self, data, stats):
        if not isinstance(data, dict):
            raise ProviderError(MALFORMED)
        feedback = data.get('promptFeedback') or {}
        if feedback.get('blockReason'):
            raise ProviderError(BLOCKED.format(reason=_reason(feedback['blockReason'])))
        candidates = data.get('candidates') or []
        if not candidates or not isinstance(candidates[0], dict):
            raise ProviderError(EMPTY)
        first = candidates[0]
        finish = first.get('finishReason', '')
        if finish in _BLOCK_REASONS:
            raise ProviderError(BLOCKED.format(reason=_reason(finish)))
        parts = (first.get('content') or {}).get('parts') or []
        text = ''.join(p.get('text', '') for p in parts if isinstance(p, dict) and not p.get('thought'))
        if not text.strip():
            raise ProviderError(TRUNCATED if finish == 'MAX_TOKENS' else EMPTY)
        try:
            reply = json.loads(_strip_fence(text))
        except ValueError:
            raise ProviderError(TRUNCATED if finish == 'MAX_TOKENS' else MALFORMED) from None
        options = reply.get('candidates') if isinstance(reply, dict) else None
        if not isinstance(options, list):
            raise ProviderError(MALFORMED)

        usage = data.get('usageMetadata') or {}
        candidates = [c for c in map(_candidate, options) if c]
        diagnostics = {
            **stats,
            'model_version': data.get('modelVersion', ''),
            'thinking_level': self.thinking_level or 'model default',
            'finish_reason': finish,
            'prompt_tokens': _int(usage.get('promptTokenCount')),
            'output_tokens': _int(usage.get('candidatesTokenCount')),
            'thinking_tokens': _int(usage.get('thoughtsTokenCount')),
            'options': len(candidates),
        }
        # Sizes and timings only: never the prompt, the reply text or the key.
        logger.info(
            'Gemini call: model=%(model_version)s thinking=%(thinking_level)s status=%(http_status)s attempts=%(attempts)s '
            'total_ms=%(provider_ms)s http_ms=%(http_ms)s google_ms=%(server_ms)s prompt_tokens=%(prompt_tokens)s '
            'output_tokens=%(output_tokens)s thinking_tokens=%(thinking_tokens)s request_bytes=%(request_bytes)s '
            'response_bytes=%(response_bytes)s options=%(options)s finish=%(finish_reason)s',
            {**diagnostics, 'model_version': diagnostics['model_version'] or self.model_name},
        )
        return GenerationResult(
            candidates=candidates,
            input_tokens=diagnostics['prompt_tokens'],
            # Thinking tokens are billed as output.
            output_tokens=diagnostics['output_tokens'] + diagnostics['thinking_tokens'],
            raw=diagnostics,
        )


def response_schema(request):
    """The JSON shape Gemini must return, limited to this account's formats, languages and themes."""
    dna = request.dna
    formats = [request.format] if request.format else list(dna['allowed_formats'])
    themes = list(dict.fromkeys([*dna['primary_themes'], *dna.get('secondary_themes', [])]))
    strings = {'type': 'ARRAY', 'items': {'type': 'STRING'}}
    option = {
        'type': 'OBJECT',
        'properties': {
            'format': {'type': 'STRING', 'enum': formats},
            'language': {'type': 'STRING', 'enum': list(dna['languages'])},
            'theme': {'type': 'STRING', 'enum': themes} if themes else {'type': 'STRING'},
            'body': {'type': 'STRING'},
            'thread_posts': strings,
            'poll_options': strings,
        },
        'required': ['format', 'language', 'theme', 'body', 'thread_posts', 'poll_options'],
        'propertyOrdering': ['format', 'language', 'theme', 'body', 'thread_posts', 'poll_options'],
    }
    return {
        'type': 'OBJECT',
        'properties': {'candidates': {'type': 'ARRAY', 'items': option, 'minItems': request.count, 'maxItems': request.count}},
        'required': ['candidates'],
    }


def user_message(request):
    """The stored prompt, plus what a replacement round needs (fewer options, texts to avoid)."""
    lines = [request.user_prompt]
    if request.avoid:
        lines.append('These drafts duplicated existing posts. Write something different from each:')
        lines += [f'- {text}' for text in request.avoid]
    lines.append(
        f'Return exactly {request.count} option{"s" if request.count != 1 else ""} as JSON. Limits: text posts, poll '
        f'questions and each thread post at most {POST_MAX_LENGTH} characters; threads {THREAD_MIN_POSTS}-{THREAD_MAX_POSTS} '
        f'posts; polls {POLL_MIN_OPTIONS}-{POLL_MAX_OPTIONS} options of at most {POLL_OPTION_MAX_LENGTH} characters.'
    )
    return '\n'.join(lines)


def _candidate(option):
    """A Candidate from one reply entry, or None. Length and count rules are checked by the service."""
    if not isinstance(option, dict):
        return None

    def strings(key):
        values = option.get(key)
        return tuple(str(v) for v in values if isinstance(v, (str, int, float))) if isinstance(values, list) else ()

    return Candidate(
        format=str(option.get('format', '')).strip().upper(),
        body=str(option.get('body') or ''),
        thread_posts=strings('thread_posts'),
        poll_options=strings('poll_options'),
        theme=str(option.get('theme') or '').strip(),
        language=str(option.get('language') or '').strip().upper(),
    )


def _error_body(raw):
    try:
        error = json.loads(raw).get('error')
    except (ValueError, AttributeError):
        return {}
    return error if isinstance(error, dict) else {}


def _retry_delay(error):
    """Seconds from a google.rpc.RetryInfo detail such as {"retryDelay": "37s"}, or None."""
    for detail in error.get('details', []):
        value = detail.get('retryDelay') if isinstance(detail, dict) else None
        if isinstance(value, str) and value.endswith('s'):
            try:
                return min(max(float(value[:-1]), 1.0), 300.0)
            except ValueError:
                return None
    return None


def _strip_fence(text):
    text = text.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else ''
        text = text.rsplit('```', 1)[0]
    return text


def _reason(code):
    return str(code).replace('_', ' ').lower()


def _ms(since):
    return int((time.monotonic() - since) * 1000)


def _server_ms(headers):
    """Google's own processing time from the Server-Timing header, or None."""
    value = next((v for k, v in (headers or {}).items() if k.lower() == 'server-timing'), '')
    match = _SERVER_TIMING.search(value)
    return int(float(match.group(1))) if match else None


def _int(value):
    return value if isinstance(value, int) and value > 0 else 0
