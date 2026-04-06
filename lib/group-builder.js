'use strict';

function sanitizeTag(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

const MANAGED_FIELDS = new Set(['remarks', 'dns', 'inbounds', 'outbounds', 'routing', 'burstObservatory']);
const NON_INHERITED_FIELDS = new Set(['description', 'serverDescription', 'server_description']);

function buildGroupConfig(baseConfig, groupName, outbounds, opts) {
    const {
        fallbackOutbounds = [],
        probeUrl,
        probeInterval,
        strategy,
    } = opts;

    const inherited = {};
    for (const [key, val] of Object.entries(baseConfig)) {
        if (!MANAGED_FIELDS.has(key) && !NON_INHERITED_FIELDS.has(key)) {
            inherited[key] = structuredClone(val);
        }
    }

    const inbounds = baseConfig.inbounds ? structuredClone(baseConfig.inbounds) : [
        {
            tag: 'socks', port: 10808, listen: '127.0.0.1', protocol: 'socks',
            settings: { udp: true, auth: 'noauth' },
            sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] },
        },
        {
            tag: 'http', port: 10809, listen: '127.0.0.1', protocol: 'http',
            settings: { allowTransparent: false },
            sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] },
        },
    ];

    const allOutboundsForConfig = fallbackOutbounds.length > 0
        ? [...outbounds, ...fallbackOutbounds]
        : outbounds;

    const proxyOutbound = structuredClone(allOutboundsForConfig[0]);
    proxyOutbound.tag = 'proxy';

    const cfg = {
        ...inherited,
        remarks: groupName,
        dns: baseConfig.dns ? structuredClone(baseConfig.dns) : {
            servers: ['1.1.1.1', '1.0.0.1'],
            queryStrategy: 'UseIP',
        },
        inbounds,
        outbounds: [
            proxyOutbound,
            ...allOutboundsForConfig.map((outbound) => ({ ...outbound })),
            { tag: 'direct', protocol: 'freedom' },
            { tag: 'block', protocol: 'blackhole' },
        ],
    };

    const tags = outbounds.map((outbound) => outbound.tag);
    const fallbackTags = fallbackOutbounds.map((outbound) => outbound.tag);
    const allTags = [...tags, ...fallbackTags];
    const prefix = sanitizeTag(groupName);

    cfg.burstObservatory = {
        subjectSelector: allTags,
        pingConfig: {
            destination: probeUrl,
            interval: probeInterval,
            sampling: 1,
            timeout: '3s',
        },
    };

    let balancers;
    if (tags.length > 0 && fallbackTags.length > 0) {
        const fallbackRef = fallbackTags.length > 1
            ? `${prefix}-fallback-balancer`
            : fallbackTags[0];

        balancers = [
            {
                tag: `${prefix}-balancer`,
                selector: tags,
                strategy: {
                    type: strategy,
                    settings: {
                        expected: 1,
                        baselines: ['1500ms'],
                        tolerance: 0.5,
                    },
                },
                fallbackTag: fallbackRef,
            },
        ];

        if (fallbackTags.length > 1) {
            balancers.push({
                tag: `${prefix}-fallback-balancer`,
                selector: fallbackTags,
                strategy: {
                    type: strategy,
                    settings: {
                        expected: 1,
                        baselines: ['4s'],
                        tolerance: 0.8,
                    },
                },
            });
        }
    } else {
        const selector = tags.length > 0 ? tags : fallbackTags;
        balancers = [
            {
                tag: `${prefix}-balancer`,
                selector,
                strategy: {
                    type: strategy,
                    settings: {
                        expected: 1,
                        baselines: ['1s'],
                        tolerance: 0.8,
                    },
                },
            },
        ];
    }

    cfg.routing = {
        domainStrategy: 'IPIfNonMatch',
        balancers,
        rules: [
            { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
            { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
            {
                type: 'field',
                domain: [
                    'localhost',
                    'localhost.localdomain',
                    'local',
                    '*.local',
                    '*.localdomain',
                    '*.lan',
                    '*.internal',
                ],
                outboundTag: 'direct',
            },
            {
                type: 'field',
                ip: [
                    '127.0.0.0/8',
                    '10.0.0.0/8',
                    '172.16.0.0/12',
                    '192.168.0.0/16',
                    '169.254.0.0/16',
                    '::1/128',
                    'fc00::/7',
                    'fe80::/10',
                ],
                outboundTag: 'direct',
            },
            { type: 'field', network: 'tcp,udp', balancerTag: `${prefix}-balancer` },
        ],
    };

    return cfg;
}

module.exports = {
    buildGroupConfig,
};
