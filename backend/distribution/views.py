from django.db.models import Count, Prefetch, Q
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from users.permissions import IsMillionaire

from . import services
from .models import DistributionBatch, DistributionMessage, DistributionMessageItem


def _person(user):
    return {'id': user.pk, 'display_name': services.display_name(user)} if user else None


def message_data(message, of):
    """`of`: how many messages this Omkar has in the batch."""
    url = services.whatsapp_url(message.phone_number, message.text)
    return {
        'id': message.pk,
        'batch_id': message.batch_id,
        'omkar': {'id': message.omkar_id, 'display_name': services.display_name(message.omkar)},
        'phone_number': message.phone_number,
        'position': message.position,
        'of': of,
        'status': message.status,
        'text': message.text,
        # Only Pending and Opened messages can be opened in WhatsApp.
        'url': url if message.status in DistributionMessage.ACTIVE else None,
        'url_length': len(url),
        'warnings': message.warnings,
        'posts': [
            {
                'id': e.content_item_id,
                'handle': e.content_item.x_account.handle,
                'format': e.content_item.format,
                'short_link': e.short_link,
            }
            for e in message.entries.all()
        ],
        'open_count': message.open_count,
        'opened_at': message.opened_at,
        'opened_by': _person(message.opened_by),
        'sent_confirmed_at': message.sent_confirmed_at,
        'sent_confirmed_by': _person(message.sent_confirmed_by),
        'cancelled_at': message.cancelled_at,
    }


def _messages():
    entries = DistributionMessageItem.objects.select_related('content_item__x_account').order_by('order')
    return DistributionMessage.objects.select_related('omkar', 'opened_by', 'sent_confirmed_by').prefetch_related(
        Prefetch('entries', queryset=entries)
    )


def batch_data(batch):
    messages = list(_messages().filter(batch=batch))
    per_omkar = {}
    for m in messages:
        per_omkar[m.omkar_id] = per_omkar.get(m.omkar_id, 0) + 1
    return {
        'id': batch.pk,
        'created_at': batch.created_at,
        'created_by': _person(batch.created_by),
        'messages': [message_data(m, per_omkar[m.omkar_id]) for m in messages],
    }


class CandidatesView(APIView):
    """GET: approved posts grouped by assigned Omkar, with why any can't be sent."""

    permission_classes = [IsMillionaire]

    def get(self, request):
        return Response(services.candidates())


class PrepareSerializer(serializers.Serializer):
    item_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1), min_length=1, max_length=services.MAX_POSTS_PER_BATCH,
        error_messages={
            'min_length': 'Choose at least one post.',
            'max_length': f'Choose at most {services.MAX_POSTS_PER_BATCH} posts at a time.',
        },
    )
    include_sent = serializers.BooleanField(required=False, default=False)


class BatchPagination(PageNumberPagination):
    page_size = 20


class BatchListView(APIView):
    """GET: recent batches with message counts by status. POST {item_ids, include_sent}: prepare a batch."""

    permission_classes = [IsMillionaire]

    def get(self, request):
        counts = {
            f'{s.lower()}_count': Count('messages', filter=Q(messages__status=s)) for s in DistributionMessage.Status.values
        }
        batches = DistributionBatch.objects.select_related('created_by').annotate(**counts)
        paginator = BatchPagination()
        page = paginator.paginate_queryset(batches, request, view=self)
        return paginator.get_paginated_response([
            {
                'id': b.pk,
                'created_at': b.created_at,
                'created_by': _person(b.created_by),
                'counts': {s: getattr(b, f'{s.lower()}_count') for s in DistributionMessage.Status.values},
            }
            for b in page
        ])

    def post(self, request):
        serializer = PrepareSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            batch = services.prepare_batch(
                serializer.validated_data['item_ids'], request.user, serializer.validated_data['include_sent']
            )
        except services.DistributionError as exc:
            return Response({'detail': str(exc), **exc.data}, status=status.HTTP_409_CONFLICT)
        return Response(batch_data(batch), status=status.HTTP_201_CREATED)


class BatchDetailView(APIView):
    permission_classes = [IsMillionaire]

    def get(self, request, pk):
        return Response(batch_data(get_object_or_404(DistributionBatch.objects.select_related('created_by'), pk=pk)))


class MessageActionView(APIView):
    """POST open / confirm-sent / cancel for one message."""

    permission_classes = [IsMillionaire]
    actions = {'open': services.open_message, 'confirm-sent': services.confirm_sent, 'cancel': services.cancel_message}

    def post(self, request, pk, action):
        pk = int(pk)
        get_object_or_404(DistributionMessage, pk=pk)
        try:
            message = self.actions[action](pk, request.user)
        except services.DistributionError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_409_CONFLICT)
        message = _messages().get(pk=message.pk)
        of = DistributionMessage.objects.filter(batch_id=message.batch_id, omkar_id=message.omkar_id).count()
        return Response(message_data(message, of))
