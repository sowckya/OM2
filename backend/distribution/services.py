"""Distribution workspace: group approved posts into WhatsApp messages for their Omkars.

OM2 only prepares wa.me links. A Millionaire opens each one and presses Send in WhatsApp,
then confirms it by hand. Nothing here sends a message or marks a post as published.
"""

import time
from collections import defaultdict
from urllib.parse import quote

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone

from content.models import ContentItem
from content.shortlinks import shorten
from content.whatsapp import WHATSAPP_URL, x_link
from x_accounts.models import ContentDNA, XAccount

from .models import DistributionBatch, DistributionMessage, DistributionMessageItem

MAX_POSTS_PER_MESSAGE = 5
# Longer wa.me links are cut off or refused by some phones and browsers. Messages are split
# to stay under this; a single post that is longer on its own is flagged instead.
MAX_WHATSAPP_URL_LENGTH = 4000
MAX_POSTS_PER_BATCH = 200
# Upper bound on time spent calling TinyURL while preparing one batch.
SHORTEN_BUDGET_SECONDS = 15

LONG_MESSAGE = {
    'code': 'LONG_MESSAGE',
    'message': 'This message is very long, so WhatsApp may cut it off. Check it before sending, or copy the text instead.',
}


class DistributionError(Exception):
    """A request that can't be done in the current state (shown to the user, HTTP 409)."""

    def __init__(self, message, data=None):
        super().__init__(message)
        self.data = data or {}


def display_name(user):
    return user.get_full_name() or user.username


def omkar_reason(omkar):
    """Why nothing can be sent to this Omkar, or None."""
    if not omkar.is_active:
        return f'{display_name(omkar)} is inactive.'
    if not omkar.phone_number:
        return f'{display_name(omkar)} has no WhatsApp number saved.'
    return None


def whatsapp_url(phone_number, text):
    return WHATSAPP_URL.format(phone=phone_number.removeprefix('+'), text=quote(text, safe=''))


# Candidates


def _active_batches(item_ids):
    """{item id: batch id} for posts already in a Pending or Opened message."""
    rows = DistributionMessageItem.objects.filter(content_item_id__in=item_ids, active=True).values_list(
        'content_item_id', 'message__batch_id'
    )
    return dict(rows)


def _sent_at(item_ids):
    """{item id: last time a Millionaire confirmed sending it}."""
    rows = (
        DistributionMessageItem.objects.filter(content_item_id__in=item_ids, message__status=DistributionMessage.Status.SENT)
        .values('content_item_id')
        .annotate(last=Max('message__sent_confirmed_at'))
    )
    return {r['content_item_id']: r['last'] for r in rows}


def item_reason(item, active_batches, sent_at, include_sent=False):
    """Why this approved, assigned post can't go into a new batch, or None."""
    if item.x_account.status == XAccount.Status.PAUSED:
        return f'@{item.x_account.handle} is paused.'
    if item.pk in active_batches:
        return f'Already in batch {active_batches[item.pk]}.'
    if item.pk in sent_at and not include_sent:
        return 'Already sent.'
    return None


def approved_assigned_items():
    return (
        ContentItem.objects.filter(status=ContentItem.Status.APPROVED, x_account__assigned_omkar__isnull=False)
        .select_related('x_account__assigned_omkar')
        .order_by('x_account__handle', 'reviewed_at', 'id')
    )


def candidates():
    """Approved posts grouped by assigned Omkar, each with why it can't be sent (if so)."""
    items = list(approved_assigned_items())
    ids = [i.pk for i in items]
    active, sent = _active_batches(ids), _sent_at(ids)
    groups = {}
    for item in items:
        omkar = item.x_account.assigned_omkar
        group = groups.setdefault(omkar.pk, {'omkar': omkar, 'posts': []})
        group['posts'].append(item)
    accounts = defaultdict(list)
    for account in XAccount.objects.filter(assigned_omkar_id__in=groups).order_by('handle'):
        accounts[account.assigned_omkar_id].append(account)

    result = []
    for group in sorted(groups.values(), key=lambda g: display_name(g['omkar']).lower()):
        omkar = group['omkar']
        blocked = omkar_reason(omkar)
        result.append({
            'omkar': {'id': omkar.pk, 'display_name': display_name(omkar), 'phone_number': omkar.phone_number},
            'unavailable_reason': blocked,
            'accounts': [{'id': a.pk, 'handle': a.handle, 'status': a.status} for a in accounts[omkar.pk]],
            'posts': [
                {
                    'id': item.pk,
                    'x_account': {'id': item.x_account.pk, 'handle': item.x_account.handle},
                    'format': item.format,
                    'body': item.body,
                    'thread_posts': item.thread_posts,
                    'poll_options': item.poll_options,
                    'reviewed_at': item.reviewed_at,
                    'active_batch_id': active.get(item.pk),
                    'sent_at': sent.get(item.pk),
                    # Reasons that the "Include already sent" option can't lift.
                    'unavailable_reason': blocked or item_reason(item, active, sent, include_sent=True),
                }
                for item in group['posts']
            ],
        })
    unassigned = ContentItem.objects.filter(status=ContentItem.Status.APPROVED, x_account__assigned_omkar__isnull=True).count()
    return {'omkars': result, 'unassigned_count': unassigned}


# Messages


def _post_block(item, number, total, link):
    handle = f'@{item.x_account.handle}'
    lines = [f'Post {number} of {total} · {handle}' if total > 1 else f'From {handle}:']
    if item.format == ContentDNA.Format.THREAD:
        count = len(item.thread_posts)
        for i, post in enumerate(item.thread_posts, 1):
            lines += [f'{i}/{count}', post]
    else:
        lines.append(item.body)
        if item.format == ContentDNA.Format.POLL:
            lines += ['Poll options:', *(f'• {option}' for option in item.poll_options)]
    lines.append(f'Open in X: {link}')
    if item.format == ContentDNA.Format.THREAD:
        lines.append('This opens post 1. Reply to it with the other posts in order.')
    elif item.format == ContentDNA.Format.POLL:
        lines.append('Add the poll options in X before posting.')
    return '\n'.join(lines)


def message_text(omkar, items, links):
    """The WhatsApp message for `items` (all for `omkar`), each with its own X compose link."""
    total = len(items)
    intro = 'Please post this on X' if total == 1 else f'Please post these {total} posts on X'
    blocks = [_post_block(item, i, total, links[item.pk]) for i, item in enumerate(items, 1)]
    outro = 'Check that the right X account is active before you tap Post.'
    return '\n\n'.join([f'Hi {omkar.first_name or omkar.username},', f'{intro}:', *blocks, outro])


def split_into_messages(omkar, items, links):
    """Groups of at most MAX_POSTS_PER_MESSAGE posts whose wa.me link stays under the length limit."""
    groups, current = [], []
    for item in items:
        candidate = [*current, item]
        fits = len(whatsapp_url(omkar.phone_number, message_text(omkar, candidate, links))) <= MAX_WHATSAPP_URL_LENGTH
        if current and (len(candidate) > MAX_POSTS_PER_MESSAGE or not fits):
            groups.append(current)
            current = [item]
        else:
            current = candidate
    if current:
        groups.append(current)
    return groups


def compose_links(items):
    """{item id: (link, shortened)}. Shortens with TinyURL within a time budget; the full X
    compose link is used for anything not shortened."""
    deadline = time.monotonic() + SHORTEN_BUDGET_SECONDS
    links = {}
    for item in items:
        full = x_link(item)
        short = shorten(full) if time.monotonic() < deadline else None
        links[item.pk] = (short or full, short is not None)
    return links


def _check_item(item, active, sent, include_sent):
    if item.status != ContentItem.Status.APPROVED:
        return 'Only approved posts can be sent.'
    omkar = item.x_account.assigned_omkar
    if omkar is None:
        return f'@{item.x_account.handle} has no Omkar assigned.'
    return omkar_reason(omkar) or item_reason(item, active, sent, include_sent)


def prepare_batch(item_ids, user, include_sent=False):
    """Creates a batch of Pending messages for these posts. All posts must be sendable."""
    ids = list(dict.fromkeys(item_ids))
    preview = list(ContentItem.objects.filter(pk__in=ids).select_related('x_account__assigned_omkar'))
    if len(preview) != len(ids):
        raise DistributionError('Some posts no longer exist. Refresh and try again.')
    # TinyURL calls happen before any rows are locked.
    links = compose_links(preview)

    with transaction.atomic():
        items = list(
            ContentItem.objects.select_for_update(of=('self',))
            .filter(pk__in=ids)
            .select_related('x_account__assigned_omkar')
            .order_by('x_account__handle', 'reviewed_at', 'id')
        )
        active, sent = _active_batches(ids), _sent_at(ids)
        problems = [
            {'id': item.pk, 'reason': reason} for item in items if (reason := _check_item(item, active, sent, include_sent))
        ]
        if problems:
            raise DistributionError(
                'Some selected posts can’t be sent any more. Refresh and try again.', {'excluded': problems}
            )

        by_omkar = defaultdict(list)
        for item in items:
            by_omkar[item.x_account.assigned_omkar].append(item)
        batch = DistributionBatch.objects.create(created_by=user)
        text_links = {pk: link for pk, (link, _) in links.items()}
        try:
            for omkar, omkar_items in sorted(by_omkar.items(), key=lambda pair: display_name(pair[0]).lower()):
                for position, group in enumerate(split_into_messages(omkar, omkar_items, text_links), 1):
                    text = message_text(omkar, group, text_links)
                    too_long = len(whatsapp_url(omkar.phone_number, text)) > MAX_WHATSAPP_URL_LENGTH
                    message = DistributionMessage.objects.create(
                        batch=batch, omkar=omkar, position=position, phone_number=omkar.phone_number, text=text,
                        warnings=[LONG_MESSAGE] if too_long else [],
                    )
                    DistributionMessageItem.objects.bulk_create(
                        DistributionMessageItem(
                            message=message, content_item=item, item_version=item.version, order=order,
                            short_link=links[item.pk][1],
                        )
                        for order, item in enumerate(group, 1)
                    )
        except IntegrityError:
            # Another batch took one of these posts at the same moment.
            raise DistributionError('Some selected posts were just prepared in another batch. Refresh and try again.')
    return batch


# Message status


def _locked_message(message_id):
    return (
        DistributionMessage.objects.select_for_update(of=('self',))
        .select_related('omkar', 'batch')
        .get(pk=message_id)
    )


def stale_reason(message):
    """Why this prepared message no longer matches OM2's data, or None."""
    omkar = message.omkar
    if reason := omkar_reason(omkar):
        return reason
    if omkar.phone_number != message.phone_number:
        return f'{display_name(omkar)}’s WhatsApp number changed after this message was prepared.'
    for entry in message.entries.select_related('content_item__x_account'):
        item = entry.content_item
        account = item.x_account
        if item.status != ContentItem.Status.APPROVED or item.version != entry.item_version:
            return f'A post for @{account.handle} changed after this message was prepared.'
        if account.assigned_omkar_id != omkar.pk:
            return f'@{account.handle} is no longer assigned to {display_name(omkar)}.'
        if account.status == XAccount.Status.PAUSED:
            return f'@{account.handle} is paused.'
    return None


def open_message(message_id, user):
    """Records that a Millionaire opened this message in WhatsApp. Doesn't mean it was sent."""
    with transaction.atomic():
        message = _locked_message(message_id)
        if message.status == DistributionMessage.Status.SENT:
            raise DistributionError('This message was already confirmed as sent.')
        if message.status == DistributionMessage.Status.CANCELLED:
            raise DistributionError('This message was cancelled.')
        if reason := stale_reason(message):
            raise DistributionError(f'{reason} Cancel this message and prepare it again.')
        message.status = DistributionMessage.Status.OPENED
        message.open_count += 1
        message.opened_at = timezone.now()
        message.opened_by = user
        message.save(update_fields=['status', 'open_count', 'opened_at', 'opened_by'])
    return message


def confirm_sent(message_id, user):
    """A Millionaire's own confirmation that they sent this message in WhatsApp."""
    with transaction.atomic():
        message = _locked_message(message_id)
        if message.status == DistributionMessage.Status.SENT:
            raise DistributionError('This message was already confirmed as sent.')
        if message.status == DistributionMessage.Status.CANCELLED:
            raise DistributionError('This message was cancelled.')
        message.status = DistributionMessage.Status.SENT
        message.sent_confirmed_at = timezone.now()
        message.sent_confirmed_by = user
        message.save(update_fields=['status', 'sent_confirmed_at', 'sent_confirmed_by'])
        message.entries.update(active=False)
    return message


def cancel_message(message_id, user):
    """Cancels a Pending or Opened message so its posts can be prepared again."""
    with transaction.atomic():
        message = _locked_message(message_id)
        if message.status == DistributionMessage.Status.SENT:
            raise DistributionError('A message confirmed as sent can’t be cancelled.')
        if message.status == DistributionMessage.Status.CANCELLED:
            raise DistributionError('This message was already cancelled.')
        message.status = DistributionMessage.Status.CANCELLED
        message.cancelled_at = timezone.now()
        message.cancelled_by = user
        message.save(update_fields=['status', 'cancelled_at', 'cancelled_by'])
        message.entries.update(active=False)
    return message
