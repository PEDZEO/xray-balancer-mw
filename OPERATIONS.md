# Operations Runbook

## Readiness
- `GET /ready` returns `ready` when recent upstream success exists or cache has fresh data.
- If `not_ready`: check upstream connectivity, API token, and warmup tokens.

## Admin Endpoints
All endpoints below require `x-admin-token` header:
- `/admin/node-stats`
- `/admin/refresh-stats`
- `/admin/refresh-groups`
- `/admin/debug/stats`
- `/admin/debug/token/{token}`

## Token Rotation
1. Generate a new token.
2. Update `admin_token` in `config.json`.
3. Restart middleware container.
4. Verify `/admin/debug/stats` with new token.

## Common Incidents
### Frequent 502 or upstream timeouts
- Check `/admin/debug/stats` for circuit status.
- Increase `request_timeout_ms` in config.
- Ensure `profile_mode` is not too aggressive.

### Massive request bursts
- Tighten `rate_limit_per_minute` and `token_rate_limit_per_minute`.
- Check logs for `rate_limited` and `token_rate_limited` events.

### Wrong grouping or fallback to `Other`
- Adjust `groups` patterns.
- Use `/admin/debug/token/{token}` to inspect payload type and cache behavior.

## Safe Defaults
- `profile_mode: stable`
- `cache_ttl_sec: 600`
- `cache_stale_if_error_sec: 3600`
- `admin_token` set and rotated periodically
