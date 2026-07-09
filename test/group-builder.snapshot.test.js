'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildGroupConfig } = require('../lib/group-builder');

test('buildGroupConfig output matches snapshot fixture', () => {
    const base = {
        remarks: 'base',
        dns: { servers: ['1.1.1.1'] },
        inbounds: [{ tag: 'socks', protocol: 'socks' }],
        extraField: { x: 1 },
    };
    const outbounds = [
        { tag: 'Germany-1', protocol: 'vless' },
        { tag: 'USA-1', protocol: 'vless' },
    ];

    const out = buildGroupConfig(base, '🇪🇺 Europe', outbounds, {
        probeUrl: 'https://example.com/ping',
        probeInterval: '3m',
        strategy: 'leastLoad',
    });

    const snapPath = path.join(__dirname, 'fixtures', 'group_snapshot.json');
    const expected = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    assert.deepEqual(out, expected);
});

test('buildGroupConfig adds fallback balancer and keeps base inbound ports', () => {
    const base = {
        inbounds: [
            { tag: 'socks', port: 10808, protocol: 'socks' },
            { tag: 'http', port: 10809, protocol: 'http' },
        ],
    };

    const out = buildGroupConfig(base, '🏁 Fastest', [{ tag: 'Main-1', protocol: 'vless' }], {
        fallbackOutbounds: [
            { tag: 'LTE-1', protocol: 'vless' },
            { tag: 'LTE-2', protocol: 'vless' },
        ],
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastLoad',
    });

    assert.deepEqual(out.inbounds.map((inbound) => inbound.port), [10808, 10809]);
    assert.equal(out.outbounds[0].tag, 'proxy');
    assert.deepEqual(out.burstObservatory.subjectSelector, ['Main-1', 'LTE-1', 'LTE-2']);
    assert.equal(out.burstObservatory.pingConfig.sampling, 1);
    assert.equal(out.burstObservatory.pingConfig.timeout, '3s');
    assert.equal(out.routing.balancers[0].fallbackTag, '_Fastest-fallback-balancer');
    assert.deepEqual(out.routing.balancers[1].selector, ['LTE-1', 'LTE-2']);
});

test('buildGroupConfig emits leastPing strategy without leastLoad settings', () => {
    const out = buildGroupConfig({}, 'Fastest ping', [
        { tag: 'Germany-1', protocol: 'vless' },
        { tag: 'Germany-2', protocol: 'vless' },
    ], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastPing',
    });

    assert.deepEqual(out.burstObservatory.subjectSelector, ['Germany-1', 'Germany-2']);
    assert.deepEqual(out.routing.balancers[0].strategy, { type: 'leastPing' });
});

test('buildGroupConfig does not inherit per-server description fields from base config', () => {
    const base = {
        remarks: 'base',
        description: 'node-specific description',
        serverDescription: 'node-specific server description',
        server_description: 'node specific snake case description',
        extraField: { x: 1 },
    };

    const out = buildGroupConfig(base, '🇪🇺 Europe', [{ tag: 'Germany-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '3m',
        strategy: 'leastLoad',
    });

    assert.equal(out.description, undefined);
    assert.equal(out.serverDescription, undefined);
    assert.equal(out.server_description, undefined);
    assert.deepEqual(out.extraField, { x: 1 });
});

test('buildGroupConfig does not inherit stale observatory from base config', () => {
    const out = buildGroupConfig({
        observatory: { subjectSelector: ['old-node'] },
        burstObservatory: { subjectSelector: ['old-burst-node'] },
    }, 'Europe', [{ tag: 'Germany-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '3m',
        strategy: 'leastLoad',
    });

    assert.equal(out.observatory, undefined);
    assert.deepEqual(out.burstObservatory.subjectSelector, ['Germany-1']);
});
