from django.core.exceptions import NON_FIELD_ERRORS
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from .models import ContentDNA, XAccount

_MISSING = object()

DUPLICATE_HANDLE_MESSAGE = next(
    c.violation_error_message for c in XAccount._meta.constraints if c.name == 'x_account_handle_unique_ci'
)


class AssignedOmkarSerializer(serializers.Serializer):
    """Minimal public view of the Omkar who owns an X account."""

    id = serializers.IntegerField()
    username = serializers.CharField()
    display_name = serializers.SerializerMethodField()
    is_active = serializers.BooleanField()

    def get_display_name(self, user):
        return user.get_full_name() or user.username


class XAccountSerializer(serializers.ModelSerializer):
    # Plain fields so the model can normalize (strip @, lowercase, trim) before its
    # own validators run; max_length here only guards against oversized input.
    handle = serializers.CharField(max_length=100)
    display_name = serializers.CharField(max_length=200)
    assigned_omkar = AssignedOmkarSerializer(read_only=True)
    # Write-only: an Omkar id, or null to unassign. Applied by x_accounts.assignment
    # in the view (with row locks), not by ModelSerializer.save().
    assigned_omkar_id = serializers.IntegerField(write_only=True, required=False, allow_null=True)
    content_dna_configured = serializers.SerializerMethodField()

    class Meta:
        model = XAccount
        fields = (
            'id',
            'handle',
            'display_name',
            'status',
            'assigned_omkar',
            'assigned_omkar_id',
            'content_dna_configured',
            'created_at',
            'updated_at',
        )
        read_only_fields = ('id', 'created_at', 'updated_at')

    def get_content_dna_configured(self, account):
        return hasattr(account, 'content_dna')

    def validate(self, attrs):
        """Run the model's full_clean() and return the normalized values."""
        assignment = attrs.pop('assigned_omkar_id', _MISSING)
        attrs = self._validate_account(attrs)
        if assignment is not _MISSING:
            attrs['assigned_omkar_id'] = assignment
        return attrs

    def _validate_account(self, attrs):
        if self.instance is None:
            candidate = XAccount(**attrs)
        else:
            # Validate a copy so a rejected PATCH never mutates the loaded instance.
            candidate = XAccount(
                pk=self.instance.pk,
                **{f: attrs.get(f, getattr(self.instance, f)) for f in ('handle', 'display_name', 'status')},
            )
            candidate._state.adding = False
        try:
            candidate.full_clean(exclude=['created_at', 'updated_at'])
        except DjangoValidationError as exc:
            raise serializers.ValidationError(self._api_errors(exc))
        return {**attrs, **{f: getattr(candidate, f) for f in attrs}}

    @staticmethod
    def _api_errors(exc):
        errors = dict(exc.message_dict)
        # Model constraints report as non-field errors; attach the duplicate-handle
        # message to `handle` and never expose other internal constraint details.
        non_field = errors.pop(NON_FIELD_ERRORS, [])
        if DUPLICATE_HANDLE_MESSAGE in non_field:
            errors.setdefault('handle', []).append(DUPLICATE_HANDLE_MESSAGE)
        elif non_field:
            errors['non_field_errors'] = ['Invalid X account data.']
        return errors


def _text_list(required=True):
    # Lenient on input so the model's list rules produce one clear message per field;
    # the limits here only guard against oversized payloads.
    return serializers.ListField(
        child=serializers.CharField(allow_blank=True, trim_whitespace=False, max_length=5000),
        max_length=100,
        required=required,
    )


class ContentDNASerializer(serializers.ModelSerializer):
    LIST_FIELDS = tuple(ContentDNA.LIST_RULES)
    TEXT_FIELDS = ('target_audience', 'writing_style', 'additional_instructions')

    primary_themes = _text_list()
    secondary_themes = _text_list(required=False)
    languages = _text_list()
    tone = _text_list()
    allowed_formats = _text_list()
    topics_to_avoid = _text_list(required=False)
    example_posts = _text_list(required=False)
    target_audience = serializers.CharField(allow_blank=True, trim_whitespace=False, max_length=5000)
    writing_style = serializers.CharField(allow_blank=True, trim_whitespace=False, max_length=5000)
    additional_instructions = serializers.CharField(
        allow_blank=True, trim_whitespace=False, max_length=5000, required=False
    )
    # The 1–20 range is checked by the model, so it is reported alongside other field errors.
    daily_post_target = serializers.IntegerField(
        min_value=-32768, max_value=32767, error_messages={'invalid': 'Enter a whole number.'}
    )

    class Meta:
        model = ContentDNA
        fields = (
            'x_account',
            'primary_themes',
            'secondary_themes',
            'languages',
            'tone',
            'target_audience',
            'writing_style',
            'allowed_formats',
            'topics_to_avoid',
            'example_posts',
            'daily_post_target',
            'additional_instructions',
            'created_at',
            'updated_at',
        )
        read_only_fields = ('x_account', 'created_at', 'updated_at')

    def validate(self, attrs):
        """Run the model's full_clean() on the merged values and return them normalized."""
        editable = self.LIST_FIELDS + self.TEXT_FIELDS + ('daily_post_target',)
        if self.instance is None:
            candidate = ContentDNA(**attrs)
        else:
            # Validate a copy so a rejected PATCH never mutates the loaded instance.
            candidate = ContentDNA(
                pk=self.instance.pk,
                x_account_id=self.instance.x_account_id,
                **{f: attrs.get(f, getattr(self.instance, f)) for f in editable},
            )
            candidate._state.adding = False
        try:
            candidate.full_clean(exclude=['x_account', 'created_at', 'updated_at'])
        except DjangoValidationError as exc:
            errors = dict(exc.message_dict)
            if errors.pop(NON_FIELD_ERRORS, None):
                errors['non_field_errors'] = ['Invalid Content DNA data.']
            raise serializers.ValidationError(errors)
        return {f: getattr(candidate, f) for f in attrs}
