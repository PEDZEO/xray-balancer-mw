'use strict';

function sanitizeTag(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

const MANAGED_FIELDS = new Set(['remarks', 'dns', 'inbounds', 'outbounds', 'routing', 'burstObservatory']);

function buildGroupConfig(baseConfig, groupName, outbounds, opts) {
    const {
        probeUrl,
        probeInterval,
        strategy,
    } = opts;

    const inherited = {};
    for (const [key, val] of Object.entries(baseConfig)) {
        if (!MANAGED_FIELDS.has(key)) {
            inherited[key] = structuredClone(val);
        }
    }

    const cfg = {
        ...inherited,
        remarks: groupName,
        dns: baseConfig.dns ? structuredClone(baseConfig.dns) : {
            servers: ['1.1.1.1', '1.0.0.1'],
            queryStrategy: 'UseIP',
        },
        inbounds: baseConfig.inbounds ? structuredClone(baseConfig.inbounds) : [
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
        ],
        outbounds: [
            ...outbounds.map((outbound) => ({ ...outbound })),
            { tag: 'direct', protocol: 'freedom' },
            { tag: 'block', protocol: 'blackhole' },
        ],
    };

    const tags = outbounds.map(o => o.tag);
    const prefix = sanitizeTag(groupName);

    cfg.burstObservatory = {
        subjectSelector: tags,
        pingConfig: {
            destination: probeUrl,
            interval: probeInterval,
            sampling: 3,
            timeout: '2s',
            httpMethod: 'GET',
        },
    };

    cfg.routing = {
        domainStrategy: 'IPIfNonMatch',
        balancers: [
            {
                tag: `${prefix}-balancer`,
                selector: tags,
                strategy: {
                    type: strategy,
                    settings: {
                        expected: 1,
                        baselines: ['1s'],
                        tolerance: 0.8,
                    },
                },
            },
        ],
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
