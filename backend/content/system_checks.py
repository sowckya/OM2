"""Django system checks (python manage.py check) for the content generation settings."""

from decimal import Decimal, InvalidOperation

from django.conf import settings
from django.core.checks import Error, Warning, register

from .providers.registry import PROVIDERS

THINKING_LEVELS = ('minimal', 'low', 'medium', 'high', 'default')


@register()
def check_ai_provider(app_configs, **kwargs):
    problems = []
    name = settings.CONTENT_AI_PROVIDER
    if name not in PROVIDERS:
        problems.append(Error(
            f'Unknown CONTENT_AI_PROVIDER "{name}".', hint=f'Use one of: {", ".join(sorted(PROVIDERS))}.', id='content.E001',
        ))
    if name == 'gemini' and not settings.GEMINI_API_KEY.strip():
        problems.append(Warning(
            'CONTENT_AI_PROVIDER is "gemini" but GEMINI_API_KEY is not set; generation will fail.',
            hint='Add GEMINI_API_KEY to backend/.env (see backend/.env.example).', id='content.W001',
        ))
    if settings.GEMINI_THINKING_LEVEL not in THINKING_LEVELS:
        problems.append(Error(
            f'GEMINI_THINKING_LEVEL "{settings.GEMINI_THINKING_LEVEL}" is not recognised.',
            hint=f'Use one of: {", ".join(THINKING_LEVELS)}.', id='content.E003',
        ))
    for setting in ('GEMINI_INPUT_USD_PER_MILLION', 'GEMINI_OUTPUT_USD_PER_MILLION'):
        try:
            valid = Decimal(getattr(settings, setting)) >= 0
        except InvalidOperation:
            valid = False
        if not valid:
            problems.append(Error(f'{setting} must be a non-negative number.', id='content.E002'))
    return problems
