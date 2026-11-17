"""Content validation and duplicate detection.

Hard rules (X length limits, required parts) block saving. Everything else becomes a
warning flag that a Millionaire must acknowledge before approving.
"""

import hashlib
import re
import unicodedata

from x_accounts.models import ContentDNA

from .models import (
    POLL_MAX_OPTIONS,
    POLL_MIN_OPTIONS,
    POLL_OPTION_MAX_LENGTH,
    POST_MAX_LENGTH,
    THREAD_MAX_POSTS,
    THREAD_MIN_POSTS,
    ContentItem,
)

Format = ContentDNA.Format

# Word-overlap similarity at or above this is flagged as a similar idea.
SIMILARITY_THRESHOLD = 0.6
# How many recent posts are compared for similarity (exact matches use the whole table).
SIMILARITY_WINDOW = 1000
MAX_DUPLICATE_FLAGS = 3
MAX_HASHTAGS = 2

_STOPWORDS = frozenset(
    'a an and are as at be but by for from has have i if in is it its of on or so that the this to was we with you your'.split()
)
_LINK = re.compile(r'https?://|www\.', re.IGNORECASE)
_HASHTAG = re.compile(r'(?<!\w)#\w+')


def normalize_text(text):
    """Lower-case, accent-folded, punctuation-free text with single spaces."""
    text = unicodedata.normalize('NFKC', text).casefold()
    text = re.sub(r'https?://\S+', ' ', text)
    # Keep combining marks: Telugu vowel signs and viramas are marks, and dropping them split every word.
    text = ''.join(ch if ch.isalnum() or ch.isspace() or unicodedata.category(ch).startswith('M') else ' ' for ch in text)
    return ' '.join(text.split())


def fingerprint(text):
    return hashlib.sha256(normalize_text(text).encode()).hexdigest()


def _words(text):
    return {w for w in normalize_text(text).split() if w not in _STOPWORDS and len(w) > 1}


def similarity(a, b):
    """Jaccard overlap of meaningful words: 1.0 is the same wording, 0 is nothing shared."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def clean_parts(fmt, body='', thread_posts=(), poll_options=()):
    """Trim every part and drop the parts that don't belong to the format."""
    body = (body or '').strip()
    posts = [p.strip() for p in thread_posts or []]
    options = [o.strip() for o in poll_options or []]
    if fmt == Format.THREAD:
        return '', posts, []
    if fmt == Format.POLL:
        return body, [], options
    return body, [], []


def validation_errors(fmt, body, thread_posts, poll_options):
    """Rules every post must meet, as {field: [messages]}. Expects clean_parts() output."""
    errors = {}
    if fmt not in Format.values:
        return {'format': [f'Choose one of: {", ".join(Format.labels)}.']}
    if fmt == Format.THREAD:
        problems = []
        if not THREAD_MIN_POSTS <= len(thread_posts) <= THREAD_MAX_POSTS:
            problems.append(f'A thread needs {THREAD_MIN_POSTS} to {THREAD_MAX_POSTS} posts.')
        for i, post in enumerate(thread_posts, start=1):
            if not post:
                problems.append(f'Post {i} is empty.')
            elif len(post) > POST_MAX_LENGTH:
                problems.append(f'Post {i} is {len(post)} characters; the limit is {POST_MAX_LENGTH}.')
        if problems:
            errors['thread_posts'] = problems
        return errors

    label = 'poll question' if fmt == Format.POLL else 'post'
    if not body:
        errors['body'] = [f'Write the {label}.']
    elif len(body) > POST_MAX_LENGTH:
        errors['body'] = [f'The {label} is {len(body)} characters; the limit is {POST_MAX_LENGTH}.']
    if fmt == Format.POLL:
        problems = []
        if not POLL_MIN_OPTIONS <= len(poll_options) <= POLL_MAX_OPTIONS:
            problems.append(f'A poll needs {POLL_MIN_OPTIONS} to {POLL_MAX_OPTIONS} options.')
        seen = set()
        for i, option in enumerate(poll_options, start=1):
            if not option:
                problems.append(f'Option {i} is empty.')
            elif len(option) > POLL_OPTION_MAX_LENGTH:
                problems.append(f'Option {i} is longer than {POLL_OPTION_MAX_LENGTH} characters.')
            elif option.casefold() in seen:
                problems.append(f'Option {i} repeats another option.')
            seen.add(option.casefold())
        if problems:
            errors['poll_options'] = problems
    return errors


def _flag(code, message):
    return {'code': code, 'message': message}


def validation_flags(fmt, text, dna=None, is_mock=False):
    """Warnings for review. `dna` is a Content DNA snapshot dict, or None."""
    flags = []
    if is_mock:
        flags.append(_flag('MOCK_CONTENT', 'Written by the mock provider as sample text. Rewrite it before approving.'))
    if dna is None:
        flags.append(_flag('NO_CONTENT_DNA', 'This account has no Content DNA to check against.'))
    else:
        if fmt not in dna.get('allowed_formats', []):
            flags.append(_flag('FORMAT_NOT_ALLOWED', f'{Format(fmt).label} is not one of this account’s allowed formats.'))
        normalized = f' {normalize_text(text)} '
        for topic in dna.get('topics_to_avoid', []):
            term = normalize_text(topic)
            if term and f' {term} ' in normalized:
                flags.append(_flag('AVOIDED_TOPIC', f'Mentions “{topic}”, a topic this account avoids.'))
    if _LINK.search(text):
        flags.append(_flag('CONTAINS_LINK', 'Contains a link. Check that it is correct and appropriate.'))
    if len(_HASHTAG.findall(text)) > MAX_HASHTAGS:
        flags.append(_flag('MANY_HASHTAGS', f'Uses more than {MAX_HASHTAGS} hashtags.'))
    return flags


def _excerpt(text, length=80):
    text = ' '.join(text.split())
    return text if len(text) <= length else text[: length - 1] + '…'


def duplicate_flags(account_id, text, exclude_id=None):
    """Exact and similar matches among stored posts, same account first, then network-wide."""
    print_ = fingerprint(text)
    others = ContentItem.objects.select_related('x_account').exclude(pk=exclude_id)
    exact = list(others.filter(fingerprint=print_)[:MAX_DUPLICATE_FLAGS])
    exact_ids = {i.pk for i in exact}
    flags = [_match(i, account_id, 1.0, 'EXACT') for i in exact]

    candidates = []
    for item in others.exclude(pk__in=exact_ids).only(
        'id', 'x_account__handle', 'x_account_id', 'status', 'format', 'body', 'thread_posts', 'poll_options'
    )[:SIMILARITY_WINDOW]:
        score = similarity(text, item.full_text)
        if score >= SIMILARITY_THRESHOLD:
            candidates.append((item.x_account_id != account_id, -score, item))
    candidates.sort(key=lambda c: (c[0], c[1], c[2].pk))
    flags += [_match(item, account_id, -neg, 'SIMILAR') for _, neg, item in candidates]
    return flags[:MAX_DUPLICATE_FLAGS]


def _match(item, account_id, score, kind):
    return {
        'kind': kind,
        'scope': 'ACCOUNT' if item.x_account_id == account_id else 'NETWORK',
        'similarity': round(score, 2),
        'item_id': item.pk,
        'label': f'@{item.x_account.handle} · {item.get_status_display()}',
        'excerpt': _excerpt(item.full_text),
    }
