"""Optional TinyURL shortening for the X compose link in WhatsApp messages.

Uses TinyURL's official API (POST https://api.tinyurl.com/create), which needs an API
token from a TinyURL account (TINYURL_API_TOKEN in backend/.env). Short links are stored in
ShortLink so each long URL is shortened once. Without a token, or when TinyURL fails, callers
keep the original X link: shortening is never required for WhatsApp distribution.
"""

import hashlib
import json
import logging
import urllib.error
import urllib.request

from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction

from .models import ShortLink

logger = logging.getLogger(__name__)

TINYURL_CREATE_URL = 'https://api.tinyurl.com/create'
SHORT_URL_PREFIX = 'https://tinyurl.com/'
# After an auth, plan or rate-limit refusal, stop calling TinyURL for a while.
COOLDOWN_KEY = 'tinyurl:cooldown'
COOLDOWN_SECONDS = 10 * 60
COOLDOWN_STATUSES = {401, 402, 403, 429}


def url_hash(long_url):
    return hashlib.sha256(long_url.encode()).hexdigest()


def cached_short_urls(long_urls):
    """{long_url: short_url} for the URLs already shortened. One query, no network."""
    hashes = {url_hash(u): u for u in long_urls}
    found = ShortLink.objects.filter(long_url_hash__in=hashes).values_list('long_url_hash', 'short_url')
    return {hashes[h]: short for h, short in found}


def _request_short_url(long_url, token):
    body = json.dumps({'url': long_url, 'domain': 'tinyurl.com'}).encode()
    request = urllib.request.Request(
        TINYURL_CREATE_URL,
        data=body,
        method='POST',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'Accept': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=settings.TINYURL_TIMEOUT_SECONDS) as response:
        data = json.loads(response.read().decode())
    short_url = (data.get('data') or {}).get('tiny_url', '')
    if not isinstance(short_url, str) or not short_url.startswith(SHORT_URL_PREFIX):
        raise ValueError('TinyURL response had no tiny_url.')
    return short_url


def shorten(long_url):
    """The cached or newly created short URL for `long_url`, or None to keep the long one.

    Never raises: any TinyURL problem is logged (without the token) and returns None."""
    if existing := cached_short_urls([long_url]).get(long_url):
        return existing
    token = settings.TINYURL_API_TOKEN
    if not token or cache.get(COOLDOWN_KEY):
        return None
    try:
        short_url = _request_short_url(long_url, token)
    except urllib.error.HTTPError as exc:
        if exc.code in COOLDOWN_STATUSES:
            cache.set(COOLDOWN_KEY, True, COOLDOWN_SECONDS)
        logger.warning('TinyURL refused a link (HTTP %s); using the full X link.', exc.code)
        return None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        logger.warning('TinyURL shortening failed (%s); using the full X link.', type(exc).__name__)
        return None
    try:
        with transaction.atomic():
            ShortLink.objects.create(long_url_hash=url_hash(long_url), long_url=long_url, short_url=short_url)
    except IntegrityError:
        # Another request stored it first; both short links work, keep the stored one.
        return cached_short_urls([long_url]).get(long_url, short_url)
    return short_url
