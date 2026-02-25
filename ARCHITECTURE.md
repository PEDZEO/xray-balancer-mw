# Architecture

## Protection Layers
1. Edge (Caddy)
- Routes client classes.
- Exposes health/ready/admin paths.

2. Middleware Guard Layer
- IP rate limit.
- Token rate limit.
- Circuit breaker.
- Cache fallback (fresh/stale).

3. Upstream Layer
- Subscription page / panel API.
- Classified as `xray_json`, `fake_config`, or `non_json`.

## Request Flow
1. Request enters middleware.
2. `request-guard` decides allow/deny/fallback.
3. If allowed, fetch upstream with profile-based timeout/redirects.
4. Classify upstream payload.
5. Build grouped response (or passthrough).
6. Update cache and runtime stats.

## Operational Endpoints
- Public: `/health`, `/ready`
- Admin: `/admin/node-stats`, `/admin/refresh-stats`, `/admin/refresh-groups`, `/admin/debug/stats`, `/admin/debug/token/{token}`, `/admin/quarantine`

Admin endpoints require `x-admin-token`.
