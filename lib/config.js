'use strict';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateGroups(groups) {
    assert(isObject(groups), 'config.groups must be an object');
    const groupEntries = Object.entries(groups);
    assert(groupEntries.length <= 100, 'config.groups must contain at most 100 groups');

    for (const [groupName, patterns] of groupEntries) {
        assert(groupName.trim().length > 0, 'config.groups contains empty group name');
        assert(groupName.length <= 64, `config.groups[${groupName}] name must be <= 64 chars`);
        assert(Array.isArray(patterns), `config.groups[${groupName}] must be an array`);
        assert(patterns.length > 0, `config.groups[${groupName}] must contain at least one pattern`);
        assert(patterns.length <= 100, `config.groups[${groupName}] must contain at most 100 patterns`);
        for (const pattern of patterns) {
            assert(typeof pattern === 'string' && pattern.trim().length > 0, `config.groups[${groupName}] contains invalid pattern`);
            assert(pattern.length <= 128, `config.groups[${groupName}] contains pattern longer than 128 chars`);
        }
    }
}

function validateConfig(config) {
    assert(isObject(config), 'config must be a JSON object');

    if (config.port !== undefined) {
        assert(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535, 'config.port must be an integer in range 1..65535');
    }

    if (config.sub_path !== undefined) {
        assert(typeof config.sub_path === 'string' && config.sub_path.startsWith('/'), 'config.sub_path must start with "/"');
    }

    if (config.strategy !== undefined) {
        const allowed = new Set(['leastLoad', 'random', 'roundRobin']);
        assert(allowed.has(config.strategy), 'config.strategy must be one of: leastLoad, random, roundRobin');
    }

    if (config.probe_interval !== undefined) {
        assert(typeof config.probe_interval === 'string' && config.probe_interval.trim().length > 0, 'config.probe_interval must be a non-empty string');
    }

    if (config.probe_url !== undefined) {
        assert(typeof config.probe_url === 'string' && /^https?:\/\//i.test(config.probe_url), 'config.probe_url must be a valid http(s) URL');
    }

    if (config.fastest_group_name !== undefined) {
        assert(typeof config.fastest_group_name === 'string' && config.fastest_group_name.trim().length > 0, 'config.fastest_group_name must be a non-empty string');
    }

    const boolKeys = ['fastest_group', 'auto_groups', 'node_stats'];
    for (const key of boolKeys) {
        if (config[key] !== undefined) {
            assert(typeof config[key] === 'boolean', `config.${key} must be boolean`);
        }
    }

    const intKeys = ['auto_groups_interval_sec', 'node_stats_interval_sec', 'max_users_per_gb', 'max_users_per_cpu'];
    for (const key of intKeys) {
        if (config[key] !== undefined) {
            assert(Number.isInteger(config[key]) && config[key] > 0, `config.${key} must be a positive integer`);
        }
    }

    const positiveIntKeys = [
        'cache_ttl_sec',
        'cache_stale_if_error_sec',
        'cache_max_entries',
        'rate_limit_per_minute',
        'rate_limit_burst_10s',
        'token_rate_limit_per_minute',
        'token_rate_limit_burst_10s',
        'token_limiter_max_entries',
        'token_limiter_cleanup_batch',
        'ready_success_window_sec',
        'request_timeout_ms',
        'max_redirects',
        'circuit_breaker_failures',
        'circuit_breaker_open_sec',
    ];
    for (const key of positiveIntKeys) {
        if (config[key] !== undefined) {
            assert(Number.isInteger(config[key]) && config[key] > 0, `config.${key} must be a positive integer`);
        }
    }

    if (config.groups !== undefined) {
        validateGroups(config.groups);
    }

    if (config.fastest_exclude_groups !== undefined) {
        assert(Array.isArray(config.fastest_exclude_groups), 'config.fastest_exclude_groups must be an array');
        for (const groupName of config.fastest_exclude_groups) {
            assert(typeof groupName === 'string' && groupName.trim().length > 0, 'config.fastest_exclude_groups contains invalid group name');
        }
    }

    if (config.profile_mode !== undefined) {
        const allowedProfiles = new Set(['balanced', 'stable', 'aggressive', 'debug']);
        assert(allowedProfiles.has(config.profile_mode), 'config.profile_mode must be one of: balanced, stable, aggressive, debug');
    }

    if (config.admin_token !== undefined) {
        assert(typeof config.admin_token === 'string' && config.admin_token.length >= 8, 'config.admin_token must be a string with length >= 8');
    }

    if (config.warmup_tokens !== undefined) {
        assert(Array.isArray(config.warmup_tokens), 'config.warmup_tokens must be an array');
        for (const token of config.warmup_tokens) {
            assert(typeof token === 'string' && /^[a-zA-Z0-9_-]+$/.test(token), 'config.warmup_tokens contains invalid token');
        }
    }

    return config;
}

module.exports = {
    validateConfig,
};
