from django.urls import path, re_path

from .views import BatchDetailView, BatchListView, CandidatesView, MessageActionView

urlpatterns = [
    path('candidates/', CandidatesView.as_view(), name='distribution-candidates'),
    path('batches/', BatchListView.as_view(), name='distribution-batches'),
    path('batches/<int:pk>/', BatchDetailView.as_view(), name='distribution-batch'),
    re_path(
        r'^messages/(?P<pk>\d+)/(?P<action>open|confirm-sent|cancel)/$',
        MessageActionView.as_view(),
        name='distribution-message-action',
    ),
]
