from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator, RegexValidator
from django.db import models
from django.db.models.functions import Lower

HANDLE_MAX_LENGTH = 15
MAX_X_ACCOUNTS_PER_OMKAR = 2

# Only plain Omkar logins may own X accounts (never Millionaires or Django staff).
ASSIGNABLE_OMKAR = {'role': 'OMKAR', 'is_staff': False, 'is_superuser': False}

handle_validator = RegexValidator(
    regex=r'^[A-Za-z0-9_]{1,15}$',
    message='Enter a valid X handle: 1–15 letters, numbers or underscores, without @.',
)


class XAccount(models.Model):
    """An X account in the OM2 network, managed manually by Millionaires."""

    class Status(models.TextChoices):
        ACTIVE = 'ACTIVE', 'Active'
        PAUSED = 'PAUSED', 'Paused'

    # Stored lowercase without the leading @ (see normalize()).
    handle = models.CharField(max_length=HANDLE_MAX_LENGTH, validators=[handle_validator])
    display_name = models.CharField(max_length=100)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.ACTIVE)
    # The Omkar who operates this account. A foreign key, so at most one owner;
    # the two-accounts-per-Omkar limit is enforced in x_accounts.assignment.
    assigned_omkar = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='x_accounts',
        limit_choices_to=ASSIGNABLE_OMKAR,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'X account'
        ordering = ['handle']
        # Database-level guarantees, also enforced for writes that bypass save().
        constraints = [
            models.UniqueConstraint(
                Lower('handle'),
                name='x_account_handle_unique_ci',
                violation_error_message='An X account with this handle already exists.',
            ),
            models.CheckConstraint(
                condition=models.Q(handle__regex=r'^[a-z0-9_]{1,15}$'),
                name='x_account_handle_format',
            ),
            models.CheckConstraint(
                condition=models.Q(display_name__regex=r'\S'),
                name='x_account_display_name_not_blank',
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=['ACTIVE', 'PAUSED']),
                name='x_account_status_valid',
            ),
        ]

    def __str__(self):
        return f'@{self.handle}'

    def normalize(self):
        """Trim input, drop one leading @ and lowercase the handle."""
        handle = (self.handle or '').strip()
        if handle.startswith('@'):
            handle = handle[1:]
        self.handle = handle.lower()
        self.display_name = (self.display_name or '').strip()

    def clean(self):
        # Checked only when the owner changes, so editing an account whose Omkar was
        # later deactivated still works. Not race-safe on its own; API writes go
        # through x_accounts.assignment, which locks rows.
        super().clean()
        if self.assigned_omkar_id is None:
            return
        previous = None
        if not self._state.adding:
            previous = XAccount.objects.filter(pk=self.pk).values_list('assigned_omkar_id', flat=True).first()
        if previous != self.assigned_omkar_id:
            from .assignment import assignment_error

            error = assignment_error(self.assigned_omkar, exclude_account_pk=self.pk)
            if error:
                raise ValidationError({'assigned_omkar': error})

    def clean_fields(self, exclude=None):
        self.normalize()
        super().clean_fields(exclude=exclude)

    def save(self, *args, **kwargs):
        self.normalize()
        super().save(*args, **kwargs)


class ListRule:
    """Validation for a list-of-text Content DNA field, with friendly messages."""

    def __init__(self, label, *, min_items, max_items, max_length, choices=None):
        self.label = label
        self.min_items = min_items
        self.max_items = max_items
        self.max_length = max_length
        self.choices = choices  # TextChoices class, or None for free text

    def check(self, values):
        if not isinstance(values, list):
            return ['Must be a list.']
        errors = []
        if len(values) < self.min_items:
            errors.append(f'Add at least {self.min_items} {self.label}.' if self.min_items > 1 else f'Add at least one {self.label}.')
        if len(values) > self.max_items:
            errors.append(f'Use at most {self.max_items} {self.label}.')
        seen = set()
        for position, value in enumerate(values, start=1):
            if not isinstance(value, str) or not value:
                errors.append(f'Entry {position} is blank.')
                continue
            if self.choices is not None and value not in self.choices.values:
                options = ', '.join(self.choices.labels)
                errors.append(f'“{value}” is not a valid option. Choose from: {options}.')
            elif len(value) > self.max_length:
                errors.append(f'Entry {position} is longer than {self.max_length} characters.')
            key = value.casefold()
            if key in seen:
                errors.append(f'“{value}” is listed more than once.')
            seen.add(key)
        return errors


class ContentDNA(models.Model):
    """The editorial identity of one X account, used later to guide AI drafts."""

    class Language(models.TextChoices):
        ENGLISH = 'ENGLISH', 'English'
        TELUGU = 'TELUGU', 'Telugu'
        TINGLISH = 'TINGLISH', 'Tinglish'

    class Format(models.TextChoices):
        TEXT = 'TEXT', 'Text'
        THREAD = 'THREAD', 'Thread'
        POLL = 'POLL', 'Poll'

    DAILY_TARGET_MIN = 1
    DAILY_TARGET_MAX = 20

    LIST_RULES = {
        'primary_themes': ListRule('primary theme', min_items=1, max_items=5, max_length=60),
        'secondary_themes': ListRule('secondary themes', min_items=0, max_items=10, max_length=60),
        'languages': ListRule('language', min_items=1, max_items=3, max_length=10, choices=Language),
        'tone': ListRule('tone', min_items=1, max_items=6, max_length=40),
        'allowed_formats': ListRule('format', min_items=1, max_items=3, max_length=10, choices=Format),
        'topics_to_avoid': ListRule('topics to avoid', min_items=0, max_items=20, max_length=80),
        'example_posts': ListRule('example posts', min_items=0, max_items=10, max_length=1000),
    }

    x_account = models.OneToOneField(XAccount, on_delete=models.CASCADE, related_name='content_dna')
    primary_themes = ArrayField(models.CharField(max_length=60), size=5)
    secondary_themes = ArrayField(models.CharField(max_length=60), size=10, blank=True, default=list)
    languages = ArrayField(models.CharField(max_length=10, choices=Language.choices), size=3)
    tone = ArrayField(models.CharField(max_length=40), size=6)
    target_audience = models.CharField(max_length=500)
    writing_style = models.CharField(max_length=1000)
    allowed_formats = ArrayField(models.CharField(max_length=10, choices=Format.choices), size=3)
    topics_to_avoid = ArrayField(models.CharField(max_length=80), size=20, blank=True, default=list)
    example_posts = ArrayField(models.CharField(max_length=1000), size=10, blank=True, default=list)
    daily_post_target = models.PositiveSmallIntegerField(
        validators=[
            MinValueValidator(DAILY_TARGET_MIN, message=f'Set a target of at least {DAILY_TARGET_MIN} post per day.'),
            MaxValueValidator(DAILY_TARGET_MAX, message=f'Set a target of at most {DAILY_TARGET_MAX} posts per day.'),
        ]
    )
    additional_instructions = models.CharField(max_length=2000, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Content DNA'
        verbose_name_plural = 'Content DNA'
        # Database-level guards for writes that bypass validation.
        constraints = [
            models.CheckConstraint(
                condition=models.Q(daily_post_target__gte=1, daily_post_target__lte=20),
                name='content_dna_daily_target_range',
            ),
            models.CheckConstraint(
                condition=models.Q(primary_themes__len__gte=1, tone__len__gte=1),
                name='content_dna_themes_and_tone_present',
            ),
            models.CheckConstraint(
                condition=models.Q(languages__len__gte=1, languages__contained_by=['ENGLISH', 'TELUGU', 'TINGLISH']),
                name='content_dna_languages_valid',
            ),
            models.CheckConstraint(
                condition=models.Q(allowed_formats__len__gte=1, allowed_formats__contained_by=['TEXT', 'THREAD', 'POLL']),
                name='content_dna_formats_valid',
            ),
            models.CheckConstraint(
                condition=~models.Q(target_audience__regex=r'^\s*$') & ~models.Q(writing_style__regex=r'^\s*$'),
                name='content_dna_texts_not_blank',
            ),
        ]

    def __str__(self):
        return f'Content DNA for @{self.x_account.handle}' if self.x_account_id else 'Content DNA'

    def normalize(self):
        """Trim every text value and list entry; choice values are upper-cased."""
        for name, rule in self.LIST_RULES.items():
            values = getattr(self, name)
            if isinstance(values, list):
                cleaned = [v.strip() if isinstance(v, str) else v for v in values]
                if rule.choices is not None:
                    cleaned = [v.upper() if isinstance(v, str) else v for v in cleaned]
                setattr(self, name, cleaned)
        for name in ('target_audience', 'writing_style', 'additional_instructions'):
            value = getattr(self, name)
            if isinstance(value, str):
                setattr(self, name, value.strip())

    def clean_fields(self, exclude=None):
        self.normalize()
        exclude = set(exclude or ())
        errors = {}
        for name, rule in self.LIST_RULES.items():
            if name not in exclude:
                messages = rule.check(getattr(self, name))
                if messages:
                    errors[name] = messages
        # The list rules above replace Django's generic per-item array messages.
        try:
            super().clean_fields(exclude=exclude | set(self.LIST_RULES))
        except ValidationError as exc:
            errors = {**exc.message_dict, **errors}
        if errors:
            raise ValidationError(errors)

    def clean(self):
        super().clean()
        errors = {}
        primary = {t.casefold() for t in self.primary_themes or [] if isinstance(t, str)}
        overlap = [t for t in self.secondary_themes or [] if isinstance(t, str) and t.casefold() in primary]
        if overlap:
            errors['secondary_themes'] = [f'“{overlap[0]}” is already a primary theme.']
        themes = primary | {t.casefold() for t in self.secondary_themes or [] if isinstance(t, str)}
        clash = [t for t in self.topics_to_avoid or [] if isinstance(t, str) and t.casefold() in themes]
        if clash:
            errors['topics_to_avoid'] = [f'“{clash[0]}” is also one of this account’s themes.']
        if errors:
            raise ValidationError(errors)

    def save(self, *args, **kwargs):
        self.normalize()
        super().save(*args, **kwargs)
