from django.contrib import admin

from .models import ContentDNA, XAccount


@admin.register(XAccount)
class XAccountAdmin(admin.ModelAdmin):
    list_display = ('handle', 'display_name', 'status', 'assigned_omkar', 'created_at', 'updated_at')
    list_filter = ('status',)
    search_fields = ('handle', 'display_name', 'assigned_omkar__username')
    readonly_fields = ('created_at', 'updated_at')
    list_select_related = ('assigned_omkar',)


@admin.register(ContentDNA)
class ContentDNAAdmin(admin.ModelAdmin):
    """Read-only here: the admin's comma-separated list widget would split example posts.

    Content DNA is edited in the OM2 Millionaire app, which validates every entry.
    """

    list_display = ('x_account', 'daily_post_target', 'updated_at')
    search_fields = ('x_account__handle',)
    list_select_related = ('x_account',)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
