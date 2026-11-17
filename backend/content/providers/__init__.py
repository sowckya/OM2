"""Pluggable AI providers for content generation.

Available: "gemini" (Google Gemini, real AI) and "mock" (sample text for testing).
To add another provider: subclass ContentProvider in a new module,
call the vendor API in generate(), map its reply to Candidates, then add it to
registry.PROVIDERS and set CONTENT_AI_PROVIDER. Keys come from environment variables.
"""

from .base import Candidate, ContentProvider, GenerationRequest, GenerationResult, ProviderError
from .registry import get_provider

__all__ = ['Candidate', 'ContentProvider', 'GenerationRequest', 'GenerationResult', 'ProviderError', 'get_provider']
