"""Development benchmark: the same generation request sent to several models, side by side.

Read-only by design: it builds requests the way services.generate_for_account does (same
prompt, Content DNA and validation) but calls the provider directly and never saves drafts,
runs or revisions. Live calls only happen from the benchmark_ai command after confirmation.
"""

import time
from dataclasses import dataclass, field
from decimal import Decimal

from . import checks
from .models import ContentItem
from .prompts import SYSTEM_PROMPT, build_user_prompt
from .providers import GenerationRequest, ProviderError
from .providers.registry import PROVIDERS
from .quality import History, load_history
from .services import RECENT_POSTS_IN_PROMPT, _candidate_parts

# Fictional account used when no --account is given. Lives only in code, never in the database.
SAMPLE_HANDLE = 'benchmark_sample'
SAMPLE_DNA = {
    'primary_themes': ['Cricket', 'Telugu cinema'],
    'secondary_themes': ['Hyderabad food'],
    'languages': ['ENGLISH', 'TELUGU', 'TINGLISH'],
    'tone': ['Witty', 'Warm'],
    'target_audience': 'Young Telugu-speaking cricket and film fans.',
    'writing_style': 'Short, conversational lines. No hashtags.',
    'allowed_formats': ['TEXT', 'THREAD', 'POLL'],
    'topics_to_avoid': ['Politics', 'Betting'],
    'example_posts': [],
    'daily_post_target': 3,
    'additional_instructions': '',
}


@dataclass(frozen=True)
class Case:
    """One generation request, shared by every model in a benchmark."""

    handle: str
    dna: dict
    count: int
    format: str = ''
    instructions: str = ''
    recent_posts: tuple[str, ...] = ()
    x_account_id: int | None = None
    history: History | None = None

    def request(self):
        user_prompt = build_user_prompt(
            self.handle, self.dna, self.count, self.format, self.instructions, list(self.recent_posts), self.history,
        )
        return GenerationRequest(
            handle=self.handle, dna=self.dna, count=self.count, format=self.format, instructions=self.instructions,
            recent_posts=self.recent_posts, system_prompt=SYSTEM_PROMPT, user_prompt=user_prompt,
        )


def case_for_account(account, *, count, fmt='', instructions=''):
    """A case from a real account's Content DNA and recent posts (read only)."""
    from .services import dna_snapshot

    history = load_history(account.pk)
    recent = history.recent_posts[:RECENT_POSTS_IN_PROMPT]
    return Case(account.handle, dna_snapshot(account.content_dna), count, fmt, instructions, recent, account.pk, history)


def make_provider(provider_name, model=None, **options):
    cls = PROVIDERS[provider_name]
    if model and not cls.supports_model_choice:
        raise ValueError(f'The {provider_name} provider has no model choice.')
    return cls(model=model, **options) if model else cls(**options)


@dataclass
class Attempt:
    model: str
    ok: bool
    wall_ms: int
    error: str = ''
    google_ms: int | None = None
    prompt_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    cost_usd: Decimal = Decimal(0)
    returned: int = 0
    valid: int = 0
    distinct: int = 0
    similar_pairs: int = 0
    repeats_existing: int = 0
    texts: list[str] = field(default_factory=list)


def run_once(provider, case, model_label):
    """Calls the provider once and scores the reply with the production validation rules."""
    request = case.request()
    started = time.monotonic()
    try:
        result = provider.generate(request)
    except ProviderError as exc:
        return Attempt(model_label, False, _ms(started), error=str(exc))
    except Exception as exc:  # noqa: BLE001 - a benchmark reports every failure instead of stopping
        return Attempt(model_label, False, _ms(started), error=f'Unexpected {type(exc).__name__}')
    wall_ms = _ms(started)

    valid_texts = []
    for candidate in result.candidates:
        parts = _candidate_parts(candidate, case.format)
        if parts is not None:
            body, posts, options = parts
            valid_texts.append('\n'.join(p for p in [body, *posts, *options] if p))
    prints = [checks.fingerprint(t) for t in valid_texts]
    raw = result.raw or {}
    return Attempt(
        model=model_label,
        ok=True,
        wall_ms=wall_ms,
        google_ms=raw.get('server_ms'),
        prompt_tokens=result.input_tokens,
        output_tokens=result.output_tokens - raw.get('thinking_tokens', 0),
        thinking_tokens=raw.get('thinking_tokens', 0),
        cost_usd=provider.estimate_cost(result.input_tokens, result.output_tokens),
        returned=len(result.candidates),
        valid=len(valid_texts),
        distinct=len(set(prints)),
        similar_pairs=sum(
            checks.similarity(a, b) >= checks.SIMILARITY_THRESHOLD
            for i, a in enumerate(valid_texts) for b in valid_texts[i + 1:]
        ),
        repeats_existing=ContentItem.objects.filter(fingerprint__in=set(prints)).count() if prints else 0,
        texts=valid_texts,
    )


def summarize(attempts, requested):
    """Per-model averages, in the order models first appear."""
    rows = []
    for model in dict.fromkeys(a.model for a in attempts):
        mine = [a for a in attempts if a.model == model]
        ok = [a for a in mine if a.ok]

        def avg(values):
            values = [v for v in values if v is not None]
            return round(sum(values) / len(values)) if values else None

        rows.append({
            'model': model,
            'calls': len(mine),
            'errors': len(mine) - len(ok),
            'avg_wall_ms': avg(a.wall_ms for a in ok),
            'max_wall_ms': max((a.wall_ms for a in ok), default=None),
            'avg_google_ms': avg(a.google_ms for a in ok),
            'avg_prompt_tokens': avg(a.prompt_tokens for a in ok),
            'avg_output_tokens': avg(a.output_tokens for a in ok),
            'avg_thinking_tokens': avg(a.thinking_tokens for a in ok),
            'valid': sum(a.valid for a in ok),
            'requested': requested * len(mine),
            'distinct': sum(a.distinct for a in ok),
            'similar_pairs': sum(a.similar_pairs for a in ok),
            'repeats_existing': sum(a.repeats_existing for a in ok),
            'est_cost_usd': sum((a.cost_usd for a in ok), Decimal(0)),
        })
    return rows


def _ms(since):
    return int((time.monotonic() - since) * 1000)
