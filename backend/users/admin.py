from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    fieldsets = BaseUserAdmin.fieldsets + (('OM2', {'fields': ('role', 'phone_number')}),)
    add_fieldsets = BaseUserAdmin.add_fieldsets + (('OM2', {'fields': ('role',)}),)
    list_display = ('username', 'email', 'role', 'is_staff', 'is_active')
    list_filter = ('role',) + BaseUserAdmin.list_filter
