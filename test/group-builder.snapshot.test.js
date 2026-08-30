'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildGroupConfig, mergeProfileBaseConfigs } = require('../lib/group-builder');

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

test('buildGroupConfig uses a loopback outbound to preserve the fallback pool', () => {
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
    assert.equal(out.burstObservatory.pingConfig.connectivity, '');
    assert.equal(out.burstObservatory.pingConfig.httpMethod, 'HEAD');
    assert.equal(out.routing.balancers.length, 2);
    assert.equal(out.routing.balancers[0].fallbackTag, '_Fastest-fallback-dispatch');
    assert.equal(out.routing.balancers[1].fallbackTag, 'LTE-1');
    assert.deepEqual(out.routing.balancers[1].selector, ['LTE-1', 'LTE-2']);
    assert.deepEqual(
        out.outbounds.find((outbound) => outbound.tag === '_Fastest-fallback-dispatch'),
        {
            tag: '_Fastest-fallback-dispatch',
            protocol: 'loopback',
            settings: { inboundTag: '_Fastest-fallback-in' },
        },
    );
    assert.deepEqual(out.routing.rules[0], {
        type: 'field',
        inboundTag: ['_Fastest-proxy-in'],
        balancerTag: '_Fastest-balancer',
    });
    assert.deepEqual(out.routing.rules[1], {
        type: 'field',
        inboundTag: ['_Fastest-fallback-in'],
        balancerTag: '_Fastest-fallback-balancer',
    });
});

test('buildGroupConfig preserves panel routing rules and remaps proxy to the generated balancer', () => {
    const base = {
        routing: {
            domainStrategy: 'AsIs',
            domainMatcher: 'hybrid',
            rules: [
                { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' },
                { type: 'field', domain: ['geosite:ru'], ip: ['geoip:ru'], outboundTag: 'direct' },
                { type: 'field', network: 'udp', port: '53', outboundTag: 'dns-out' },
                { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
                { type: 'field', domain: ['example.invalid'], outboundTag: 'missing-outbound' },
                { type: 'field', network: 'tcp', balancerTag: 'old-balancer' },
            ],
        },
        outbounds: [
            { tag: 'proxy', protocol: 'vless', settings: { transport: 'xhttp' } },
            { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } },
            { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } },
            { tag: 'dns-out', protocol: 'dns' },
        ],
    };

    const out = buildGroupConfig(base, 'Europe', [{ tag: 'Germany-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastPing',
    });

    assert.equal(out.routing.domainStrategy, 'AsIs');
    assert.equal(out.routing.domainMatcher, 'hybrid');
    assert.deepEqual(out.outbounds[0], {
        tag: 'proxy',
        protocol: 'loopback',
        settings: { inboundTag: 'Europe-proxy-in' },
    });
    assert.deepEqual(out.outbounds.find((outbound) => outbound.tag === 'direct').settings, {
        domainStrategy: 'UseIPv4',
    });
    assert.ok(out.outbounds.some((outbound) => outbound.tag === 'dns-out' && outbound.protocol === 'dns'));
    assert.ok(out.routing.rules.some((rule) => rule.domain?.includes('geosite:category-ads-all') && rule.outboundTag === 'block'));
    assert.ok(out.routing.rules.some((rule) => rule.domain?.includes('geosite:ru') && rule.outboundTag === 'direct'));
    assert.ok(out.routing.rules.some((rule) => rule.port === '53' && rule.outboundTag === 'dns-out'));
    assert.ok(out.routing.rules.some((rule) => rule.network === 'tcp,udp' && rule.balancerTag === 'Europe-balancer'));
    assert.equal(out.routing.rules.some((rule) => rule.outboundTag === 'missing-outbound'), false);
    assert.equal(out.routing.rules.some((rule) => rule.balancerTag === 'old-balancer'), false);
});

test('mergeProfileBaseConfigs merges DNS and routing policy from every upstream profile', () => {
    const merged = mergeProfileBaseConfigs([
        {
            routing: {
                domainStrategy: 'IPIfNonMatch',
                rules: [{ type: 'field', domain: ['geosite:ru'], outboundTag: 'direct' }],
            },
            outbounds: [{ tag: 'direct', protocol: 'freedom' }],
        },
        {
            dns: {
                servers: ['https://1.1.1.1/dns-query', { address: '8.8.8.8', domains: ['geosite:ru'] }],
                hosts: { 'domain:example.com': '127.0.0.1' },
                queryStrategy: 'UseIPv4',
            },
            routing: {
                rules: [{ type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' }],
            },
            outbounds: [
                { tag: 'block', protocol: 'blackhole' },
                { tag: 'dns-out', protocol: 'dns' },
            ],
        },
        {
            dns: {
                servers: ['https://1.1.1.1/dns-query', 'localhost'],
                hosts: { 'domain:internal.example': '10.0.0.1' },
            },
        },
    ]);

    assert.deepEqual(merged.dns.servers, [
        'https://1.1.1.1/dns-query',
        { address: '8.8.8.8', domains: ['geosite:ru'] },
        'localhost',
    ]);
    assert.deepEqual(merged.dns.hosts, {
        'domain:example.com': '127.0.0.1',
        'domain:internal.example': '10.0.0.1',
    });
    assert.equal(merged.routing.rules.length, 2);
    assert.deepEqual(merged.outbounds.map((outbound) => outbound.tag), ['direct', 'block', 'dns-out']);
});

test('buildGroupConfig accepts custom burst observatory ping options', () => {
    const out = buildGroupConfig({}, 'Fastest', [{ tag: 'Main-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeConnectivity: 'https://example.com/connectivity',
        probeInterval: '30s',
        probeSampling: 3,
        probeTimeout: '5s',
        probeHttpMethod: 'GET',
        strategy: 'leastPing',
    });

    assert.deepEqual(out.burstObservatory.pingConfig, {
        destination: 'https://example.com/ping',
        connectivity: 'https://example.com/connectivity',
        interval: '30s',
        sampling: 3,
        timeout: '5s',
        httpMethod: 'GET',
    });
});

test('every observed balancer fallback resolves to a safe outbound', () => {
    for (const strategy of ['leastPing', 'leastLoad']) {
        for (const fallbackOutbounds of [
            [],
            [{ tag: 'Reserve-1', protocol: 'vless' }],
            [
                { tag: 'Reserve-1', protocol: 'vless' },
                { tag: 'Reserve-2', protocol: 'vless' },
            ],
        ]) {
            const out = buildGroupConfig({}, `${strategy}-group`, [
                { tag: 'Main-1', protocol: 'vless' },
                { tag: 'Main-2', protocol: 'vless' },
            ], {
                fallbackOutbounds,
                probeUrl: 'https://example.com/ping',
                probeInterval: '1m',
                strategy,
            });
            const outboundTags = new Set(out.outbounds.map((outbound) => outbound.tag));
            const outboundsByTag = new Map(out.outbounds.map((outbound) => [outbound.tag, outbound]));
            const balancerTags = new Set(out.routing.balancers.map((balancer) => balancer.tag));

            for (const balancer of out.routing.balancers) {
                assert.ok(balancer.fallbackTag, `${strategy} balancer must have fallbackTag`);
                assert.ok(outboundTags.has(balancer.fallbackTag), 'fallbackTag must resolve to an outbound');
                assert.equal(balancerTags.has(balancer.fallbackTag), false, 'fallbackTag must not resolve to a balancer');
                assert.notEqual(balancer.fallbackTag, 'direct', 'fallback must not leak traffic directly');
                assert.notEqual(balancer.fallbackTag, 'block', 'fallback must not silently block traffic');
                assert.notEqual(balancer.fallbackTag, out.outbounds[0].tag, 'fallback must not use the default outbound implicitly');
                assert.notEqual(outboundsByTag.get(balancer.fallbackTag).protocol, 'freedom');
                assert.notEqual(outboundsByTag.get(balancer.fallbackTag).protocol, 'blackhole');
            }
        }
    }
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
    assert.equal(out.routing.balancers[0].fallbackTag, 'Germany-1');
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
