import re

from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from .models import User


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField(trim_whitespace=False, write_only=True)
    # The login tab the user chose; the account's actual role must match it.
    expected_role = serializers.ChoiceField(choices=User.Role.choices)


class CurrentUserSerializer(serializers.ModelSerializer):
    """Read-only public view of the signed-in user. Never includes the password hash."""

    display_name = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ('id', 'username', 'display_name', 'role')
        read_only_fields = fields

    def get_display_name(self, user):
        return user.get_full_name() or user.username


DUPLICATE_USERNAME_MESSAGE = 'A user with this username already exists.'
DUPLICATE_EMAIL_MESSAGE = 'An Omkar with this email address already exists.'
PHONE_NUMBER_MESSAGE = 'Enter the number with its country code, e.g. +91 98765 43210.'


def normalize_phone_number(value):
    """'+91 98765-43210' -> '+919876543210'. Blank stays blank. Raises ValidationError
    unless the number has a country code and 8-15 digits (E.164)."""
    compact = re.sub(r'[\s().-]', '', value)
    if not compact:
        return ''
    if compact.startswith('00'):
        compact = '+' + compact[2:]
    if not re.fullmatch(r'\+[1-9]\d{7,14}', compact):
        raise serializers.ValidationError(PHONE_NUMBER_MESSAGE)
    return compact


def omkar_queryset():
    """Omkar accounts manageable by Millionaires. Django staff/superusers are never
    exposed here, even if their OM2 role is OMKAR."""
    return User.objects.filter(role=User.Role.OMKAR, is_staff=False, is_superuser=False)


class AssignedXAccountSerializer(serializers.Serializer):
    """X accounts owned by an Omkar, as shown on the Omkar."""

    id = serializers.IntegerField()
    handle = serializers.CharField()
    display_name = serializers.CharField()
    status = serializers.CharField()


class OmkarSerializer(serializers.ModelSerializer):
    """Read view of an Omkar. Never includes the password hash."""

    x_accounts = AssignedXAccountSerializer(many=True, read_only=True)

    class Meta:
        model = User
        fields = (
            'id', 'username', 'first_name', 'last_name', 'email', 'phone_number', 'is_active', 'date_joined', 'x_accounts',
        )
        read_only_fields = fields


class OmkarWriteMixin:
    """Shared validation for Omkar create/update serializers."""

    def to_internal_value(self, data):
        # Reject fields that can't be set here (e.g. role, is_staff, password on update)
        # instead of silently ignoring them.
        if hasattr(data, 'keys'):
            writable = {name for name, field in self.fields.items() if not field.read_only}
            blocked = sorted(set(data.keys()) - writable)
            if blocked:
                raise serializers.ValidationError({name: ['This field cannot be set.'] for name in blocked})
        return super().to_internal_value(data)

    def validate_email(self, value):
        email = User.objects.normalize_email(value.strip())
        others = omkar_queryset().filter(email__iexact=email)
        if self.instance is not None:
            others = others.exclude(pk=self.instance.pk)
        if others.exists():
            raise serializers.ValidationError(DUPLICATE_EMAIL_MESSAGE)
        return email

    def validate_phone_number(self, value):
        return normalize_phone_number(value)


class OmkarCreateSerializer(OmkarWriteMixin, serializers.ModelSerializer):
    # Username keeps the model's validators (allowed characters, 150 max) but replaces
    # the case-sensitive unique check with a case-insensitive one across all users.
    username = serializers.CharField(max_length=150, validators=[User.username_validator])
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150, required=False, allow_blank=True, default='')
    email = serializers.EmailField(max_length=254)
    phone_number = serializers.CharField(max_length=32, required=False, allow_blank=True, default='')
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)

    class Meta:
        model = User
        fields = ('username', 'first_name', 'last_name', 'email', 'phone_number', 'password')

    def validate_username(self, value):
        username = User.normalize_username(value)
        if User.objects.filter(username__iexact=username).exists():
            raise serializers.ValidationError(DUPLICATE_USERNAME_MESSAGE)
        return username

    def validate(self, attrs):
        # Run Django's configured password validators against the would-be user.
        candidate = User(**{k: v for k, v in attrs.items() if k != 'password'}, role=User.Role.OMKAR)
        try:
            password_validation.validate_password(attrs['password'], user=candidate)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({'password': list(exc.messages)})
        return attrs

    def create(self, validated_data):
        # Role and admin flags are always set by the server; create_user hashes the password.
        return User.objects.create_user(
            **validated_data,
            role=User.Role.OMKAR,
            is_staff=False,
            is_superuser=False,
            is_active=True,
        )


class OmkarUpdateSerializer(OmkarWriteMixin, serializers.ModelSerializer):
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150, allow_blank=True)
    email = serializers.EmailField(max_length=254)
    phone_number = serializers.CharField(max_length=32, allow_blank=True)

    class Meta:
        model = User
        fields = ('first_name', 'last_name', 'email', 'phone_number', 'is_active')
