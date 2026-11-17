"""Assigning X accounts to Omkars.

Rules: an account has at most one Omkar (a foreign key); an Omkar has at most
MAX_X_ACCOUNTS_PER_OMKAR accounts; only active, non-staff Omkars can receive accounts.

assign_x_account() enforces the limit safely under concurrency by locking the account
row and then the target Omkar's row (always in that order) before counting, so
parallel assignments to the same Omkar are serialized.
"""

from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework import serializers

from .models import ASSIGNABLE_OMKAR, MAX_X_ACCOUNTS_PER_OMKAR, XAccount

OMKAR_NOT_FOUND = 'Omkar not found.'
NOT_ASSIGNABLE = 'Only Omkar accounts can be assigned X accounts.'
INACTIVE_OMKAR = 'This Omkar is inactive and cannot be assigned X accounts.'
LIMIT_REACHED = f'This Omkar already has {MAX_X_ACCOUNTS_PER_OMKAR} X accounts.'


def assignment_error(omkar, exclude_account_pk=None):
    """Return why `omkar` can't take one more X account, or None if they can."""
    if any(getattr(omkar, field) != value for field, value in ASSIGNABLE_OMKAR.items()):
        return NOT_ASSIGNABLE
    if not omkar.is_active:
        return INACTIVE_OMKAR
    owned = XAccount.objects.filter(assigned_omkar=omkar)
    if exclude_account_pk is not None:
        owned = owned.exclude(pk=exclude_account_pk)
    if owned.count() >= MAX_X_ACCOUNTS_PER_OMKAR:
        return LIMIT_REACHED
    return None


def assign_x_account(account_pk, omkar_pk):
    """Assign (omkar_pk) or unassign (None) an X account. Raises a DRF ValidationError
    keyed on `assigned_omkar_id` when the rules are violated."""
    with transaction.atomic():
        account = XAccount.objects.select_for_update().get(pk=account_pk)
        if omkar_pk is None:
            account.assigned_omkar = None
        elif account.assigned_omkar_id != omkar_pk:
            omkar = get_user_model().objects.select_for_update().filter(pk=omkar_pk).first()
            if omkar is None:
                raise serializers.ValidationError({'assigned_omkar_id': [OMKAR_NOT_FOUND]})
            error = assignment_error(omkar, exclude_account_pk=account.pk)
            if error:
                raise serializers.ValidationError({'assigned_omkar_id': [error]})
            account.assigned_omkar = omkar
        account.save(update_fields=['assigned_omkar', 'updated_at'])
        return account
