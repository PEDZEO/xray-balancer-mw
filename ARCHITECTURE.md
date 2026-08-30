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
- JSON is classified as `xray_json` or `fake_config`; structured Mihomo YAML is detected inside the non-JSON branch.

## Request Flow
1. Request enters middleware.
2. `request-guard` decides allow/deny/fallback.
3. If allowed, fetch upstream with profile-based timeout/redirects.
4. Classify upstream payload.
5. For Mihomo YAML, build native fastest/country groups and rewrite proxy references.
6. Apply node filtering: load stats and quarantine.
7. Apply manual/automatic node protection and fail closed when no healthy outbound remains.
8. Apply sticky fastest selection for the current token when enabled.
9. Add an observed emergency fallback outbound to normal Xray groups when enabled.
10. Build grouped response (or passthrough).
11. Update cache and runtime stats while preserving the response format content type.

## Node Protection
- States: `healthy`, `suspect`, `isolated`, `recovering`.
- Automatic isolation requires consecutive failures and preserves `protection_min_available_nodes`.
- Recovery requires both TTL expiry and consecutive successful observations.
- Isolation invalidates subscription cache and releases sticky assignments for that node.
- Manual and automatic state is persisted in runtime config as `attack_nodes`.

## Operational Endpoints
- Public: `/health`, `/ready`
- Admin: `/admin/node-stats`, `/admin/refresh-stats`, `/admin/refresh-groups`, `/admin/debug/stats`, `/admin/debug/token/{token}`, `/admin/quarantine`

Admin endpoints require `x-admin-token`.
