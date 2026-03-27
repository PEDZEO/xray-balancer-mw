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
        fastest_probe_url: 'https://ya.ru',
        fastest_exclude_groups: ['🇷🇺 White List'],
        sticky_enabled: true,
        sticky_mode: 'prefer',
        sticky_ttl_sec: 3600,
        sticky_max_entries: 10000,
        cache_ttl_sec: 300,
        cache_stale_if_error_sec: 1800,
        cache_max_entries: 1000,
        rate_limit_per_minute: 120,
        rate_limit_burst_10s: 30,
        token_limiter_max_entries: 5000,
        token_limiter_cleanup_batch: 200,
        ready_success_window_sec: 300,
    };

    assert.deepEqual(validateConfig(cfg), cfg);
});

test('validateConfig rejects malformed fastest probe url', () => {
    assert.throws(() => validateConfig({ fastest_probe_url: 'ya.ru' }), /fastest_probe_url/);
});

test('validateConfig rejects invalid sticky mode', () => {
    assert.throws(() => validateConfig({ sticky_mode: 'smart' }), /sticky_mode/);
});

test('validateConfig rejects too many groups and overly long patterns', () => {
    const groups = {};
    for (let i = 0; i < 101; i += 1) {
        groups[`G${i}`] = ['ok'];
    }
    assert.throws(() => validateConfig({ groups }), /at most 100 groups/);

    assert.throws(
        () => validateConfig({ groups: { main: ['x'.repeat(129)] } }),
        /longer than 128 chars/,
    );
});

test('validateConfig validates quarantine_nodes', () => {
    const cfg = {
        quarantine_nodes: ['Germany-1', 'USA Main'],
    };
    assert.deepEqual(validateConfig(cfg), cfg);

    assert.throws(
        () => validateConfig({ quarantine_nodes: [''] }),
        /quarantine_nodes contains invalid node name/,
    );
});
