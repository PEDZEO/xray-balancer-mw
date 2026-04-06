'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchGroup, isFakeConfig, filterAndSortByLoad, filterHiddenOutbounds, getNodeStats } = require('../lib/balancing');

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

test('getNodeStats resolves host remark outbounds by server address', () => {
    const cache = {
        DEplay: { load: 0.1, isConnected: true, isDisabled: false, sourceNode: 'DEplay' },
        'de.pedze.ru': { load: 0.1, isConnected: true, isDisabled: false, sourceNode: 'DEplay' },
    };
    const outbound = {
        tag: 'Германия v2  🇩🇪',
        settings: {
            vnext: [{ address: 'de.pedze.ru', port: 443 }],
        },
    };

    const result = getNodeStats(cache, outbound);
    assert.equal(result?.sourceNode, 'DEplay');
});

test('filterAndSortByLoad uses outbound addresses for host remark sorting', () => {
    const outbounds = [
        { tag: 'Германия 🇩🇪', settings: { vnext: [{ address: 'noda.pedze.ru', port: 443 }] } },
        { tag: 'Германия v2  🇩🇪', settings: { vnext: [{ address: 'de.pedze.ru', port: 443 }] } },
    ];
    const cache = {
        'noda.pedze.ru': { load: 0.9, isConnected: true, isDisabled: false, sourceNode: 'Pedze' },
        'de.pedze.ru': { load: 0.1, isConnected: true, isDisabled: false, sourceNode: 'DEplay' },
    };

    const result = filterAndSortByLoad(outbounds, cache);
    assert.deepEqual(result.map((item) => item.tag), ['Германия v2  🇩🇪', 'Германия 🇩🇪']);
});

test('filterHiddenOutbounds removes nodes hidden directly or via hidden group', () => {
    const groups = {
        '🇩🇪 Germany': ['German'],
        '🇺🇸 USA': ['USA'],
    };
    const outbounds = [
        { tag: 'German-1', protocol: 'vless' },
        { tag: 'USA-1', protocol: 'vless' },
        { tag: 'Finland-1', protocol: 'vless' },
    ];

    const result = filterHiddenOutbounds(outbounds, groups, ['🇺🇸 USA'], ['German-1']);
    assert.deepEqual(result.map((item) => item.tag), ['Finland-1']);
});
