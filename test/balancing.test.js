'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchGroup, isFakeConfig, filterAndSortByLoad } = require('../lib/balancing');

test('matchGroup prefers the longest matching pattern', () => {
    const groups = {
        '🇩🇪 Germany': ['Ger', 'German'],
        '🇺🇸 USA': ['US'],
    };

    const group = matchGroup(groups, 'German #1');
    assert.equal(group, '🇩🇪 Germany');
});

test('matchGroup treats short patterns as whole words only', () => {
    const groups = {
        '🇳🇱 Netherlands': ['NL'],
    };

    assert.equal(matchGroup(groups, 'finland-main'), null);
    assert.equal(matchGroup(groups, 'Node NL #1'), '🇳🇱 Netherlands');
});

test('matchGroup escapes regex metacharacters in short patterns', () => {
    const groups = {
        Weird: ['+'],
    };

    assert.equal(matchGroup(groups, 'node + tag'), 'Weird');
    assert.equal(matchGroup(groups, 'node tag'), null);
});

test('isFakeConfig detects fake outbounds with 0.0.0.0:1', () => {
    const fake = [{
        outbounds: [
            { protocol: 'vless', tag: 'a', settings: { vnext: [{ address: '0.0.0.0', port: 1 }] } },
            { protocol: 'trojan', tag: 'b', settings: { servers: [{ address: '0.0.0.0', port: 1 }] } },
        ],
    }];

    assert.equal(isFakeConfig(fake), true);
});

test('filterAndSortByLoad drops overloaded/offline nodes and sorts remaining', () => {
    const outbounds = [{ tag: 'A-node' }, { tag: 'B-node' }, { tag: 'C-node' }];
    const cache = {
        'A-node': { load: 0.9, isConnected: true, isDisabled: false },
        'B-node': { load: 1.2, isConnected: true, isDisabled: false },
        'C-node': { load: 0.2, isConnected: true, isDisabled: false },
    };

    const result = filterAndSortByLoad(outbounds, cache);
    assert.deepEqual(result.map(x => x.tag), ['C-node', 'A-node']);
});
