"""A clearly labelled stand-in for a real model: fills templates from Content DNA.

It never calls a network service and costs nothing. Its text is sample content for
testing the workflow; every item it produces is flagged MOCK_CONTENT for review.
"""

import random

from .base import Candidate, ContentProvider, GenerationRequest, GenerationResult

_TEXT = {
    'ENGLISH': [
        'Unpopular opinion: {theme} gets better the less you overthink it. What’s your take?',
        'Three things {theme} taught me about patience: show up, stay curious, keep going.',
        'Quick question for {audience}: what got you into {theme} in the first place?',
        'Some days {theme} is the whole story. Other days it’s the quiet in between.',
        'If {theme} had a motto, it would be “one more try”. Agree?',
        'The best part of {theme}? Every day there’s something new to notice.',
        'Hot take: the small moments in {theme} matter more than the big headlines.',
        'Rate your week in {theme} from 1 to 10. Be honest.',
    ],
    'TINGLISH': [
        '{theme} gurinchi oka maata: simple ga untene baguntundi. Meeru em antaru?',
        'Ee roju {theme} mood lo unnara? Comment cheyandi.',
        '{theme} lo best moment eppudu? Naaku aithe prathi roju kotthaga untundi.',
        'Honest ga cheppandi: {theme} lekunda mee week ela untundi?',
    ],
    'TELUGU': [
        '{theme} గురించి ఒక్క మాట: చిన్న విషయాలే పెద్ద ఆనందం ఇస్తాయి.',
        'ఈ రోజు {theme} గురించి మీ ఆలోచన ఏంటి?',
        '{theme} లో మీకు ఇష్టమైన క్షణం ఏది? కామెంట్ చేయండి.',
    ],
}

_THREADS = [
    ['A short thread on {theme} 🧵', 'First: start small. Big changes in {theme} come from small habits.', 'Second: learn from people who do it differently from you.', 'Finally: enjoy it. {theme} is supposed to be fun.'],
    ['What I’d tell anyone new to {theme}:', 'You don’t need to know everything on day one.', 'Ask questions. The {theme} community is kinder than you think.', 'And keep notes. Future you will thank you.'],
    ['Why {theme} matters more than it looks 👇', 'It connects people who would never meet otherwise.', 'It gives everyday conversations a starting point.'],
]

_POLLS = [
    ('Which part of {theme} do you enjoy most?', ['The people', 'The stories', 'The surprises', 'The routine']),
    ('How often do you follow {theme}?', ['Every day', 'Every week', 'Now and then']),
    ('Best time of day for {theme} talk?', ['Morning', 'Evening']),
]


class MockProvider(ContentProvider):
    name = 'mock'
    model_name = 'mock-templates-v1'
    label = 'Mock provider (sample text, no AI)'
    is_mock = True

    def __init__(self, seed=None):
        self._random = random.Random(seed)

    def generate(self, request: GenerationRequest) -> GenerationResult:
        dna = request.dna
        primary = list(dna['primary_themes']) or ['this topic']
        secondary = list(dna.get('secondary_themes', []))
        offset = self._random.randrange(len(primary))
        formats = [request.format] if request.format else list(dna['allowed_formats']) or ['TEXT']
        languages = list(dna['languages']) or ['ENGLISH']
        audience = (dna.get('target_audience') or 'everyone').rstrip('.').split('.')[0]
        avoid = set(request.avoid) | set(request.recent_posts)

        # Shuffled template indexes per kind, so the options in one batch differ.
        decks = {}

        def take(key, size):
            deck = decks.setdefault(key, [])
            if not deck:
                deck.extend(self._random.sample(range(size), size))
            return deck.pop()

        candidates = []
        for i in range(request.count):
            fmt = formats[i % len(formats)]
            # Primary themes in turn; a secondary theme for every third option.
            if secondary and i % 3 == 2:
                theme = secondary[(i // 3) % len(secondary)]
            else:
                theme = primary[(i + offset) % len(primary)]
            values = {'theme': theme, 'audience': audience.lower()}
            if fmt == 'THREAD':
                posts = tuple(p.format(**values) for p in _THREADS[take('thread', len(_THREADS))])
                candidates.append(Candidate(format=fmt, thread_posts=posts, theme=theme, language='ENGLISH'))
            elif fmt == 'POLL':
                question, options = _POLLS[take('poll', len(_POLLS))]
                candidates.append(
                    Candidate(format=fmt, body=question.format(**values), poll_options=tuple(options), theme=theme, language='ENGLISH')
                )
            else:
                language = languages[i % len(languages)]
                templates = _TEXT.get(language, _TEXT['ENGLISH'])
                for _ in range(len(templates)):
                    body = templates[take(f'text-{language}', len(templates))].format(**values)
                    if body not in avoid:
                        break
                candidates.append(Candidate(format=fmt, body=body, theme=theme, language=language))

        output = sum(len(c.body) + sum(map(len, c.thread_posts)) for c in candidates)
        return GenerationResult(
            candidates=candidates,
            # Rough estimates (about four characters per token) so usage tracking can be tested.
            input_tokens=(len(request.system_prompt) + len(request.user_prompt)) // 4,
            output_tokens=output // 4,
        )
