from rest_framework.routers import SimpleRouter

from .views import OmkarViewSet

router = SimpleRouter()
router.register('', OmkarViewSet, basename='omkar')

urlpatterns = router.urls
