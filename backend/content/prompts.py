"""Builds the provider-neutral prompt from Content DNA and history. Stored with every run for audit."""

from x_accounts.models import ContentDNA

from .quality import History, option_plan

SYSTEM_PROMPT = """You write original posts for one X (Twitter) account in the OM2 network. A human editor reviews every draft.
Write like a real person with this account's voice, not like an AI assistant.

Identity
- Follow the Content DNA: themes, tone, audience, writing style, languages, formats and topics to avoid. This account must sound like itself, not like other accounts.
- Follow the plan: one option per line, each with its own theme, language and angle.

Writing
- Be specific: a concrete detail, situation, comparison or opinion beats a general statement.
- Every option needs a different opening and structure.
- Avoid generic motivation and stock phrases ("Unpopular opinion", "Hot take", "Let's talk about", "game changer", "at the end of the day", "journey"), engagement bait ("Like if you agree", "Tag a friend", "Comment below"), hashtags unless the account wants them, and emoji spam.
- Never copy or closely paraphrase the recent posts or style examples.

Honesty
- Never invent personal experiences ("Yesterday I..."), statistics, quotes, scores, dates, news or engagement.
- You have no live news. State current events or specific facts only when the request instructions give them; otherwise use opinions, questions and evergreen observations.
- No misleading, hateful or harassing content.

Formats
- TEXT: "body" at most 280 characters; leave "thread_posts" and "poll_options" empty.
- THREAD: 2-10 "thread_posts" (each at most 280 characters) developing one idea; leave "body" empty.
- POLL: "body" is the question (at most 280 characters); 2-4 distinct "poll_options" of at most 25 characters.
- "theme" and "language" say which theme and language the option uses.

Reply with JSON only: {"candidates": [{"format": "TEXT|THREAD|POLL", "language": "ENGLISH|TELUGU|TINGLISH", "theme": "", "body": "", "thread_posts": [], "poll_options": []}]}"""

# Sent only for the account's own languages, to keep prompts short.
LANGUAGE_NOTES = {
    'ENGLISH': 'English: plain, conversational and specific; no corporate or textbook phrasing.',
    'TELUGU': (
        'Telugu: natural spoken Telugu in Telugu script, the way people actually post, not formal or translated from English. '
        'Everyday English words people use (match, OTT, phone) can stay in English.'
    ),
    'TINGLISH': (
        'Tinglish: Telugu in English letters mixed with English, like real chats ("Ee weekend plans enti?", '
        '"Last over lo tension aagadu asalu"). Keep Telugu grammar and word order; never translate an English sentence word by word.'
    ),
}
# Recent posts are sent as short excerpts: enough to avoid repeating ideas, without the full text's tokens.
RECENT_IN_PROMPT = 10
EXCERPT_CHARS = 110
# Openings several other accounts used recently. (The account's own are visible in its recent posts.)
NETWORK_OPENINGS = 5


def _list(values):
    return ', '.join(values) if values else 'none'


def _excerpt(text):
    text = ' '.join(text.split())
    return text if len(text) <= EXCERPT_CHARS else text[: EXCERPT_CHARS - 1] + '…'


def build_user_prompt(handle, dna, count, fmt, instructions, recent_posts, history=None):
    history = history or History(recent_posts=tuple(recent_posts))
    labels = dict(ContentDNA.Language.choices)
    formats = [fmt] if fmt else dna['allowed_formats']
    lines = [
        f'Account: @{handle}',
        f'Primary themes: {_list(dna["primary_themes"])}',
        f'Secondary themes (occasional): {_list(dna.get("secondary_themes", []))}',
        f'Languages: {_list([labels.get(code, code) for code in dna["languages"]])}',
        f'Tone: {_list(dna["tone"])}',
        f'Target audience: {dna["target_audience"]}',
        f'Writing style: {dna["writing_style"]}',
        f'Formats to use: {_list(formats)}',
        f'Topics to avoid: {_list(dna.get("topics_to_avoid", []))}',
    ]
    if dna.get('additional_instructions'):
        lines.append(f'Account instructions: {dna["additional_instructions"]}')
    if dna.get('example_posts'):
        lines.append('Style examples (match the voice, do not copy):')
        lines += [f'- {p}' for p in dna['example_posts']]
    lines.append('Language notes:')
    lines += [f'- {LANGUAGE_NOTES[code]}' for code in dna['languages'] if code in LANGUAGE_NOTES]

    if recent_posts:
        lines.append('Recent posts on this account (do not repeat their ideas, angles or openings):')
        lines += [f'- {_excerpt(p)}' for p in list(recent_posts)[:RECENT_IN_PROMPT]]
    network = sorted((o for o, n in history.network_openings.items() if n >= 2),
                     key=lambda o: (-history.network_openings[o], o))[:NETWORK_OPENINGS]
    if network:
        lines.append('Openings other accounts used recently (do not start with these): ' + ', '.join(f'"{o}"' for o in network))

    if instructions:
        lines.append(f'Instructions for this request: {instructions}')
    lines.append('Plan (one option per line, all genuinely different):')
    for number, (theme, language, angle) in enumerate(option_plan(handle, dna, count, history), start=1):
        lines.append(f'{number}. {theme or "any theme"} · {labels.get(language, language)} · {angle}')
    lines.append(f'Write {count} option{"s" if count != 1 else ""}.')
    return '\n'.join(lines)
