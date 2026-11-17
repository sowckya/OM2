from rest_framework.permissions import BasePermission

from .models import User


class HasRole(BasePermission):
    """Allows access only to authenticated, active users with `required_role`."""

    required_role = None

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user and user.is_authenticated and user.is_active and user.role == self.required_role
        )


class IsMillionaire(HasRole):
    message = 'Millionaire role required.'
    required_role = User.Role.MILLIONAIRE


class IsOmkar(HasRole):
    message = 'Omkar role required.'
    required_role = User.Role.OMKAR
