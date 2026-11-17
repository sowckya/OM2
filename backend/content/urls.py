from django.urls import path
from rest_framework.routers import SimpleRouter

from .views import ContentItemViewSet, GenerateView, GenerationRunViewSet, ProviderView

router = SimpleRouter()
router.register('items', ContentItemViewSet, basename='content-item')
router.register('runs', GenerationRunViewSet, basename='generation-run')

urlpatterns = [
    path('provider/', ProviderView.as_view(), name='content-provider'),
    path('generate/', GenerateView.as_view(), name='content-generate'),
    *router.urls,
]
