from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from .base import ContentProvider
from .gemini import GeminiProvider
from .mock import MockProvider

# Provider name -> class. An unknown name is an error: OM2 never falls back to another provider.
PROVIDERS: dict[str, type[ContentProvider]] = {
    GeminiProvider.name: GeminiProvider,
    MockProvider.name: MockProvider,
}


def get_provider(name: str | None = None) -> ContentProvider:
    """The configured provider (settings.CONTENT_AI_PROVIDER), or the one named."""
    name = name or settings.CONTENT_AI_PROVIDER
    try:
        return PROVIDERS[name]()
    except KeyError:
        raise ImproperlyConfigured(
            f'Unknown CONTENT_AI_PROVIDER "{name}". Available: {", ".join(sorted(PROVIDERS))}.'
        ) from None
