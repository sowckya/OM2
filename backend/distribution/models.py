from django.conf import settings
from django.db import models

from content.models import ContentItem


class DistributionBatch(models.Model):
    """One "Prepare messages" action: approved posts grouped into WhatsApp messages per Omkar."""

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at', '-id']

    def __str__(self):
        return f'Distribution batch {self.pk}'


class DistributionMessage(models.Model):
    """One WhatsApp message to one Omkar. The text is fixed when the batch is prepared.

    OM2 never sends it: a Millionaire opens WhatsApp and presses Send. OPENED only means the
    WhatsApp link was opened from OM2; SENT means a Millionaire confirmed sending it by hand.
    Neither says anything about WhatsApp delivery or publication on X.
    """

    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        OPENED = 'OPENED', 'Opened'
        SENT = 'SENT', 'Manually confirmed sent'
        CANCELLED = 'CANCELLED', 'Cancelled'

    ACTIVE = (Status.PENDING, Status.OPENED)

    batch = models.ForeignKey(DistributionBatch, on_delete=models.CASCADE, related_name='messages')
    omkar = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name='distribution_messages')
    # 1-based position among this Omkar's messages in the batch.
    position = models.PositiveSmallIntegerField()
    # The number the message was prepared for; opening checks it still matches the Omkar's.
    phone_number = models.CharField(max_length=16)
    text = models.TextField()
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    warnings = models.JSONField(default=list, blank=True)
    open_count = models.PositiveIntegerField(default=0)
    opened_at = models.DateTimeField(null=True, blank=True)
    opened_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    sent_confirmed_at = models.DateTimeField(null=True, blank=True)
    sent_confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+'
    )
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancelled_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['batch', 'omkar__first_name', 'omkar__username', 'position']

    def __str__(self):
        return f'Message {self.position} for {self.omkar} ({self.status})'


class DistributionMessageItem(models.Model):
    """A post inside a message. `active` is true while the message is Pending or Opened, and a
    post can be active in only one message at a time (enforced by the database)."""

    message = models.ForeignKey(DistributionMessage, on_delete=models.CASCADE, related_name='entries')
    content_item = models.ForeignKey(ContentItem, on_delete=models.PROTECT, related_name='distribution_entries')
    # The post's version when prepared; opening refuses if the post changed since.
    item_version = models.PositiveIntegerField()
    order = models.PositiveSmallIntegerField()
    short_link = models.BooleanField(default=False)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ['message', 'order']
        constraints = [
            models.UniqueConstraint(fields=['message', 'content_item'], name='distribution_item_once_per_message'),
            models.UniqueConstraint(
                fields=['content_item'], condition=models.Q(active=True), name='distribution_item_one_active_message'
            ),
        ]

    def __str__(self):
        return f'Item {self.content_item_id} in message {self.message_id}'
