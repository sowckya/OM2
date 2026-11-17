from datetime import datetime, time

from django.db.models import Count, F, Func, Q, TextField, Value
from django.utils import timezone
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from users.permissions import IsMillionaire
from x_accounts.models import XAccount

from . import services
from .models import ContentItem, GenerationRun
from .providers import get_provider
from .whatsapp import short_urls_for, shorten_x_links
from .serializers import (
    BulkApproveSerializer,
    ContentItemDetailSerializer,
    ContentItemSerializer,
    ContentRevisionSerializer,
    ContentWriteSerializer,
    GenerateSerializer,
    GenerationRunDetailSerializer,
    GenerationRunSerializer,
    ReviewSerializer,
)


class ContentPagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = 'page_size'
    max_page_size = 100


def _conflict(exc):
    return Response({'detail': str(exc)}, status=status.HTTP_409_CONFLICT)


def _int_param(params, name):
    value = params.get(name, '').strip()
    if not value:
        return None
    if not value.isdigit():
        raise serializers.ValidationError({name: ['Must be an id.']})
    return int(value)


def _date_param(params, name, end=False):
    value = params.get(name, '').strip()
    if not value:
        return None
    try:
        day = datetime.strptime(value, '%Y-%m-%d').date()
    except ValueError:
        raise serializers.ValidationError({name: ['Use the format YYYY-MM-DD.']}) from None
    # Dates are calendar days in the display time zone (IST).
    return timezone.make_aware(datetime.combine(day, time.max if end else time.min))


def _choice_param(params, name, choices):
    value = params.get(name, '').strip().upper()
    if value and value not in choices:
        raise serializers.ValidationError({name: [f'Must be one of: {", ".join(choices)}.']})
    return value


class ProviderView(APIView):
    """The configured AI provider, so the UI can label mock output clearly."""

    permission_classes = [IsMillionaire]

    def get(self, request):
        provider = get_provider()
        return Response({'name': provider.name, 'model_name': provider.model_name, 'label': provider.label, 'is_mock': provider.is_mock})


class GenerateView(APIView):
    """POST {x_account_ids, count (1-5), format?, instructions?} -> one result per account."""

    permission_classes = [IsMillionaire]

    def post(self, request):
        serializer = GenerateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        results = services.generate_for_accounts(
            data['x_account_ids'], request.user, count=data['count'], fmt=data['format'], instructions=data['instructions'].strip()
        )
        body = [
            {
                'x_account': {'id': r['x_account'].pk, 'handle': r['x_account'].handle, 'display_name': r['x_account'].display_name},
                'run': GenerationRunSerializer(r['run']).data if r['run'] else None,
                'items': ContentItemSerializer(r['items'], many=True).data,
                'error': r['error'],
            }
            for r in results
        ]
        return Response({'results': body})


class GenerationRunViewSet(viewsets.ReadOnlyModelViewSet):
    """Generation history. Filters: x_account, status."""

    permission_classes = [IsMillionaire]
    pagination_class = ContentPagination

    def get_serializer_class(self):
        return GenerationRunDetailSerializer if self.action == 'retrieve' else GenerationRunSerializer

    def get_queryset(self):
        queryset = GenerationRun.objects.select_related('x_account', 'requested_by').annotate(item_count=Count('items'))
        params = self.request.query_params
        if (account := _int_param(params, 'x_account')) is not None:
            queryset = queryset.filter(x_account_id=account)
        if run_status := _choice_param(params, 'status', GenerationRun.Status.values):
            queryset = queryset.filter(status=run_status)
        return queryset.order_by('-created_at', '-id')


class ContentItemViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin, mixins.UpdateModelMixin, viewsets.GenericViewSet
):
    """Content Library. No DELETE: rejected posts stay in history.

    List filters: x_account, status, source, post_format, run, search, created_after,
    created_before (YYYY-MM-DD, IST), flagged (true: has warnings).
    Actions: POST approve {acknowledge_warnings}, reject {reason}, restore, bulk-approve
    {ids, acknowledge_warnings}; GET revisions.
    """

    permission_classes = [IsMillionaire]
    pagination_class = ContentPagination
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_serializer_class(self):
        return ContentItemDetailSerializer if self.action == 'retrieve' else ContentItemSerializer

    def get_queryset(self):
        queryset = ContentItem.objects.select_related(
            'x_account__assigned_omkar', 'generation_run', 'created_by', 'reviewed_by'
        )
        if self.action != 'list':
            return queryset
        params = self.request.query_params
        if (account := _int_param(params, 'x_account')) is not None:
            queryset = queryset.filter(x_account_id=account)
        if (run := _int_param(params, 'run')) is not None:
            queryset = queryset.filter(generation_run_id=run)
        if item_status := _choice_param(params, 'status', ContentItem.Status.values):
            queryset = queryset.filter(status=item_status)
        if source := _choice_param(params, 'source', ContentItem.Source.values):
            queryset = queryset.filter(source=source)
        # Not `format`: DRF reserves that query parameter for choosing the response format.
        if fmt := _choice_param(params, 'post_format', ['TEXT', 'THREAD', 'POLL']):
            queryset = queryset.filter(format=fmt)
        if after := _date_param(params, 'created_after'):
            queryset = queryset.filter(created_at__gte=after)
        if before := _date_param(params, 'created_before', end=True):
            queryset = queryset.filter(created_at__lte=before)
        flagged = params.get('flagged', '').strip().lower()
        if flagged in ('true', '1'):
            queryset = queryset.exclude(validation_flags=[], duplicate_flags=[])
        elif flagged:
            raise serializers.ValidationError({'flagged': ['Must be true.']})
        if search := params.get('search', '').strip():
            joined = lambda field: Func(F(field), Value(' '), function='array_to_string', output_field=TextField())
            queryset = queryset.annotate(_posts=joined('thread_posts'), _options=joined('poll_options')).filter(
                Q(body__icontains=search) | Q(theme__icontains=search) | Q(_posts__icontains=search)
                | Q(_options__icontains=search) | Q(x_account__handle__icontains=search.removeprefix('@'))
            )
        return queryset.order_by('-created_at', '-id')

    def _detail(self, item, code=status.HTTP_200_OK):
        item = self.get_queryset().get(pk=item.pk)
        # Approved posts get their short X link here (cached; skipped without a TinyURL token).
        shorten_x_links([item] if item.status == ContentItem.Status.APPROVED else [])
        return Response(ContentItemDetailSerializer(item).data, status=code)

    def retrieve(self, request, pk=None):
        return self._detail(self.get_object())

    def list(self, request, *args, **kwargs):
        # Lists only read cached short links, in one query; they never call TinyURL.
        page = self.paginate_queryset(self.filter_queryset(self.get_queryset()))
        approved = [i for i in page if i.status == ContentItem.Status.APPROVED]
        context = {**self.get_serializer_context(), 'short_urls': short_urls_for(approved)}
        return self.get_paginated_response(ContentItemSerializer(page, many=True, context=context).data)

    def create(self, request):
        serializer = ContentWriteSerializer(data=request.data, context={'creating': True})
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        data.pop('version', None)
        account = XAccount.objects.get(pk=data.pop('x_account_id'))
        item = services.create_manual(account, request.user, fmt=data.pop('format'), **data)
        return self._detail(item, status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        item = self.get_object()
        serializer = ContentWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        changes = dict(serializer.validated_data)
        expected = changes.pop('version', None)
        try:
            item = services.edit_item(item.pk, request.user, changes, expected_version=expected)
        except services.Conflict as exc:
            return _conflict(exc)
        return self._detail(item)

    def update(self, request, *args, **kwargs):
        if not kwargs.get('partial'):
            return Response({'detail': 'Use PATCH.'}, status=status.HTTP_405_METHOD_NOT_ALLOWED)
        return self.partial_update(request, kwargs.get('pk'))

    def _review(self, request, pk, run):
        item = self.get_object()
        serializer = ReviewSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            item = run(item.pk, request.user, serializer.validated_data)
        except services.Conflict as exc:
            return _conflict(exc)
        except services.WarningsNotAcknowledged as exc:
            return Response(exc.data, status=status.HTTP_400_BAD_REQUEST)
        return self._detail(item)

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        return self._review(request, pk, lambda i, u, d: services.approve_item(i, u, d['acknowledge_warnings']))

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        return self._review(request, pk, lambda i, u, d: services.reject_item(i, u, d['reason'].strip()))

    @action(detail=True, methods=['post'])
    def restore(self, request, pk=None):
        return self._review(request, pk, lambda i, u, d: services.restore_item(i, u))

    @action(detail=False, methods=['post'], url_path='bulk-approve')
    def bulk_approve(self, request):
        serializer = BulkApproveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ids = list(dict.fromkeys(serializer.validated_data['ids']))
        try:
            items = services.bulk_approve(ids, request.user, serializer.validated_data['acknowledge_warnings'])
        except services.WarningsNotAcknowledged as exc:
            return Response(exc.data, status=status.HTTP_400_BAD_REQUEST)
        shorten_x_links(ContentItem.objects.select_related('x_account__assigned_omkar').filter(pk__in=[i.pk for i in items]))
        return Response({'approved': [i.pk for i in items]})

    @action(detail=True, methods=['get'])
    def revisions(self, request, pk=None):
        item = self.get_object()
        revisions = item.revisions.select_related('changed_by').order_by('-version', '-id')
        return Response(ContentRevisionSerializer(revisions, many=True).data)
