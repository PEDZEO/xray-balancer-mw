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
- `/admin/quarantine` (`GET` list, `POST` add `{ "node": "name" }`)
- `/admin/quarantine/{node}` (`DELETE` remove)

Admin endpoints are also rate-limited (`admin_rate_limit_per_minute`, `admin_rate_limit_burst_10s`).

## Runtime Persistence
- Keep base `config.json` mounted read-only.
- Persist admin UI changes (`groups`, `fastest_*`, `quarantine_nodes`) into `CONFIG_RUNTIME_PATH`.
- Recommended compose mount:
  - `CONFIG_RUNTIME_PATH=/app/runtime/config.runtime.json`
  - `./runtime:/app/runtime`

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

### Users are flapping between nodes in fastest-group
- Enable `sticky_enabled: true`.
- Start with `sticky_ttl_sec: 1800` or `3600`.
- Check `/admin/debug/token/{token}` to see `sticky.assigned_node`.
- Check `/admin/debug/stats` for `sticky_assignments_total` and `sticky_hits_total`.

### Massive request bursts
- Tighten `rate_limit_per_minute` and `token_rate_limit_per_minute`.
- Check logs for `rate_limited` and `token_rate_limited` events.
- For admin abuse/bruteforce, lower `admin_rate_limit_per_minute`.

### All clients appear as one IP behind proxy
- Set `trust_x_forwarded_for: true` only when middleware is behind your trusted reverse proxy.
- If middleware is exposed directly, keep `trust_x_forwarded_for: false`.

### Wrong grouping or fallback to `Other`
- Adjust `groups` patterns.
- Use `/admin/debug/token/{token}` to inspect payload type and cache behavior.

### Need to isolate a broken node quickly
- Add node to quarantine via `/admin/quarantine`.
- Verify `quarantine_count` in `/health`.
- Remove when node is healthy again.

## Safe Defaults
- `profile_mode: stable`
- `cache_ttl_sec: 600`
- `cache_stale_if_error_sec: 3600`
- `admin_token` set and rotated periodically
