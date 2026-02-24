'use strict';

const PROFILES = {
    balanced: {
        cache_ttl_sec: 300,
        cache_stale_if_error_sec: 1800,
        cache_max_entries: 1000,
        rate_limit_per_minute: 120,
        rate_limit_burst_10s: 30,
        ready_success_window_sec: 300,
    },
    stable: {
        cache_ttl_sec: 600,
        cache_stale_if_error_sec: 3600,
        cache_max_entries: 2000,
        rate_limit_per_minute: 90,
        rate_limit_burst_10s: 20,
        ready_success_window_sec: 600,
    },
    aggressive: {
        cache_ttl_sec: 120,
        cache_stale_if_error_sec: 600,
        cache_max_entries: 500,
        rate_limit_per_minute: 180,
        rate_limit_burst_10s: 50,
        ready_success_window_sec: 120,
    },
    debug: {
        cache_ttl_sec: 60,
        cache_stale_if_error_sec: 300,
        cache_max_entries: 200,
        rate_limit_per_minute: 300,
        rate_limit_burst_10s: 100,
        ready_success_window_sec: 120,
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
