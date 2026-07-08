'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenCache, createRateLimiter, createKeyedRateLimiter } = require('../lib/runtime');

test('token cache returns fresh values and expires old ones', async () => {
    const cache = createTokenCache(1, 10);
    cache.set('tok', '{"ok":true}', { 'content-type': 'application/json' });

    assert.equal(cache.get('tok').body, '{"ok":true}');

    await new Promise(r => setTimeout(r, 1100));
    assert.equal(cache.get('tok'), null);
});

test('token cache can return stale within configured window', async () => {
    const cache = createTokenCache(1, 10);
    cache.set('tok', '{"ok":true}', {});
    await new Promise(r => setTimeout(r, 1100));

    assert.equal(cache.get('tok'), null);
    assert.equal(cache.getStale('tok', 5).body, '{"ok":true}');
    assert.equal(cache.getStale('tok', 0), null);
});

test('stale reads do not extend stale window lifetime', async () => {
    const cache = createTokenCache(1, 10);
    cache.set('tok', '{"ok":true}', {});
    await new Promise(r => setTimeout(r, 1100));

    assert.ok(cache.getStale('tok', 2));
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(cache.getStale('tok', 2), null);
});

test('token cache evicts oldest items when limit exceeded', () => {
    const cache = createTokenCache(30, 2);
    cache.set('a', 'A', {});
    cache.set('b', 'B', {});
    cache.set('c', 'C', {});

    assert.equal(cache.get('a'), null);
    assert.equal(cache.get('b').body, 'B');
    assert.equal(cache.get('c').body, 'C');
});

test('token cache can be cleared after runtime config changes', () => {
    const cache = createTokenCache(30, 10);
    cache.set('a', 'A', {});
    cache.set('b', 'B', {});

    assert.equal(cache.clear(), 2);
    assert.equal(cache.get('a'), null);
    assert.equal(cache.getStale('b', 60), null);
    assert.equal(cache.clear(), 0);
});

test('rate limiter blocks burst overflow', () => {
    const limiter = createRateLimiter(100, 2);
    const ip = '1.1.1.1';

    assert.equal(limiter.allow(ip, 1000), true);
    assert.equal(limiter.allow(ip, 1001), true);
    assert.equal(limiter.allow(ip, 1002), false);
});

test('rate limiter cleanup cursor eventually reaches stale tail entries', () => {
    const limiter = createRateLimiter(100, 100, {
        idleMs: 1000,
        cleanupBatch: 1,
        cleanupIntervalMs: 1,
    });

    assert.equal(limiter.allow('hot', 0), true);
    assert.equal(limiter.allow('stale-1', 0), true);
    assert.equal(limiter.allow('stale-2', 0), true);
    assert.equal(limiter.size(), 3);

    assert.equal(limiter.allow('hot', 2000), true);
    assert.equal(limiter.allow('hot', 2002), true);
    assert.equal(limiter.allow('hot', 2004), true);

    assert.equal(limiter.size(), 1);
});

test('keyed limiter keeps bounded number of token buckets', () => {
    const limiter = createKeyedRateLimiter(100, 100, {
        idleMs: 600000,
        maxEntries: 3,
        cleanupBatch: 1,
    });

    assert.equal(limiter.allow('t1', 1000), true);
    assert.equal(limiter.allow('t2', 1001), true);
    assert.equal(limiter.allow('t3', 1002), true);
    assert.equal(limiter.size(), 3);

    assert.equal(limiter.allow('t4', 1003), true);
    assert.equal(limiter.size(), 3);
});

test('keyed limiter performs cleanup only after cleanup interval', () => {
    const limiter = createKeyedRateLimiter(100, 100, {
        idleMs: 1000,
        cleanupBatch: 100,
        cleanupIntervalMs: 10000,
        maxEntries: 10,
    });

    assert.equal(limiter.allow('t1', 0), true);
    assert.equal(limiter.allow('t2', 1), true);
    assert.equal(limiter.size(), 2);

    assert.equal(limiter.allow('t3', 2000), true);
    assert.equal(limiter.size(), 3);

    assert.equal(limiter.allow('t4', 10001), true);
    assert.equal(limiter.size(), 1);
});
