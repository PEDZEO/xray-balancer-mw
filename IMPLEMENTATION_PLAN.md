# Reliability and Performance Hardening Plan

Date: 2026-02-25
Scope: `/home/pedzeo/GitHub/xray-balancer-mw`

## Plan

- [x] 1. Protect admin endpoints against brute-force and abuse.
  - Add admin rate limiting independent from public subscription traffic.
  - Centralize admin auth check to reduce duplicated and inconsistent checks.

- [x] 2. Harden client IP extraction for request limiting.
  - Default to `req.socket.remoteAddress`.
  - Trust `X-Forwarded-For` only when explicitly enabled.

- [x] 3. Reduce per-request limiter overhead.
  - Make cleanup in `createRateLimiter` periodic/batched instead of running full cleanup on every request.
  - Keep keyed limiter cleanup bounded and periodic.

- [x] 4. Reduce expensive deep cloning in hot paths.
  - Replace unnecessary `structuredClone` usage in outbound collection and group assembly.

- [x] 5. Add regression tests for cache stale semantics and limiter cleanup behavior.

- [x] 6. Run validation checks (`node -c`, tests) and document results.

## Progress Log

- [x] Created execution plan document.
- [x] Started implementation.
- [x] Updated tests.
- [x] Validation checks passed.
