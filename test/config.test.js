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
