from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """OM2 user. `role` is the OM2 product role; is_staff/is_superuser remain
    Django's separate admin-site flags."""

    class Role(models.TextChoices):
        MILLIONAIRE = 'MILLIONAIRE', 'Millionaire'
        OMKAR = 'OMKAR', 'Omkar'

    # Defaults to the least-privileged role.
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.OMKAR)
    # Omkar's WhatsApp number in international format (+ and digits only), used for
    # manual distribution links. Blank when not provided.
    phone_number = models.CharField(max_length=16, blank=True)
