'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCircuitBreaker, createCircuitBreakerRegistry } = require('../lib/runtime');

test('circuit breaker allows a single HALF_OPEN probe and closes after success', () => {
    let now = 0;
    const cb = createCircuitBreaker(2, 1, { now: () => now, halfOpenLeaseMs: 500 });
    assert.equal(cb.allowRequest(), true);

    cb.recordFailure();
    assert.equal(cb.allowRequest(), true);

    cb.recordFailure();
    assert.equal(cb.allowRequest(), false);
    assert.equal(cb.status().state, 'OPEN');

    now = 1000;
    assert.equal(cb.allowRequest(), true);
    assert.equal(cb.status().state, 'HALF_OPEN');
    assert.equal(cb.allowRequest(), false);

    cb.recordSuccess();
    assert.equal(cb.status().state, 'CLOSED');
    assert.equal(cb.status().open, false);
});

test('HALF_OPEN probe failure reopens only its upstream circuit', () => {
    let now = 0;
    const registry = createCircuitBreakerRegistry(1, 1, { now: () => now, halfOpenLeaseMs: 500 });

    registry.recordFailure('https://upstream-a.example');
    assert.equal(registry.allowRequest('https://upstream-a.example'), false);
    assert.equal(registry.allowRequest('https://upstream-b.example'), true);

    now = 1000;
    assert.equal(registry.allowRequest('https://upstream-a.example'), true);
    assert.equal(registry.allowRequest('https://upstream-a.example'), false);
    registry.recordFailure('https://upstream-a.example');

    assert.equal(registry.status('https://upstream-a.example').state, 'OPEN');
    assert.equal(registry.status('https://upstream-b.example').state, 'CLOSED');
    assert.equal(registry.size(), 2);
});
