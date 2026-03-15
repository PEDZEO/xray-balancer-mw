'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStickyStore } = require('../lib/sticky');

test('sticky store reuses selected node while ttl is active', () => {
    const store = createStickyStore({ ttlSec: 60 });
    const outbounds = [{ tag: 'Germany-1' }, { tag: 'Germany-2' }];

    const first = store.choose('tok', outbounds, 1000);
    assert.equal(first.selected.tag, 'Germany-1');
    assert.equal(first.changed, true);

    const second = store.choose('tok', [{ tag: 'Germany-2' }, { tag: 'Germany-1' }], 2000);
    assert.equal(second.selected.tag, 'Germany-1');
    assert.equal(second.changed, false);
});

test('sticky store rotates to first available node when old one disappears', () => {
    const store = createStickyStore({ ttlSec: 60 });
    store.assign('tok', 'Germany-1', 1000);

    const result = store.choose('tok', [{ tag: 'Germany-2' }, { tag: 'Germany-3' }], 2000);
    assert.equal(result.selected.tag, 'Germany-2');
    assert.equal(result.changed, true);
});

test('sticky store expires entries after ttl', () => {
    const store = createStickyStore({ ttlSec: 2 });
    store.assign('tok', 'Germany-1', 1000);

    assert.equal(store.get('tok', 2000)?.nodeName, 'Germany-1');
    assert.equal(store.get('tok', 4001), null);
});
