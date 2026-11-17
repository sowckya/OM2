from django.contrib import admin

from .models import DistributionBatch, DistributionMessage, DistributionMessageItem


class MessageItemInline(admin.TabularInline):
    model = DistributionMessageItem
    extra = 0
    readonly_fields = ('content_item', 'item_version', 'order', 'short_link', 'active')
    can_delete = False


@admin.register(DistributionMessage)
class DistributionMessageAdmin(admin.ModelAdmin):
    list_display = ('id', 'batch', 'omkar', 'position', 'status', 'opened_at', 'sent_confirmed_at')
    list_filter = ('status',)
    readonly_fields = ('batch', 'omkar', 'position', 'phone_number', 'text', 'warnings', 'open_count', 'opened_at',
                       'opened_by', 'sent_confirmed_at', 'sent_confirmed_by', 'cancelled_at', 'cancelled_by')
    inlines = [MessageItemInline]


admin.site.register(DistributionBatch)
