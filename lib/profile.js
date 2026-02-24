'use strict';

const PROFILES = {
    balanced: {
        cache_ttl_sec: 300,
        cache_stale_if_error_sec: 1800,
        cache_max_entries: 1000,
        rate_limit_per_minute: 120,
        rate_limit_burst_10s: 30,
        token_rate_limit_per_minute: 240,
        token_rate_limit_burst_10s: 60,
        ready_success_window_sec: 300,
        request_timeout_ms: 10000,
        max_redirects: 3,
        circuit_breaker_failures: 6,
        circuit_breaker_open_sec: 30,
    },
    stable: {
        cache_ttl_sec: 600,
        cache_stale_if_error_sec: 3600,
        cache_max_entries: 2000,
        rate_limit_per_minute: 90,
        rate_limit_burst_10s: 20,
        token_rate_limit_per_minute: 180,
        token_rate_limit_burst_10s: 40,
        ready_success_window_sec: 600,
        request_timeout_ms: 12000,
        max_redirects: 2,
        circuit_breaker_failures: 5,
        circuit_breaker_open_sec: 45,
    },
    aggressive: {
        cache_ttl_sec: 120,
        cache_stale_if_error_sec: 600,
        cache_max_entries: 500,
        rate_limit_per_minute: 180,
        rate_limit_burst_10s: 50,
        token_rate_limit_per_minute: 360,
        token_rate_limit_burst_10s: 100,
        ready_success_window_sec: 120,
        request_timeout_ms: 7000,
        max_redirects: 2,
        circuit_breaker_failures: 8,
        circuit_breaker_open_sec: 20,
    },
    debug: {
        cache_ttl_sec: 60,
        cache_stale_if_error_sec: 300,
        cache_max_entries: 200,
        rate_limit_per_minute: 300,
        rate_limit_burst_10s: 100,
        token_rate_limit_per_minute: 600,
        token_rate_limit_burst_10s: 200,
        ready_success_window_sec: 120,
        request_timeout_ms: 15000,
        max_redirects: 5,
        circuit_breaker_failures: 12,
        circuit_breaker_open_sec: 10,
    },
};

function resolveProfile(name) {
    if (PROFILES[name]) {
        return { name, values: PROFILES[name] };
    }
    return { name: 'balanced', values: PROFILES.balanced };
}

module.exports = {
    PROFILES,
    resolveProfile,
};
