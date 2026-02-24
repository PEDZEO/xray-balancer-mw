'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../lib/config');

test('validateConfig accepts a valid config', () => {
    const cfg = {
        port: 4100,
        sub_path: '/api/sub',
        strategy: 'leastLoad',
        fastest_group: true,
        node_stats: true,
        max_users_per_gb: 20,
        max_users_per_cpu: 40,
        groups: {
            '🇩🇪 Germany': ['German'],
        },
    };

    assert.deepEqual(validateConfig(cfg), cfg);
});

test('validateConfig rejects invalid port', () => {
    assert.throws(() => validateConfig({ port: 70000 }), /config\.port/);
});

test('validateConfig rejects malformed groups', () => {
    assert.throws(() => validateConfig({ groups: { test: [] } }), /at least one pattern/);
});

test('validateConfig accepts runtime and fastest-exclude options', () => {
    const cfg = {
        profile_mode: 'stable',
        admin_token: 'supersecret',
        fastest_exclude_groups: ['🇷🇺 White List'],
        cache_ttl_sec: 300,
        cache_stale_if_error_sec: 1800,
        cache_max_entries: 1000,
        rate_limit_per_minute: 120,
        rate_limit_burst_10s: 30,
        ready_success_window_sec: 300,
    };

    assert.deepEqual(validateConfig(cfg), cfg);
});
