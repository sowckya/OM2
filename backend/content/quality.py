"""Content quality intelligence: history for prompts, and explainable quality warnings.

Everything here is deterministic and offline (word lists and simple statistics, no AI
calls). Quality checks only add warnings for review; they never block or reject a post.
"""

import re
import zlib
from collections import Counter
from dataclasses import dataclass, field

from .checks import normalize_text
from .models import ContentItem, GenerationRun

# How much history is read. Each check reads at most this many rows, using indexed ordering.
ACCOUNT_HISTORY = 50
NETWORK_HISTORY = 300
OPENING_WORDS = 3
# An opening is "common" when this many other accounts used it recently.
COMMON_OPENING_ACCOUNTS = 2
# Structure repetition: this many of the account's last STRUCTURE_WINDOW text posts share a shape.
STRUCTURE_WINDOW = 5
STRUCTURE_REPEATS = 4
MAX_EMOJI = 3

TELUGU = re.compile(r'[ఀ-౿]')
LATIN = re.compile(r'[A-Za-z]')
EMOJI = re.compile(r'[\U0001F300-\U0001FAFF☀-➿]')
HASHTAG = re.compile(r'(?<!\w)#\w+')

# Common Telugu words as written in English letters (Tinglish). Chosen to rarely collide with English.
TINGLISH_WORDS = frozenset('''
    ante antaru anukunta anipistundi aithe akkada appudu asalu avtundi avthundi baga bagundi baagundi
    cheppandi cheppu cheyandi cheyyali chesthe chesaru chala chaala chusara chusthe chudandi chudali
    eppudu enduku endhuku enti entra ela emi emo inka ippudu ikkada idi kada kadha kani kooda kuda
    maata mana manam meeru meeku memu mari naaku nenu nijam okka oka pakka pilla roju undi untundi
    unnaru unnara unnadu vachindi vastundi vaadu vallu vere ga lo ki tho gurinchi ledu leru kaadu
    avunu sare nuvvu neeku mee naa ee aa adhi edhi chesi tinnava tinte vellali velthe
'''.split())

# Stock phrases that make posts sound generic or machine-written.
CLICHES = (
    'unpopular opinion', 'hot take', 'lets talk about', 'let that sink in', 'game changer', 'at the end of the day',
    'never give up', 'believe in yourself', 'rise and grind', 'dream big', 'stay positive', 'consistency is key',
    'in todays fast paced world', 'its not just about', 'heres the thing', 'heres why', 'buckle up', 'dive into',
    'deep dive', 'delve into', 'a testament to', 'tapestry', 'embark on', 'unlock your', 'elevate your',
    'the power of', 'every day is a new', 'small steps', 'one more try', 'the little things', 'life is a journey',
)
# Phrases asking for likes, shares or follows instead of earning them.
ENGAGEMENT_BAIT = (
    'like if you agree', 'retweet if', 'rt if', 'like and share', 'follow for more', 'tag a friend', 'tag someone',
    'share if', 'comment below', 'drop a comment', 'who agrees', 'like cheyandi', 'share cheyandi', 'follow avvandi',
    'comment cheyandi', 'లైక్ చేయండి', 'షేర్ చేయండి', 'కామెంట్ చేయండి', 'ఫాలో అవ్వండి',
)
# Words that carry no specific information on their own.
VAGUE_WORDS = frozenset('''
    thing things life people everything something anything everyone someone moment moments journey day days time
    world really just always never best good great amazing important truly simply very much more less way ways
    today tomorrow make makes made get gets got go going keep stuff feel feels know think matters matter
'''.split())
_STOPWORDS = frozenset('''
    a an and are as at be but by for from has have i if in is it its of on or so that the this to was we with you
    your my me our us they them their he she his her what when where who why how do does did not no yes can will
    would should could about than then there here all any some just too also only
'''.split())

LANGUAGE_LABELS = {'ENGLISH': 'English', 'TELUGU': 'Telugu', 'TINGLISH': 'Tinglish'}


# History

@dataclass(frozen=True)
class History:
    """What an account (and the network) posted recently. Built by load_history()."""

    recent_posts: tuple[str, ...] = ()  # this account, newest first, rejected excluded
    recent_text_posts: tuple[str, ...] = ()  # this account's TEXT posts, newest first
    theme_counts: dict = field(default_factory=dict)  # theme -> uses in recent_posts
    batch_number: int = 0  # generations so far, to rotate plans between batches
    network_openings: dict = field(default_factory=dict)  # opening -> distinct other accounts using it


def load_history(account_id, exclude_id=None):
    """Two small queries: the account's recent posts and the network's recent openings."""
    if account_id is None:
        return History()
    fields = ('id', 'x_account_id', 'format', 'body', 'thread_posts', 'poll_options', 'theme')
    mine = list(
        ContentItem.objects.filter(x_account_id=account_id).exclude(pk=exclude_id)
        .exclude(status=ContentItem.Status.REJECTED).only(*fields).order_by('-created_at', '-id')[:ACCOUNT_HISTORY]
    )
    others = ContentItem.objects.exclude(x_account_id=account_id).exclude(status=ContentItem.Status.REJECTED) \
        .only(*fields).order_by('-created_at', '-id')[:NETWORK_HISTORY]
    users = {}
    for item in others:
        if opening := opening_of(item.full_text):
            users.setdefault(opening, set()).add(item.x_account_id)
    return History(
        recent_posts=tuple(i.full_text for i in mine),
        recent_text_posts=tuple(i.full_text for i in mine if i.format == 'TEXT'),
        theme_counts=dict(Counter(i.theme for i in mine if i.theme)),
        batch_number=GenerationRun.objects.filter(x_account_id=account_id).count(),
        network_openings={k: len(v) for k, v in users.items()},
    )


def opening_of(text, words=OPENING_WORDS):
    """The first few normalized words of the first line, or '' for very short openings."""
    first = next((line for line in text.splitlines() if line.strip()), '')
    tokens = normalize_text(first).split()[:words]
    return ' '.join(tokens) if len(tokens) >= 2 else ''


def shape_of(text):
    """A coarse structure label: question, list, one-liner or statement."""
    stripped = text.strip()
    lines = [line for line in stripped.splitlines() if line.strip()]
    if sum(bool(re.match(r'\s*(\d+[.)]|[-•*])\s', line)) for line in lines) >= 3:
        return 'list'
    if stripped.endswith('?'):
        return 'question'
    if len(stripped.split()) <= 8:
        return 'one-liner'
    return 'statement'


# Language

def detect_language(text):
    """'TELUGU', 'TINGLISH', 'ENGLISH', or '' when the text is too short or mixed to tell."""
    telugu = len(TELUGU.findall(text))
    latin = len(LATIN.findall(text))
    if telugu + latin == 0:
        return ''
    if telugu >= 0.6 * (telugu + latin):
        return 'TELUGU'
    if telugu:
        return ''  # Telugu script mixed with English letters: leave it to the reviewer
    words = [w for w in normalize_text(text).split() if w.isascii()]
    if len(words) < 3:
        return ''
    hits = sum(w in TINGLISH_WORDS for w in words)
    if hits >= 2 or (hits == 1 and len(words) <= 6):
        return 'TINGLISH'
    return 'ENGLISH' if hits == 0 else ''


# Quality checks

def _flag(code, message):
    return {'code': code, 'message': message}


def _phrases(normalized, phrases):
    padded = f' {normalized} '
    return [p for p in phrases if f' {normalize_text(p)} ' in padded]


def quality_flags(fmt, text, *, language='', theme='', dna=None, history=None, is_ai=False):
    """Explainable warnings about generic, repetitive or off-identity writing. Never blocks saving."""
    history = history or History()
    normalized = normalize_text(text)
    flags = []

    if found := _phrases(normalized, CLICHES):
        quoted = ', '.join(f'“{p}”' for p in found[:3])
        flags.append(_flag('GENERIC_PHRASE', f'Sounds generic: {quoted}. Say something specific to this account instead.'))
    if found := _phrases(normalized, ENGAGEMENT_BAIT):
        flags.append(_flag('ENGAGEMENT_BAIT', f'Asks for engagement (“{found[0]}”). Let the post earn replies instead.'))
    if len(EMOJI.findall(text)) > MAX_EMOJI:
        flags.append(_flag('MANY_EMOJI', f'Uses more than {MAX_EMOJI} emoji.'))
    if dna and HASHTAG.search(text) and re.search(r'no\s+hashtags?', f'{dna.get("writing_style", "")} {dna.get("additional_instructions", "")}', re.I):
        flags.append(_flag('HASHTAG_AGAINST_DNA', 'Uses a hashtag, but this account’s Content DNA says no hashtags.'))

    detected = detect_language(text)
    flags += _language_flags(language, detected, dna)
    if detected == 'ENGLISH' and fmt != 'POLL':
        content = {w for w in normalized.split() if w not in _STOPWORDS and w not in VAGUE_WORDS and len(w) > 2}
        if len(normalized.split()) >= 6 and len(content) < 3:
            flags.append(_flag('LOW_SPECIFICITY', 'Very general, with few specific details. Add a concrete detail, example or angle.'))

    if is_ai and dna and theme and theme not in {*dna.get('primary_themes', []), *dna.get('secondary_themes', [])}:
        flags.append(_flag('THEME_NOT_IN_DNA', f'Theme “{theme}” is not one of this account’s themes.'))

    opening = opening_of(text)
    if opening:
        if any(opening_of(post) == opening for post in history.recent_posts):
            flags.append(_flag('REPEATED_OPENING', f'Starts the same way as a recent post on this account (“{opening}…”).'))
        elif history.network_openings.get(opening, 0) >= COMMON_OPENING_ACCOUNTS:
            accounts = history.network_openings[opening]
            flags.append(_flag('COMMON_OPENING', f'{accounts} other accounts recently opened with “{opening}…”. Vary it so accounts don’t sound alike.'))

    if fmt == 'TEXT':
        shape = shape_of(text)
        recent = [shape_of(p) for p in history.recent_text_posts[:STRUCTURE_WINDOW]]
        if shape != 'statement' and recent.count(shape) >= STRUCTURE_REPEATS:
            flags.append(_flag('REPETITIVE_STRUCTURE', f'{recent.count(shape)} of the last {len(recent)} text posts on this account were also {shape}s. Try another structure.'))
    return flags


def _language_flags(declared, detected, dna):
    if not detected:
        return []
    allowed = list((dna or {}).get('languages', []))
    label = LANGUAGE_LABELS[detected]
    if declared and declared != detected:
        hint = {
            'TINGLISH': 'Use Telugu in English letters, mixed with English, as people chat.',
            'TELUGU': 'Write it in Telugu script.',
            'ENGLISH': 'Write it in English.',
        }.get(declared, '')
        return [_flag('LANGUAGE_MISMATCH', f'Marked {LANGUAGE_LABELS.get(declared, declared)} but reads as {label}. {hint}'.strip())]
    if allowed and detected not in allowed:
        names = ', '.join(LANGUAGE_LABELS.get(code, code) for code in allowed)
        return [_flag('LANGUAGE_NOT_IN_DNA', f'Reads as {label}, which isn’t one of this account’s languages ({names}).')]
    return []


# Generation plan

# Angles a post can take, with tones that favour them. None invite invented personal stories.
ANGLES = (
    ('observation', 'a sharp, specific observation about a familiar situation', {'witty', 'observant', 'casual', 'friendly'}),
    ('opinion', 'a clear opinion with one concrete reason', {'bold', 'opinionated', 'analytical', 'confident', 'expert'}),
    ('question', 'a specific question the audience will want to answer', {'friendly', 'warm', 'curious', 'conversational'}),
    ('humour', 'a light, witty take (no mockery of people)', {'witty', 'funny', 'humorous', 'playful', 'sarcastic'}),
    ('relatable', 'a relatable everyday moment fans will recognise (no invented personal anecdote)', {'warm', 'nostalgic', 'friendly', 'casual'}),
    ('explainer', 'an evergreen explainer or comparison (no statistics or current events)', {'informative', 'educational', 'analytical', 'expert'}),
    ('one-liner', 'a punchy one-liner', {'witty', 'bold', 'punchy', 'sarcastic'}),
    ('reflection', 'a short 3-4 line reflection', {'reflective', 'thoughtful', 'calm', 'emotional', 'nostalgic'}),
    ('poetic', 'a short poetic line', {'poetic', 'emotional', 'reflective', 'romantic'}),
)


def option_plan(handle, dna, count, history=None):
    """A distinct (theme, language, angle) per option, rotated per account and per batch.

    Deterministic: the same account, DNA and history always give the same plan.
    """
    history = history or History()
    offset = zlib.crc32(handle.encode()) + history.batch_number
    tones = {t.strip().lower() for t in dna.get('tone', [])}
    # Angles matching the account's tone first, then the rest, each group rotated.
    preferred = [a for a in ANGLES if a[2] & tones]
    others = [a for a in ANGLES if not a[2] & tones]
    angles = _rotate(preferred, offset) + _rotate(others, offset)

    def least_used(themes):
        return sorted(themes, key=lambda t: (history.theme_counts.get(t, 0), themes.index(t)))

    primary = least_used(list(dna.get('primary_themes', [])))
    secondary = least_used(list(dna.get('secondary_themes', [])))
    languages = _rotate(list(dna.get('languages', [])) or ['ENGLISH'], offset)
    plan = []
    for i in range(count):
        if secondary and i % 3 == 2:
            theme = secondary[(i // 3) % len(secondary)]
        else:
            theme = primary[(i - i // 3) % len(primary)] if primary else ''
        plan.append((theme, languages[i % len(languages)], angles[i % len(angles)][1]))
    return plan


def _rotate(items, offset):
    if not items:
        return []
    k = offset % len(items)
    return items[k:] + items[:k]

