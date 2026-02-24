'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCircuitBreaker } = require('../lib/runtime');

test('circuit breaker opens after threshold and recovers after window', async () => {
    const cb = createCircuitBreaker(2, 1);
    assert.equal(cb.allowRequest(), true);

    cb.recordFailure();
    assert.equal(cb.allowRequest(), true);

    cb.recordFailure();
    assert.equal(cb.allowRequest(), false);

    await new Promise(r => setTimeout(r, 1100));
    assert.equal(cb.allowRequest(), true);

    cb.recordSuccess();
    assert.equal(cb.status().open, false);
});
