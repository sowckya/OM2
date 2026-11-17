from django.contrib.auth import authenticate, login, logout
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from django.db import IntegrityError, transaction
from django.db.models import Prefetch
from django.db.models.functions import Lower
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.filters import SearchFilter
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from x_accounts.models import XAccount

from .authentication import SessionAuthentication
from .permissions import IsMillionaire
from .serializers import (
    DUPLICATE_USERNAME_MESSAGE,
    CurrentUserSerializer,
    LoginSerializer,
    OmkarCreateSerializer,
    OmkarSerializer,
    OmkarUpdateSerializer,
    omkar_queryset,
)

INVALID_LOGIN_MESSAGE = 'Invalid username or password for this login type.'


@method_decorator(ensure_csrf_cookie, name='dispatch')
class CsrfView(APIView):
    """Sets the csrftoken cookie and returns the token for the X-CSRFToken header."""

    permission_classes = [AllowAny]

    def get(self, request):
        return Response({'csrfToken': get_token(request)})


class LoginView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'

    def post(self, request):
        # DRF only enforces CSRF for already-authenticated sessions, so enforce it
        # explicitly here to block login CSRF from anonymous requests.
        SessionAuthentication().enforce_csrf(request)

        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = authenticate(
            request,
            username=serializer.validated_data['username'],
            password=serializer.validated_data['password'],
        )
        # One response for unknown user, wrong password, inactive account and a role
        # that doesn't match the chosen login tab, so failures reveal nothing.
        # No session is created unless every check passes.
        if user is None or user.role != serializer.validated_data['expected_role']:
            return Response(
                {'detail': INVALID_LOGIN_MESSAGE}, status=status.HTTP_400_BAD_REQUEST
            )
        # login() rotates the session key and CSRF token (prevents session fixation).
        login(request, user)
        return Response(CurrentUserSerializer(user).data)


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        # logout() flushes the session data and deletes the server-side session.
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(CurrentUserSerializer(request.user).data)


class OmkarPagination(PageNumberPagination):
    # The network plans 50 Omkars, so one page can hold all of them.
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 100


class OmkarViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Millionaire-only management of Omkar logins. No DELETE; PATCH only for updates.

    List query parameters:
      search     — matches username, first/last name or email (space-separated terms all must match)
      is_active  — true or false
      page, page_size (max 100)
    """

    permission_classes = [IsMillionaire]
    pagination_class = OmkarPagination
    filter_backends = [SearchFilter]
    search_fields = ['username', 'first_name', 'last_name', 'email']
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        # Millionaires and Django staff/superusers are never part of this queryset,
        # so their IDs return 404 here.
        queryset = omkar_queryset().order_by(Lower('username'), 'id').prefetch_related(
            Prefetch('x_accounts', queryset=XAccount.objects.order_by('handle'))
        )
        if self.action == 'list':
            is_active = self.request.query_params.get('is_active', '').strip().lower()
            if is_active in ('true', '1'):
                queryset = queryset.filter(is_active=True)
            elif is_active in ('false', '0'):
                queryset = queryset.filter(is_active=False)
            elif is_active:
                raise serializers.ValidationError({'is_active': ['Must be true or false.']})
        return queryset

    def get_serializer_class(self):
        if self.action == 'create':
            return OmkarCreateSerializer
        if self.action in ('update', 'partial_update'):
            return OmkarUpdateSerializer
        return OmkarSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                omkar = serializer.save()
        except IntegrityError:
            # Covers a concurrent insert with the same username.
            raise serializers.ValidationError({'username': [DUPLICATE_USERNAME_MESSAGE]})
        return Response(OmkarSerializer(self.get_queryset().get(pk=omkar.pk)).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        omkar = self.get_object()
        serializer = self.get_serializer(omkar, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(OmkarSerializer(self.get_queryset().get(pk=omkar.pk)).data)
