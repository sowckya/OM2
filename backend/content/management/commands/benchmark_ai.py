"""Compare AI models on the same generation request. Development tool; see content/benchmark.py.

    python manage.py benchmark_ai --list-models
    python manage.py benchmark_ai --models MODEL_A,MODEL_B            # dry run: shows the plan only
    python manage.py benchmark_ai --models MODEL_A,MODEL_B --run      # live calls after you type "yes"

Nothing is saved to the database. Live calls use the provider's API key and quota.
"""

import json
import sys
import time

from django.core.management.base import BaseCommand, CommandError

from content import benchmark
from content.providers import ProviderError
from content.providers.registry import PROVIDERS
from content.system_checks import THINKING_LEVELS
from x_accounts.models import ContentDNA, XAccount

MAX_MODELS = 3
MAX_REPEAT = 5


class Command(BaseCommand):
    help = 'Benchmark AI models on one Content DNA request without saving anything. Dry run unless --run is given.'

    def add_arguments(self, parser):
        parser.add_argument('--provider', default='gemini', choices=sorted(PROVIDERS))
        parser.add_argument('--list-models', action='store_true', help='List models the API key can use (no tokens used), then exit.')
        parser.add_argument('--all', action='store_true', help='With --list-models: include audio, image, TTS and other non-text models.')
        parser.add_argument('--models', default='', help=f'Comma-separated model names to compare (up to {MAX_MODELS}).')
        parser.add_argument('--account', default='', help='X handle whose Content DNA and recent posts to use (read only). Default: a built-in sample DNA.')
        parser.add_argument('--count', type=int, default=3, help='Options per call (1-5). Default 3.')
        parser.add_argument('--format', default='', choices=['', *ContentDNA.Format.values], help='Force one format. Default: any allowed.')
        parser.add_argument('--instructions', default='', help='Batch instructions, as in AI Content Studio.')
        parser.add_argument('--repeat', type=int, default=1, help=f'Calls per model (1-{MAX_REPEAT}). Default 1.')
        parser.add_argument('--pause', type=float, default=5.0, help='Seconds between live calls, to stay under rate limits. Default 5.')
        parser.add_argument('--thinking', default='', choices=['', *THINKING_LEVELS], help='Gemini thinking level. Default: GEMINI_THINKING_LEVEL.')
        parser.add_argument('--show-text', action='store_true', help='Print every valid option, to judge quality and language.')
        parser.add_argument('--json', dest='json_path', default='', help='Also write all results (including texts) to this file.')
        parser.add_argument('--run', action='store_true', help='Make the live API calls (asks for confirmation).')
        parser.add_argument('--yes', action='store_true', help='With --run: skip the confirmation prompt.')

    def handle(self, *args, **opts):
        name = opts['provider']
        if opts['list_models']:
            return self.list_models(name, show_all=opts['all'])

        models = [m.strip() for m in opts['models'].split(',') if m.strip()]
        if PROVIDERS[name].supports_model_choice and not models:
            raise CommandError('Name the models to compare with --models. Run with --list-models to see what your key can use.')
        if len(models) > MAX_MODELS or len(set(models)) != len(models):
            raise CommandError(f'Give up to {MAX_MODELS} different models.')
        if not 1 <= opts['count'] <= 5:
            raise CommandError('--count must be between 1 and 5.')
        if not 1 <= opts['repeat'] <= MAX_REPEAT:
            raise CommandError(f'--repeat must be between 1 and {MAX_REPEAT}.')
        if opts['pause'] < 0:
            raise CommandError('--pause cannot be negative.')
        case = self.build_case(opts)
        labels = models or [PROVIDERS[name].model_name or name]
        calls = len(labels) * opts['repeat']
        options = {'thinking_level': opts['thinking']} if opts['thinking'] and name == 'gemini' else {}

        request = case.request()
        self.stdout.write(f'Provider: {name}   Models: {", ".join(labels)}')
        self.stdout.write(
            f'Request: @{case.handle} · {case.count} option(s) · format {case.format or "any allowed"} · '
            f'prompt {len(request.system_prompt) + len(request.user_prompt)} characters · '
            f'{len(case.recent_posts)} recent post(s)' + (f' · thinking {opts["thinking"]}' if options else '')
        )
        self.stdout.write(f'Plan: {calls} call(s) ({opts["repeat"]} per model, models interleaved, {opts["pause"]:g}s apart).')
        if not opts['run']:
            self.stdout.write(self.style.WARNING('Dry run: no API calls made. Add --run to call the API.'))
            return

        providers = {label: benchmark.make_provider(name, model, **options) for label, model in zip(labels, models or [None])}
        if models:
            self.check_models_exist(next(iter(providers.values())), models)
        live = not PROVIDERS[name].is_mock
        if live and not opts['yes'] and not self.confirm(f'Make {calls} live {name} call(s)? They use your API key’s quota and may be billed. Type "yes": '):
            raise CommandError('Cancelled: no generation calls made. (Without a terminal, confirm with --yes.)')

        attempts = []
        for round_number in range(opts['repeat']):
            for label, provider in providers.items():
                if attempts:
                    time.sleep(opts['pause'])
                attempt = benchmark.run_once(provider, case, label)
                attempts.append(attempt)
                status = f'{attempt.valid}/{case.count} valid' if attempt.ok else f'ERROR: {attempt.error}'
                self.stdout.write(f'  [{round_number + 1}] {label}: {attempt.wall_ms / 1000:.2f}s · {status}')
        self.report(attempts, case, show_text=opts['show_text'])
        if opts['json_path']:
            self.write_json(opts['json_path'], attempts, case)

    def list_models(self, name, show_all):
        try:
            models = benchmark.make_provider(name).list_models()
        except NotImplementedError as exc:
            raise CommandError(str(exc)) from None
        except ProviderError as exc:
            raise CommandError(str(exc)) from None
        # Agents, research, computer-use, image and audio models aren't post writers.
        skip = ('tts', 'audio', 'image', 'live', 'embedding', 'robotics', 'transcribe', 'translate', 'veo', 'imagen', 'lyria',
                'banana', 'antigravity', 'deep-research', 'computer-use', 'customtools')
        shown = [m for m in models if show_all or not any(word in m['name'] for word in skip)]
        self.stdout.write(f'{len(shown)} of {len(models)} generateContent models' + ('' if show_all else ' (text models; --all for every model)') + ':')
        for model in shown:
            limit = model.get('output_token_limit') or '?'
            thinking = ' · thinking' if model.get('thinking') else ''
            self.stdout.write(f'  {model["name"]:<40} {model.get("display_name", "")} · max output {limit}{thinking}')
        self.stdout.write('Free-tier availability and limits are set per Google project; check them in Google AI Studio.')

    def build_case(self, opts):
        if not opts['account']:
            return benchmark.Case(benchmark.SAMPLE_HANDLE, benchmark.SAMPLE_DNA, opts['count'], opts['format'], opts['instructions'])
        handle = opts['account'].strip().lstrip('@').lower()
        account = XAccount.objects.select_related('content_dna').filter(handle=handle).first()
        if account is None:
            raise CommandError(f'No X account @{handle}.')
        if not hasattr(account, 'content_dna'):
            raise CommandError(f'@{handle} has no Content DNA.')
        return benchmark.case_for_account(account, count=opts['count'], fmt=opts['format'], instructions=opts['instructions'])

    def check_models_exist(self, provider, models):
        """Fails before any generation call when a model isn't available to this key."""
        try:
            available = {m['name'] for m in provider.list_models()}
        except NotImplementedError:
            return
        except ProviderError as exc:
            raise CommandError(str(exc)) from None
        missing = [m for m in models if m not in available]
        if missing:
            raise CommandError(f'Not available to this API key: {", ".join(missing)}. Run with --list-models.')

    def confirm(self, question):
        if not sys.stdin.isatty():
            return False
        return input(question).strip().lower() == 'yes'

    def report(self, attempts, case, show_text):
        rows = benchmark.summarize(attempts, case.count)
        header = f'{"model":<32} {"ok":>5} {"avg":>7} {"max":>7} {"google":>7} {"in tok":>7} {"out tok":>7} {"think":>6} {"valid":>7} {"distinct":>8} {"similar":>7} {"est $":>9}'
        self.stdout.write('\n' + header + '\n' + '-' * len(header))
        for r in rows:
            self.stdout.write(
                f'{r["model"]:<32} {r["calls"] - r["errors"]:>2}/{r["calls"]:<2} {secs(r["avg_wall_ms"]):>7} {secs(r["max_wall_ms"]):>7} '
                f'{secs(r["avg_google_ms"]):>7} {num(r["avg_prompt_tokens"]):>7} {num(r["avg_output_tokens"]):>7} '
                f'{num(r["avg_thinking_tokens"]):>6} {r["valid"]:>3}/{r["requested"]:<3} {r["distinct"]:>8} {r["similar_pairs"]:>7} '
                f'{r["est_cost_usd"]:>9.6f}'
            )
        self.stdout.write(
            'avg/max: wall-clock per call · google: Google\'s own processing time · tokens averaged per call · '
            'similar: near-duplicate pairs within a reply · est $: at the configured prices (free tier is not billed).'
        )
        for a in attempts:
            if not a.ok:
                self.stdout.write(self.style.ERROR(f'{a.model}: {a.error}'))
            elif a.repeats_existing:
                self.stdout.write(self.style.WARNING(f'{a.model}: {a.repeats_existing} option(s) repeat existing posts exactly.'))
        if show_text:
            for a in attempts:
                for i, text in enumerate(a.texts, start=1):
                    self.stdout.write(f'\n[{a.model} #{i}]\n{text}')

    def write_json(self, path, attempts, case):
        data = {
            'handle': case.handle, 'count': case.count, 'format': case.format, 'instructions': case.instructions,
            'summary': benchmark.summarize(attempts, case.count),
            'attempts': [a.__dict__ for a in attempts],
        }
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2, default=str)
        self.stdout.write(f'Results written to {path}')


def secs(ms):
    return '—' if ms is None else f'{ms / 1000:.2f}s'


def num(value):
    return '—' if value is None else str(value)
