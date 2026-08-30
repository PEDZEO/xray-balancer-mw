'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const { matchMihomoProxyGroup, transformMihomoYaml } = require('../lib/mihomo');

function liveLikeMihomoYaml() {
    return YAML.stringify({
        profile: { 'store-selected': true },
        proxies: [
            { name: '🇷🇺 Без VPN', type: 'direct', udp: true },
            { name: 'DNS-OUT', type: 'dns' },
            { name: 'Германия 🇩🇪', type: 'vless', server: 'de.example.com', port: 443 },
            { name: 'New RU 🇷🇺', type: 'vless', server: 'ru.example.com', port: 443 },
            { name: 'Франция 🇫🇷', type: 'vless', server: 'fr.example.com', port: 443 },
            { name: 'YouTube / Instagram 🇷🇺', type: 'vless', server: 'msk.example.com', port: 443 },
            { name: '🇳🇱 Netherlands', type: 'vless', server: 'nl.example.com', port: 443 },
        ],
        'proxy-groups': [
            {
                name: '🚫 Недоступные сайты',
                type: 'select',
                proxies: [
                    '⚡ Авто-переключение',
                    '🇷🇺 Без VPN',
                    'Германия 🇩🇪',
                    'New RU 🇷🇺',
                    'Франция 🇫🇷',
                    'YouTube / Instagram 🇷🇺',
                    '🇳🇱 Netherlands',
                ],
            },
            {
                name: 'PROXY',
                type: 'select',
                hidden: true,
                proxies: ['🚫 Недоступные сайты', 'Германия 🇩🇪', 'New RU 🇷🇺'],
            },
            {
                name: '⚡ Авто-переключение',
                type: 'fallback',
                hidden: true,
                proxies: ['Германия 🇩🇪', 'New RU 🇷🇺', 'Франция 🇫🇷'],
            },
        ],
        rules: [
            'DOMAIN,node.example,Германия 🇩🇪',
            'IP-CIDR,192.0.2.0/24,Германия 🇩🇪,no-resolve',
            'MATCH,🚫 Недоступные сайты',
        ],
    });
}

function transformOptions(overrides = {}) {
    return {
        groups: {
            '🇫🇷 France': ['France', 'Франция'],
            '🇩🇪 Germany': ['Germany', 'German', 'Германия'],
            '🇷🇺 Russia': ['Russia', 'Россия', 'RU'],
            '🎬 YouTube / Instagram': ['YouTube', 'Instagram', 'msk'],
        },
        strategy: 'leastPing',
        fastestEnabled: true,
        fastestName: '🏁 Самые быстрые',
        probeUrl: 'https://www.gstatic.com/generate_204',
        fastestProbeUrl: 'https://ya.ru',
        probeInterval: '30s',
        probeTimeout: '3s',
        ...overrides,
    };
}

test('Mihomo transformation publishes configured names instead of raw nodes', () => {
    const result = transformMihomoYaml(liveLikeMihomoYaml(), transformOptions());
    assert.equal(result.kind, 'mihomo');

    const document = YAML.parse(result.body);
    const groups = new Map(document['proxy-groups'].map((group) => [group.name, group]));
    const outer = groups.get('🚫 Недоступные сайты');
    const fastest = groups.get('🏁 Самые быстрые');

    assert.deepEqual(outer.proxies, [
        '🏁 Самые быстрые',
        '🇷🇺 Без VPN',
        '🇩🇪 Germany',
        '🇷🇺 Russia',
        '🇫🇷 France',
        '🎬 YouTube / Instagram',
        '🌐 Другие серверы',
    ]);
    assert.equal(groups.has('⚡ Авто-переключение'), false);
    assert.equal(fastest.type, 'url-test');
    assert.equal(fastest.url, 'https://ya.ru');
    assert.equal(fastest.interval, 30);
    assert.equal(fastest.timeout, 3000);
    assert.equal(groups.get('🇩🇪 Germany').proxies[0], '🇩🇪 Germany · 1');
    assert.equal(groups.get('🎬 YouTube / Instagram').proxies[0], '🎬 YouTube / Instagram · 1');
    assert.deepEqual(groups.get('🌐 Другие серверы').proxies, ['🇳🇱 Netherlands']);
    assert.equal(document.profile['store-selected'], false);
    assert.equal(document.rules[0], 'DOMAIN,node.example,🇩🇪 Germany · 1');
    assert.equal(document.rules[1], 'IP-CIDR,192.0.2.0/24,🇩🇪 Germany · 1,no-resolve');

    const publishedProxyNames = document.proxies.map((proxy) => proxy.name);
    assert.equal(publishedProxyNames.includes('Германия 🇩🇪'), false);
    assert.equal(publishedProxyNames.includes('🇩🇪 Germany · 1'), true);
});

test('Mihomo transformation applies hidden and fastest exclusion settings', () => {
    const result = transformMihomoYaml(liveLikeMihomoYaml(), transformOptions({
        hiddenGroups: ['🇫🇷 France'],
        hiddenNodes: ['New RU 🇷🇺'],
        fastestExcludeGroups: ['🎬 YouTube / Instagram'],
    }));
    const document = YAML.parse(result.body);
    const groups = new Map(document['proxy-groups'].map((group) => [group.name, group]));

    assert.equal(groups.has('🇫🇷 France'), false);
    assert.equal(document.proxies.some((proxy) => proxy.name === 'New RU 🇷🇺'), false);
    assert.equal(groups.get('🏁 Самые быстрые').proxies.some((name) => name.startsWith('🎬 YouTube')), false);
    assert.equal(groups.get('🎬 YouTube / Instagram').proxies.length, 1);
});

test('fake Mihomo error profiles remain untouched', () => {
    const body = YAML.stringify({
        proxies: [
            { name: 'Subscription expired', type: 'vless', server: '0.0.0.0', port: 1 },
        ],
        'proxy-groups': [
            { name: 'PROXY', type: 'select', proxies: ['Subscription expired'] },
        ],
    });

    const result = transformMihomoYaml(body, transformOptions());
    assert.equal(result.kind, 'fake');
    assert.equal(result.document.proxies[0].name, 'Subscription expired');
});

test('plain non-YAML payload is not treated as Mihomo', () => {
    assert.equal(transformMihomoYaml('not a subscription', transformOptions()), null);
});

test('short country patterns do not classify unrelated .ru server hostnames', () => {
    const groups = {
        '🇷🇺 Russia': ['RU'],
        '🇩🇪 Germany': ['noda'],
    };

    assert.equal(matchMihomoProxyGroup(groups, {
        name: 'Польша 🇵🇱',
        server: 'poland.example.ru',
    }), null);
    assert.equal(matchMihomoProxyGroup(groups, {
        name: 'Unknown node',
        server: 'noda.example.ru',
    }), '🇩🇪 Germany');
});

test('cleartext XHTTP on port 80 uses HTTP/1.1 without overriding explicit ALPN', () => {
    const body = YAML.stringify({
        proxies: [
            { name: 'CDN', type: 'vless', server: 'cdn.example.com', port: 80, network: 'xhttp' },
            { name: 'Explicit H2', type: 'vless', server: 'h2.example.com', port: 80, network: 'xhttp', alpn: ['h2'] },
            { name: 'TLS XHTTP', type: 'vless', server: 'tls.example.com', port: 443, network: 'xhttp', tls: true },
            { name: 'Plain TCP', type: 'vless', server: 'tcp.example.com', port: 80, network: 'tcp' },
        ],
        'proxy-groups': [
            { name: 'PROXY', type: 'select', proxies: ['CDN', 'Explicit H2', 'TLS XHTTP', 'Plain TCP'] },
        ],
    });

    const result = transformMihomoYaml(body, transformOptions({ groups: {} }));
    const document = YAML.parse(result.body);
    const proxies = new Map(document.proxies.map((proxy) => [proxy.name, proxy]));

    assert.deepEqual(proxies.get('CDN').alpn, ['http/1.1']);
    assert.deepEqual(proxies.get('Explicit H2').alpn, ['h2']);
    assert.equal(proxies.get('TLS XHTTP').alpn, undefined);
    assert.equal(proxies.get('Plain TCP').alpn, undefined);
    assert.equal(result.stats.compatibilityFixes, 1);
});

test('Mihomo transformation only renames the policy field in routing rules', () => {
    const body = YAML.stringify({
        proxies: [
            { name: 'example.com', type: 'vless', server: 'node.example.com', port: 443 },
        ],
        'proxy-groups': [
            { name: 'PROXY', type: 'select', proxies: ['example.com'] },
        ],
        rules: [
            'DOMAIN,example.com,DIRECT',
            'IP-CIDR,192.0.2.0/24,example.com,no-resolve',
        ],
    });

    const result = transformMihomoYaml(body, transformOptions({ groups: { Europe: ['example.com'] } }));
    const document = YAML.parse(result.body);
    assert.equal(document.rules[0], 'DOMAIN,example.com,DIRECT');
    assert.equal(document.rules[1], 'IP-CIDR,192.0.2.0/24,Europe · 1,no-resolve');
});

test('Mihomo preserved groups repair renamed proxy references and default selection', () => {
    const body = YAML.stringify({
        proxies: [
            { name: 'Germany raw', type: 'vless', server: 'de.example.com', port: 443 },
            { name: 'Chain', type: 'vless', server: 'chain.example.com', port: 443, 'dialer-proxy': 'Germany raw' },
        ],
        'proxy-groups': [
            {
                name: 'Select',
                type: 'select',
                proxies: ['Germany raw', 'DIRECT'],
                'default-selected': 'Germany raw',
                'empty-fallback': 'Germany raw',
            },
        ],
        rules: ['MATCH,Select'],
    });

    const result = transformMihomoYaml(body, transformOptions({
        groups: { Germany: ['Germany'], Chains: ['Chain'] },
        fastestEnabled: false,
    }));
    const document = YAML.parse(result.body);
    const preserved = document['proxy-groups'].find((group) => group.name === 'Select');
    const chain = document.proxies.find((proxy) => proxy.name === 'Chains · 1');
    assert.deepEqual(preserved.proxies, ['Germany', 'DIRECT']);
    assert.equal(preserved['default-selected'], 'Germany');
    assert.equal(preserved['empty-fallback'], 'Germany · 1');
    assert.equal(chain['dialer-proxy'], 'Germany · 1');
});

test('Mihomo preserves provider-backed automatic groups', () => {
    const body = YAML.stringify({
        'proxy-providers': {
            remote: { type: 'http', url: 'https://example.com/provider.yaml' },
        },
        proxies: [],
        'proxy-groups': [
            { name: '⚡ Авто-переключение', type: 'url-test', use: ['remote'], url: 'https://example.com/ping' },
        ],
        rules: ['MATCH,⚡ Авто-переключение'],
    });

    const result = transformMihomoYaml(body, transformOptions({ groups: {} }));
    const document = YAML.parse(result.body);
    assert.equal(document['proxy-groups'][0].name, '⚡ Авто-переключение');
    assert.deepEqual(document['proxy-groups'][0].use, ['remote']);
    assert.equal(document.rules[0], 'MATCH,⚡ Авто-переключение');
});

test('Mihomo maps roundRobin to a load-balance group', () => {
    const body = YAML.stringify({
        proxies: [
            { name: 'Germany 1', type: 'vless', server: 'de1.example.com', port: 443 },
            { name: 'Germany 2', type: 'vless', server: 'de2.example.com', port: 443 },
        ],
        'proxy-groups': [
            { name: 'PROXY', type: 'select', proxies: ['Germany 1', 'Germany 2'] },
        ],
    });

    const result = transformMihomoYaml(body, transformOptions({ strategy: 'roundRobin' }));
    const document = YAML.parse(result.body);
    const fastest = document['proxy-groups'].find((group) => group.name === '🏁 Самые быстрые');
    assert.equal(fastest.type, 'load-balance');
    assert.equal(fastest.strategy, 'round-robin');
});
