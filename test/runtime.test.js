'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenCache, createRateLimiter } = require('../lib/runtime');

test('token cache returns fresh values and expires old ones', async () => {
    const cache = createTokenCache(1);
    cache.set('tok', '{"ok":true}', { 'content-type': 'application/json' });

    assert.equal(cache.get('tok').body, '{"ok":true}');

    await new Promise(r => setTimeout(r, 1100));
    assert.equal(cache.get('tok'), null);
});

test('rate limiter blocks burst overflow', () => {
    const limiter = createRateLimiter(100, 2);
    const ip = '1.1.1.1';

    assert.equal(limiter.allow(ip, 1000), true);
    assert.equal(limiter.allow(ip, 1001), true);
    assert.equal(limiter.allow(ip, 1002), false);
});
