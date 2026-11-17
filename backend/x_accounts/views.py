from django.db import IntegrityError, transaction
from django.db.models import Q
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from users.permissions import IsMillionaire

from .assignment import assign_x_account
from .models import ContentDNA, XAccount
from .serializers import DUPLICATE_HANDLE_MESSAGE, ContentDNASerializer, XAccountSerializer


_MISSING = object()

CONTENT_DNA_MISSING = 'Content DNA is not configured for this X account.'
CONTENT_DNA_EXISTS = 'This X account already has Content DNA. Update it instead.'


class XAccountPagination(PageNumberPagination):
    # The network targets 100 accounts, so a client can fetch all of them in one page.
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 100


class XAccountViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Millionaire-only X account management. No DELETE; PATCH only for updates.

    List query parameters:
      search  — case-insensitive match on handle (a leading @ is ignored) or display name
      status  — ACTIVE or PAUSED
      assigned — true (has an Omkar) or false (unassigned)
      omkar   — an Omkar's user id: accounts assigned to them

      page, page_size (max 100)

    Writes accept `assigned_omkar_id` (an Omkar id, or null to unassign).

    /<id>/content-dna/ — GET the account's Content DNA (404 with configured=false when
    missing), POST to create it (409 if it exists), PATCH to update it.
    """

    serializer_class = XAccountSerializer
    permission_classes = [IsMillionaire]
    pagination_class = XAccountPagination
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        # handle is unique, so ordering by it is stable across pages.
        queryset = XAccount.objects.select_related('assigned_omkar', 'content_dna').order_by('handle', 'id')
        if self.action != 'list':
            return queryset

        params = self.request.query_params
        status = params.get('status', '').strip().upper()
        if status:
            if status not in XAccount.Status.values:
                raise serializers.ValidationError(
                    {'status': [f'Must be one of: {", ".join(XAccount.Status.values)}.']}
                )
            queryset = queryset.filter(status=status)

        assigned = params.get('assigned', '').strip().lower()
        if assigned in ('true', '1'):
            queryset = queryset.filter(assigned_omkar__isnull=False)
        elif assigned in ('false', '0'):
            queryset = queryset.filter(assigned_omkar__isnull=True)
        elif assigned:
            raise serializers.ValidationError({'assigned': ['Must be true or false.']})

        omkar = params.get('omkar', '').strip()
        if omkar:
            if not omkar.isdigit():
                raise serializers.ValidationError({'omkar': ['Must be an Omkar id.']})
            queryset = queryset.filter(assigned_omkar_id=int(omkar))

        search = params.get('search', '').strip()
        if search:
            handle_term = search.removeprefix('@').lower()
            queryset = queryset.filter(Q(handle__contains=handle_term) | Q(display_name__icontains=search))
        return queryset

    def perform_create(self, serializer):
        self._save_or_reject_duplicate(serializer)

    def perform_update(self, serializer):
        self._save_or_reject_duplicate(serializer)

    @staticmethod
    def _save_or_reject_duplicate(serializer):
        # Validation already checked uniqueness; this covers a concurrent duplicate insert.
        # Account changes and any assignment change commit together or not at all.
        assignment = serializer.validated_data.pop('assigned_omkar_id', _MISSING)
        try:
            with transaction.atomic():
                account = serializer.save()
                if assignment is not _MISSING:
                    assign_x_account(account.pk, assignment)
                    account.refresh_from_db()
        except IntegrityError:
            raise serializers.ValidationError({'handle': [DUPLICATE_HANDLE_MESSAGE]})

    @action(detail=True, methods=['get', 'post', 'patch'], url_path='content-dna')
    def content_dna(self, request, pk=None):
        account = self.get_object()
        if request.method == 'POST':
            return self._create_content_dna(account, request.data)

        dna = ContentDNA.objects.filter(x_account=account).first()
        if dna is None:
            return Response({'detail': CONTENT_DNA_MISSING, 'configured': False}, status=status.HTTP_404_NOT_FOUND)
        if request.method == 'GET':
            return Response(ContentDNASerializer(dna).data)

        serializer = ContentDNASerializer(dna, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @staticmethod
    def _create_content_dna(account, data):
        serializer = ContentDNASerializer(data=data)
        serializer.is_valid(raise_exception=True)
        conflict = Response({'detail': CONTENT_DNA_EXISTS, 'configured': True}, status=status.HTTP_409_CONFLICT)
        try:
            with transaction.atomic():
                # Lock the account so simultaneous creates for it run one at a time.
                XAccount.objects.select_for_update().get(pk=account.pk)
                if ContentDNA.objects.filter(x_account=account).exists():
                    return conflict
                serializer.save(x_account=account)
        except IntegrityError:
            # The one-to-one unique constraint is the final guard.
            return conflict
        return Response(serializer.data, status=status.HTTP_201_CREATED)
