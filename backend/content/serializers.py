from rest_framework import serializers

from x_accounts.models import ContentDNA, XAccount

from .models import ContentItem, ContentRevision, GenerationRun
from .services import MAX_ACCOUNTS_PER_REQUEST, MAX_OPTIONS, warnings_for
from .whatsapp import whatsapp_share


def _person(user):
    return {'id': user.pk, 'username': user.username, 'display_name': user.get_full_name() or user.username} if user else None


class AccountSummarySerializer(serializers.ModelSerializer):
    class Meta:
        model = XAccount
        fields = ('id', 'handle', 'display_name')


class GenerationRunSerializer(serializers.ModelSerializer):
    x_account = AccountSummarySerializer(read_only=True)
    requested_by = serializers.SerializerMethodField()
    item_count = serializers.SerializerMethodField()

    class Meta:
        model = GenerationRun
        fields = (
            'id', 'x_account', 'requested_by', 'provider', 'model_name', 'is_mock', 'requested_count',
            'requested_format', 'instructions', 'status', 'error', 'input_tokens', 'output_tokens',
            'estimated_cost_usd', 'duration_ms', 'item_count', 'created_at',
        )

    def get_requested_by(self, run):
        return _person(run.requested_by)

    def get_item_count(self, run):
        # Annotated in list views; counted directly for freshly created runs.
        return run.item_count if hasattr(run, 'item_count') else run.items.count()


class GenerationRunDetailSerializer(GenerationRunSerializer):
    class Meta(GenerationRunSerializer.Meta):
        fields = (*GenerationRunSerializer.Meta.fields, 'dna_snapshot', 'prompt')


class ContentItemSerializer(serializers.ModelSerializer):
    x_account = AccountSummarySerializer(read_only=True)
    generation = serializers.SerializerMethodField()
    created_by = serializers.SerializerMethodField()
    reviewed_by = serializers.SerializerMethodField()
    warnings = serializers.SerializerMethodField()
    whatsapp = serializers.SerializerMethodField()

    class Meta:
        model = ContentItem
        fields = (
            'id', 'x_account', 'source', 'status', 'format', 'body', 'thread_posts', 'poll_options', 'theme',
            'language', 'duplicate_flags', 'validation_flags', 'warnings', 'rejection_reason', 'generation',
            'created_by', 'reviewed_by', 'reviewed_at', 'version', 'created_at', 'updated_at', 'whatsapp',
        )

    def get_generation(self, item):
        run = item.generation_run
        if run is None:
            return None
        return {'id': run.id, 'provider': run.provider, 'model_name': run.model_name, 'is_mock': run.is_mock}

    def get_created_by(self, item):
        return _person(item.created_by)

    def get_reviewed_by(self, item):
        return _person(item.reviewed_by)

    def get_warnings(self, item):
        return warnings_for(item)

    def get_whatsapp(self, item):
        # Only approved posts can be distributed; null otherwise.
        if item.status != ContentItem.Status.APPROVED:
            return None
        return whatsapp_share(item, self.context.get('short_urls'))


class ContentItemDetailSerializer(ContentItemSerializer):
    class Meta(ContentItemSerializer.Meta):
        fields = (*ContentItemSerializer.Meta.fields, 'dna_snapshot')


class ContentRevisionSerializer(serializers.ModelSerializer):
    changed_by = serializers.SerializerMethodField()

    class Meta:
        model = ContentRevision
        fields = ('id', 'version', 'action', 'status', 'format', 'body', 'thread_posts', 'poll_options', 'note', 'changed_by', 'created_at')

    def get_changed_by(self, revision):
        return _person(revision.changed_by)


def _parts():
    child = serializers.CharField(allow_blank=True, trim_whitespace=False, max_length=2000)
    return serializers.ListField(child=child, max_length=20, required=False)


class ContentWriteSerializer(serializers.Serializer):
    """Manual creation (with x_account_id) and edits. The service layer validates content rules."""

    x_account_id = serializers.IntegerField(required=False)
    format = serializers.ChoiceField(choices=ContentDNA.Format.choices, required=False)
    body = serializers.CharField(allow_blank=True, trim_whitespace=False, max_length=2000, required=False)
    thread_posts = _parts()
    poll_options = _parts()
    theme = serializers.CharField(allow_blank=True, max_length=60, required=False)
    language = serializers.ChoiceField(choices=ContentDNA.Language.choices, allow_blank=True, required=False)
    version = serializers.IntegerField(required=False, min_value=1)

    def validate(self, attrs):
        unknown = set(self.initial_data) - set(self.fields)
        if unknown:
            raise serializers.ValidationError({name: ['This field cannot be set.'] for name in sorted(unknown)})
        if self.context.get('creating'):
            errors = {}
            if 'x_account_id' not in attrs:
                errors['x_account_id'] = ['Choose an X account.']
            elif not XAccount.objects.filter(pk=attrs['x_account_id']).exists():
                errors['x_account_id'] = ['X account not found.']
            if 'format' not in attrs:
                errors['format'] = ['Choose a format.']
            if errors:
                raise serializers.ValidationError(errors)
        elif 'x_account_id' in attrs:
            raise serializers.ValidationError({'x_account_id': ['A post’s account can’t be changed.']})
        return attrs


class GenerateSerializer(serializers.Serializer):
    x_account_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1), min_length=1, max_length=MAX_ACCOUNTS_PER_REQUEST,
        error_messages={'min_length': 'Choose at least one X account.', 'max_length': f'Choose at most {MAX_ACCOUNTS_PER_REQUEST} accounts at a time.'},
    )
    count = serializers.IntegerField(
        min_value=1, max_value=MAX_OPTIONS,
        error_messages={'min_value': 'Generate at least 1 option.', 'max_value': f'Generate at most {MAX_OPTIONS} options per account.'},
    )
    format = serializers.ChoiceField(choices=ContentDNA.Format.choices, allow_blank=True, required=False, default='')
    instructions = serializers.CharField(allow_blank=True, max_length=1000, required=False, default='')

    def validate_x_account_ids(self, ids):
        ids = list(dict.fromkeys(ids))
        missing = set(ids) - set(XAccount.objects.filter(pk__in=ids).values_list('pk', flat=True))
        if missing:
            raise serializers.ValidationError(f'X accounts not found: {", ".join(map(str, sorted(missing)))}.')
        return ids


class ReviewSerializer(serializers.Serializer):
    acknowledge_warnings = serializers.BooleanField(required=False, default=False)
    reason = serializers.CharField(allow_blank=True, max_length=500, required=False, default='')


class BulkApproveSerializer(serializers.Serializer):
    ids = serializers.ListField(child=serializers.IntegerField(min_value=1), min_length=1, max_length=100)
    acknowledge_warnings = serializers.BooleanField(required=False, default=False)
