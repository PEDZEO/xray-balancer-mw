'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestGuard } = require('../lib/request-guard');

function limiter(always) {
    return { allow: () => always };
}

test('request guard blocks by ip first', () => {
    const stats = { rate_limited_ip_total: 0, rate_limited_token_total: 0, circuit_open_total: 0 };
    const guard = createRequestGuard({
        ipLimiter: limiter(false),
        tokenLimiter: limiter(true),
        circuitBreaker: { allowRequest: () => true },
        stats,
    });

    const out = guard.evaluate('1.1.1.1', 'tok');
    assert.equal(out.ok, false);
    assert.equal(out.code, 'RATE_LIMITED');
    assert.equal(stats.rate_limited_ip_total, 1);
});

test('request guard blocks by token after ip', () => {
    const stats = { rate_limited_ip_total: 0, rate_limited_token_total: 0, circuit_open_total: 0 };
    const guard = createRequestGuard({
        ipLimiter: limiter(true),
        tokenLimiter: limiter(false),
        circuitBreaker: { allowRequest: () => true },
        stats,
    });

    const out = guard.evaluate('1.1.1.1', 'tok');
    assert.equal(out.ok, false);
    assert.equal(out.code, 'TOKEN_RATE_LIMITED');
    assert.equal(stats.rate_limited_token_total, 1);
});

test('request guard allows fallback when circuit is open', () => {
    const stats = { rate_limited_ip_total: 0, rate_limited_token_total: 0, circuit_open_total: 0 };
    const guard = createRequestGuard({
        ipLimiter: limiter(true),
        tokenLimiter: limiter(true),
        circuitBreaker: { allowRequest: () => false },
        stats,
    });

    const out = guard.evaluate('1.1.1.1', 'tok');
    assert.equal(out.ok, false);
    assert.equal(out.code, 'UPSTREAM_CIRCUIT_OPEN');
    assert.equal(out.allowFallback, true);
    assert.equal(stats.circuit_open_total, 1);
});
