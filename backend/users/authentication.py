from rest_framework import authentication


class SessionAuthentication(authentication.SessionAuthentication):
    """DRF session auth that answers unauthenticated requests with 401 instead of 403.

    DRF only returns 401 when the authenticator supplies a WWW-Authenticate value.
    CSRF enforcement for authenticated requests is inherited unchanged.
    """

    def authenticate_header(self, request):
        return 'Session'
