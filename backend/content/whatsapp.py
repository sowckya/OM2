"""Manual WhatsApp distribution: a wa.me link that opens WhatsApp with the assigned
Omkar's number and a prefilled message. A Millionaire presses Send in WhatsApp; OM2
never sends anything itself and never records the post as sent or published."""

from urllib.parse import quote

from x_accounts.models import ContentDNA, XAccount

from .models import ContentItem
from .shortlinks import cached_short_urls, shorten

WHATSAPP_URL = 'https://wa.me/{phone}?text={text}'
X_INTENT_URL = 'https://x.com/intent/tweet?text={text}'


def x_intent_url(text):
    """X Web Intent that opens the composer with `text` prefilled."""
    return X_INTENT_URL.format(text=quote(text, safe=''))


def _post_text(item):
    """The text to prefill in X: the whole post, or the first post of a thread, or a poll's question."""
    if item.format == ContentDNA.Format.THREAD:
        return item.thread_posts[0] if item.thread_posts else ''
    return item.body


def x_link(item):
    """The full X compose link for this post (the TinyURL cache key)."""
    return x_intent_url(_post_text(item))


def whatsapp_message(item, omkar, link=None):
    """`link` replaces the full X compose link, e.g. with its TinyURL short link."""
    handle = f'@{item.x_account.handle}'
    lines = [f'Hi {omkar.first_name or omkar.username},', '', f'Please post this on X from {handle}:', '']
    if item.format == ContentDNA.Format.THREAD:
        total = len(item.thread_posts)
        for i, post in enumerate(item.thread_posts, 1):
            lines += [f'{i}/{total}', post, '']
    else:
        lines += [item.body, '']
        if item.format == ContentDNA.Format.POLL:
            lines += ['Poll options:', *(f'• {option}' for option in item.poll_options), '']
    lines += ['Open X with this post ready:', link or x_link(item), '']
    if item.format == ContentDNA.Format.THREAD:
        lines += ['This opens post 1. Reply to it with the other posts in order.', '']
    elif item.format == ContentDNA.Format.POLL:
        lines += ['Add the poll options in X before posting.', '']
    lines.append(f'Check that {handle} is the active account before you tap Post.')
    return '\n'.join(lines)


def unavailable_reason(item):
    """Why this post can't be sent to WhatsApp yet, or None when it can."""
    account = item.x_account
    omkar = account.assigned_omkar
    if item.status != ContentItem.Status.APPROVED:
        return 'Only approved posts can be sent.'
    if account.status == XAccount.Status.PAUSED:
        return f'@{account.handle} is paused.'
    if omkar is None:
        return f'@{account.handle} has no Omkar assigned.'
    if not omkar.is_active:
        return f'{omkar.get_full_name() or omkar.username} is inactive.'
    if not omkar.phone_number:
        return f'{omkar.get_full_name() or omkar.username} has no WhatsApp number saved.'
    return None


def whatsapp_share(item, short_urls=None):
    """What the Content Library needs to show the Send to WhatsApp action.

    Never includes a link unless every rule passes. Uses a cached short X link when there is
    one (`short_urls`: {full link: short link}, looked up when not given) and never calls
    TinyURL itself."""
    omkar = item.x_account.assigned_omkar
    reason = unavailable_reason(item)
    short = None
    if not reason:
        full = x_link(item)
        short = (cached_short_urls([full]) if short_urls is None else short_urls).get(full)
    return {
        'url': None if reason else WHATSAPP_URL.format(
            phone=omkar.phone_number.removeprefix('+'), text=quote(whatsapp_message(item, omkar, short), safe='')
        ),
        'recipient': {'id': omkar.pk, 'display_name': omkar.get_full_name() or omkar.username} if omkar else None,
        'unavailable_reason': reason,
        'x_link_shortened': short is not None,
    }


# Bounds how long one request can spend shortening (each call has its own timeout).
MAX_SHORTENED_PER_REQUEST = 25


def shorten_x_links(items):
    """Best effort: shorten and cache the X links of approved, sendable posts. Never raises."""
    for item in [i for i in items if not unavailable_reason(i)][:MAX_SHORTENED_PER_REQUEST]:
        shorten(x_link(item))


def short_urls_for(items):
    """Cached short links for the sendable posts among `items`, in one query."""
    return cached_short_urls({x_link(i) for i in items if not unavailable_reason(i)})
