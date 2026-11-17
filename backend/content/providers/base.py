from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal


class ProviderError(Exception):
    """A provider failed in a way that is safe to show to the Millionaire."""


@dataclass(frozen=True)
class GenerationRequest:
    handle: str
    dna: dict
    count: int
    # A format to use for every candidate, or '' to pick from the account's allowed formats.
    format: str
    instructions: str
    # Recent posts for this account, newest first, so options can avoid repeating them.
    recent_posts: tuple[str, ...]
    system_prompt: str
    user_prompt: str
    # Texts to steer away from when asking for replacements of duplicates.
    avoid: tuple[str, ...] = ()


@dataclass(frozen=True)
class Candidate:
    format: str
    body: str = ''
    thread_posts: tuple[str, ...] = ()
    poll_options: tuple[str, ...] = ()
    theme: str = ''
    language: str = ''


@dataclass(frozen=True)
class GenerationResult:
    candidates: list[Candidate]
    input_tokens: int = 0
    output_tokens: int = 0
    raw: dict = field(default_factory=dict)


class ContentProvider(ABC):
    name: str = ''
    model_name: str = ''
    #: True for providers that produce sample text without calling a real model.
    is_mock: bool = False
    #: Display name for the UI.
    label: str = ''
    #: USD per million tokens, used for cost estimates.
    input_price_per_million = Decimal('0')
    output_price_per_million = Decimal('0')

    #: True when the constructor accepts model=... (used by the benchmark command).
    supports_model_choice: bool = False

    def list_models(self) -> list[dict]:
        """Models this provider's credentials can use, as dicts with at least 'name'.

        Must not generate content or use token quota. Providers without a catalogue raise.
        """
        raise NotImplementedError(f'{self.name} cannot list models.')

    @abstractmethod
    def generate(self, request: GenerationRequest) -> GenerationResult:
        """Return up to request.count candidates. Raise ProviderError on failure."""

    def estimate_cost(self, input_tokens: int, output_tokens: int) -> Decimal:
        million = Decimal(1_000_000)
        return (
            Decimal(input_tokens) * self.input_price_per_million + Decimal(output_tokens) * self.output_price_per_million
        ) / million
