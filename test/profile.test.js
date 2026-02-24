'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProfile } = require('../lib/profile');

test('resolve known profile', () => {
    const profile = resolveProfile('stable');
    assert.equal(profile.name, 'stable');
    assert.equal(profile.values.cache_ttl_sec > 0, true);
});

test('fallback to balanced profile', () => {
    const profile = resolveProfile('unknown');
    assert.equal(profile.name, 'balanced');
    assert.equal(profile.values.rate_limit_per_minute, 120);
});
