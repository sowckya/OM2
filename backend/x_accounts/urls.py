from rest_framework.routers import SimpleRouter

from .views import XAccountViewSet

router = SimpleRouter()
router.register('', XAccountViewSet, basename='x-account')

urlpatterns = router.urls
