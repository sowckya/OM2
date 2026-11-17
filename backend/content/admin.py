from django.contrib import admin

from .models import ContentItem, ContentRevision, GenerationRun


class ReadOnlyAdmin(admin.ModelAdmin):
    """Content is managed in the OM2 app, which validates it and records history."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(ContentItem)
class ContentItemAdmin(ReadOnlyAdmin):
    list_display = ('id', 'x_account', 'format', 'source', 'status', 'created_at')
    list_filter = ('status', 'source', 'format')
    search_fields = ('body', 'x_account__handle')
    list_select_related = ('x_account',)


@admin.register(GenerationRun)
class GenerationRunAdmin(ReadOnlyAdmin):
    list_display = ('id', 'x_account', 'provider', 'model_name', 'status', 'requested_count', 'created_at')
    list_filter = ('provider', 'status')
    list_select_related = ('x_account',)


@admin.register(ContentRevision)
class ContentRevisionAdmin(ReadOnlyAdmin):
    list_display = ('item', 'version', 'action', 'status', 'changed_by', 'created_at')
    list_filter = ('action',)
