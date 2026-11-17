"""Content workflows: generation, manual creation, edits and review transitions.

Every change goes through here so validation, duplicate checks and the revision
history stay consistent no matter which API (or future background job) calls it.
"""

import logging
import time

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers

from x_accounts.models import ContentDNA, XAccount

from . import checks, quality
from .models import ContentItem, ContentRevision, GenerationRun
from .prompts import SYSTEM_PROMPT, build_user_prompt
from .providers import Candidate, GenerationRequest, ProviderError, get_provider

logger = logging.getLogger(__name__)

MAX_OPTIONS = 5
MAX_ACCOUNTS_PER_REQUEST = 20
RECENT_POSTS_IN_PROMPT = 10
# Extra provider calls to replace options that exactly duplicate existing posts.
REPLACEMENT_ROUNDS = 2

NO_DNA = 'Content DNA is not configured for this account. Set it up before generating.'
PROVIDER_FAILED = 'The AI provider could not generate content. Please try again.'


class Conflict(Exception):
    """The item changed state in a way that makes the requested action invalid."""


class WarningsNotAcknowledged(Exception):
    """Approval needs explicit confirmation because of warnings. `data` is the 400 body."""

    def __init__(self, data):
        super().__init__(data['acknowledge_warnings'][0])
        self.data = data


def dna_snapshot(dna: ContentDNA) -> dict:
    fields = ['primary_themes', 'secondary_themes', 'languages', 'tone', 'target_audience', 'writing_style',
              'allowed_formats', 'topics_to_avoid', 'example_posts', 'daily_post_target', 'additional_instructions']
    snapshot = {f: getattr(dna, f) for f in fields}
    snapshot['updated_at'] = dna.updated_at.isoformat()
    return snapshot


def _record(item, action, user, note=''):
    ContentRevision.objects.create(
        item=item,
        version=item.version,
        action=action,
        status=item.status,
        format=item.format,
        body=item.body,
        thread_posts=item.thread_posts,
        poll_options=item.poll_options,
        note=note,
        changed_by=user,
    )


def _apply_checks(item):
    snapshot = item.dna_snapshot
    run = item.generation_run
    is_mock = bool(run and run.is_mock and not item.human_edited)
    text = item.full_text
    item.fingerprint = checks.fingerprint(text)
    history = quality.load_history(item.x_account_id, exclude_id=item.pk)
    item.validation_flags = checks.validation_flags(item.format, text, snapshot, is_mock=is_mock) + quality.quality_flags(
        item.format, text, language=item.language, theme=item.theme, dna=snapshot, history=history,
        is_ai=item.source == ContentItem.Source.AI,
    )
    item.duplicate_flags = checks.duplicate_flags(item.x_account_id, text, exclude_id=item.pk)


def _clean_or_raise(fmt, body, thread_posts, poll_options):
    body, posts, options = checks.clean_parts(fmt, body, thread_posts, poll_options)
    errors = checks.validation_errors(fmt, body, posts, options)
    if errors:
        raise serializers.ValidationError(errors)
    return body, posts, options


def _current_snapshot(account):
    dna = ContentDNA.objects.filter(x_account=account).first()
    return dna_snapshot(dna) if dna else None


# Generation

def generate_for_accounts(account_ids, user, *, count, fmt='', instructions='', provider=None):
    """Runs generation for each account in turn; one account failing doesn't stop others.

    Returns [{'x_account': XAccount, 'run': GenerationRun | None, 'items': [...], 'error': str | None}].
    """
    provider = provider or get_provider()
    accounts = {a.pk: a for a in XAccount.objects.filter(pk__in=account_ids).select_related('content_dna')}
    results = []
    for account_id in account_ids:
        account = accounts[account_id]
        dna = getattr(account, 'content_dna', None)
        if dna is None:
            results.append({'x_account': account, 'run': None, 'items': [], 'error': NO_DNA})
            continue
        run = generate_for_account(account, dna, user, count=count, fmt=fmt, instructions=instructions, provider=provider)
        results.append({
            'x_account': account,
            'run': run,
            'items': list(run.items.order_by('id')),
            'error': run.error or None if run.status == GenerationRun.Status.FAILED else None,
        })
    return results


def generate_for_account(account, dna, user, *, count, fmt, instructions, provider):
    snapshot = dna_snapshot(dna)
    history = quality.load_history(account.pk)
    recent = list(history.recent_posts[:RECENT_POSTS_IN_PROMPT])
    user_prompt = build_user_prompt(account.handle, snapshot, count, fmt, instructions, recent, history)
    run = GenerationRun(
        x_account=account,
        requested_by=user,
        provider=provider.name,
        model_name=provider.model_name,
        is_mock=provider.is_mock,
        requested_count=count,
        requested_format=fmt,
        instructions=instructions,
        dna_snapshot=snapshot,
        prompt=f'{SYSTEM_PROMPT}\n\n---\n\n{user_prompt}',
    )
    started = time.monotonic()
    request = GenerationRequest(
        handle=account.handle, dna=snapshot, count=count, format=fmt, instructions=instructions,
        recent_posts=tuple(recent), system_prompt=SYSTEM_PROMPT, user_prompt=user_prompt,
    )
    try:
        accepted, input_tokens, output_tokens, calls, provider_ms = _collect_candidates(provider, request, account, count)
    except ProviderError as exc:
        return _failed(run, str(exc)[:500] or PROVIDER_FAILED, started)
    except Exception:
        logger.exception('Content provider %s failed for @%s', provider.name, account.handle)
        return _failed(run, PROVIDER_FAILED, started)

    run.status = GenerationRun.Status.SUCCEEDED if accepted else GenerationRun.Status.FAILED
    if not accepted:
        run.error = 'The provider returned no usable options. Please try again.'
    run.input_tokens, run.output_tokens = input_tokens, output_tokens
    run.estimated_cost_usd = provider.estimate_cost(input_tokens, output_tokens)
    run.duration_ms = int((time.monotonic() - started) * 1000)
    saving = time.monotonic()
    with transaction.atomic():
        run.save()
        # Options are saved one by one, so each is also checked against the ones before it.
        for number, (candidate, parts) in enumerate(accepted, start=1):
            body, posts, options = parts
            item = ContentItem(
                x_account=account, generation_run=run, source=ContentItem.Source.AI, format=candidate.format,
                body=body, thread_posts=posts, poll_options=options, theme=candidate.theme[:60],
                language=candidate.language if candidate.language in ContentDNA.Language.values else '',
                dna_snapshot=snapshot, created_by=user, updated_by=user,
            )
            _apply_checks(item)
            item.save()
            _record(item, ContentRevision.Action.CREATED, user, note=f'Option {number} from {provider.name}')
    # Where the time went: the model (all calls) vs OM2's own checks and saving. No content is logged.
    logger.info(
        'Generation run %s for x_account %s: provider=%s status=%s options=%d/%d provider_calls=%d provider_ms=%d '
        'other_ms=%d save_ms=%d prompt_chars=%d input_tokens=%d output_tokens=%d',
        run.pk, account.pk, provider.name, run.status, len(accepted), count, calls, provider_ms,
        run.duration_ms - provider_ms, int((time.monotonic() - saving) * 1000), len(run.prompt), input_tokens, output_tokens,
    )
    return run


def _collect_candidates(provider, request, account, count):
    """Asks the provider for options, replacing invalid ones and exact duplicates.

    Returns (accepted, input_tokens, output_tokens, provider calls, ms spent in the provider).
    """
    accepted, prints, avoid = [], set(), list(request.avoid)
    input_tokens = output_tokens = calls = provider_ms = 0
    for round_number in range(1 + REPLACEMENT_ROUNDS):
        needed = count - len(accepted)
        if needed <= 0:
            break
        calling = time.monotonic()
        result = provider.generate(
            GenerationRequest(**{**request.__dict__, 'count': needed, 'avoid': tuple(avoid)})
        )
        calls += 1
        provider_ms += int((time.monotonic() - calling) * 1000)
        input_tokens += result.input_tokens
        output_tokens += result.output_tokens
        for candidate in result.candidates[:needed]:
            parts = _candidate_parts(candidate, request.format)
            if parts is None:
                continue
            text = '\n'.join(p for p in [parts[0], *parts[1], *parts[2]] if p)
            print_ = checks.fingerprint(text)
            existing = ContentItem.objects.filter(fingerprint=print_).exists()
            # The last round keeps exact duplicates (flagged) rather than returning fewer options.
            if print_ in prints or (existing and round_number < REPLACEMENT_ROUNDS):
                avoid.append(text)
                continue
            prints.add(print_)
            accepted.append((candidate, parts))
    return accepted, input_tokens, output_tokens, calls, provider_ms


def _candidate_parts(candidate: Candidate, requested_format):
    fmt = candidate.format if candidate.format in ContentDNA.Format.values else ''
    if not fmt or (requested_format and fmt != requested_format):
        return None
    body, posts, options = checks.clean_parts(fmt, candidate.body, candidate.thread_posts, candidate.poll_options)
    if checks.validation_errors(fmt, body, posts, options):
        return None
    return body, posts, options


def _failed(run, message, started):
    run.status = GenerationRun.Status.FAILED
    run.error = message
    run.duration_ms = int((time.monotonic() - started) * 1000)
    run.save()
    return run


# Manual content and edits

def create_manual(account, user, *, fmt, body='', thread_posts=(), poll_options=(), theme='', language=''):
    body, posts, options = _clean_or_raise(fmt, body, thread_posts, poll_options)
    item = ContentItem(
        x_account=account, source=ContentItem.Source.MANUAL, format=fmt, body=body, thread_posts=posts,
        poll_options=options, theme=theme, language=language, dna_snapshot=_current_snapshot(account),
        created_by=user, updated_by=user,
    )
    with transaction.atomic():
        _apply_checks(item)
        item.save()
        _record(item, ContentRevision.Action.CREATED, user, note='Written manually')
    return item


def _locked(item_id):
    return ContentItem.objects.select_for_update(of=('self',)).select_related('generation_run', 'x_account').get(pk=item_id)


def edit_item(item_id, user, changes, expected_version=None):
    with transaction.atomic():
        item = _locked(item_id)
        if expected_version is not None and expected_version != item.version:
            raise Conflict('This post was changed by someone else. Reload it to see the latest version.')
        if item.status == ContentItem.Status.REJECTED:
            raise Conflict('Rejected posts can’t be edited. Restore it to a draft first.')
        fmt = changes.get('format', item.format)
        body, posts, options = _clean_or_raise(
            fmt,
            changes.get('body', item.body),
            changes.get('thread_posts', item.thread_posts),
            changes.get('poll_options', item.poll_options),
        )
        new = {'format': fmt, 'body': body, 'thread_posts': posts, 'poll_options': options}
        for field in ('theme', 'language'):
            if field in changes:
                new[field] = changes[field]
        if all(getattr(item, k) == v for k, v in new.items()):
            return item
        was_approved = item.status == ContentItem.Status.APPROVED
        for key, value in new.items():
            setattr(item, key, value)
        item.version += 1
        item.updated_by = user
        item.human_edited = True
        note = ''
        if was_approved:
            item.status = ContentItem.Status.DRAFT
            item.reviewed_by, item.reviewed_at = None, None
            note = 'Edited after approval; needs approval again.'
        _apply_checks(item)
        item.save()
        _record(item, ContentRevision.Action.EDITED, user, note=note)
    return item


# Review

def warnings_for(item):
    return [*item.validation_flags, *({'code': 'DUPLICATE', 'message': f'{f["kind"].title()} match: {f["label"]}'} for f in item.duplicate_flags)]


def approve_item(item_id, user, acknowledge_warnings=False):
    with transaction.atomic():
        item = _locked(item_id)
        if item.status != ContentItem.Status.DRAFT:
            raise Conflict(f'Only drafts can be approved. This post is {item.get_status_display().lower()}.')
        # Re-run checks: other posts may have been added since this one was saved.
        _apply_checks(item)
        if warnings_for(item) and not acknowledge_warnings:
            item.save(update_fields=['fingerprint', 'validation_flags', 'duplicate_flags'])
            raise WarningsNotAcknowledged({
                'acknowledge_warnings': ['This post has warnings. Review them and confirm to approve anyway.'],
                'warnings': warnings_for(item),
            })
        _review(item, user, ContentItem.Status.APPROVED)
        _record(item, ContentRevision.Action.APPROVED, user, note='Approved with warnings' if warnings_for(item) else '')
    return item


def reject_item(item_id, user, reason=''):
    with transaction.atomic():
        item = _locked(item_id)
        if item.status == ContentItem.Status.REJECTED:
            raise Conflict('This post is already rejected.')
        item.rejection_reason = reason
        _review(item, user, ContentItem.Status.REJECTED)
        _record(item, ContentRevision.Action.REJECTED, user, note=reason)
    return item


def restore_item(item_id, user):
    with transaction.atomic():
        item = _locked(item_id)
        if item.status != ContentItem.Status.REJECTED:
            raise Conflict('Only rejected posts can be restored.')
        item.status = ContentItem.Status.DRAFT
        item.rejection_reason = ''
        item.reviewed_by, item.reviewed_at = None, None
        item.version += 1
        item.updated_by = user
        _apply_checks(item)
        item.save()
        _record(item, ContentRevision.Action.RESTORED, user)
    return item


def _review(item, user, status):
    item.status = status
    item.reviewed_by = user
    item.reviewed_at = timezone.now()
    item.version += 1
    item.updated_by = user
    item.save()


def bulk_approve(item_ids, user, acknowledge_warnings=False):
    """Approves drafts together. Without acknowledgement, nothing is approved if any has warnings."""
    with transaction.atomic():
        items = list(ContentItem.objects.select_for_update(of=('self',)).select_related('generation_run').filter(pk__in=item_ids).order_by('pk'))
        found = {i.pk for i in items}
        missing = [pk for pk in item_ids if pk not in found]
        if missing:
            raise serializers.ValidationError({'ids': [f'Posts not found: {", ".join(map(str, missing))}.']})
        not_draft = [i.pk for i in items if i.status != ContentItem.Status.DRAFT]
        if not_draft:
            raise serializers.ValidationError({'ids': [f'Only drafts can be approved. Not drafts: {", ".join(map(str, not_draft))}.']})
        for item in items:
            _apply_checks(item)
        flagged = [{'id': i.pk, 'warnings': warnings_for(i)} for i in items if warnings_for(i)]
        if flagged and not acknowledge_warnings:
            raise WarningsNotAcknowledged({
                'acknowledge_warnings': [f'{len(flagged)} of these posts have warnings. Review them and confirm to approve anyway.'],
                'flagged': flagged,
            })
        for item in items:
            _review(item, user, ContentItem.Status.APPROVED)
            _record(item, ContentRevision.Action.APPROVED, user, note='Bulk approved' + (' with warnings' if warnings_for(item) else ''))
    return items
