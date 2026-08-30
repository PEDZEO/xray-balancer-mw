'use strict';

function sanitizeTag(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

const MANAGED_FIELDS = new Set(['remarks', 'dns', 'inbounds', 'outbounds', 'routing', 'observatory', 'burstObservatory']);
const NON_INHERITED_FIELDS = new Set(['description', 'serverDescription', 'server_description']);
const SYSTEM_OUTBOUND_PROTOCOLS = new Set(['freedom', 'blackhole', 'dns']);

function stableValueKey(value) {
    return JSON.stringify(value);
}

function mergeUniqueValues(values) {
    const seen = new Set();
    const merged = [];
    for (const value of values) {
        const key = stableValueKey(value);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(structuredClone(value));
    }
    return merged;
}

function mergeDnsConfigs(configs) {
    const dnsConfigs = configs.map((config) => config?.dns).filter((dns) => dns !== undefined);
    if (dnsConfigs.length === 0) return undefined;

    const firstDns = structuredClone(dnsConfigs[0]);
    if (!firstDns || typeof firstDns !== 'object' || Array.isArray(firstDns)) {
        return firstDns;
    }

    const objectConfigs = dnsConfigs.filter((dns) => dns && typeof dns === 'object' && !Array.isArray(dns));
    const servers = objectConfigs.flatMap((dns) => Array.isArray(dns.servers) ? dns.servers : []);
    if (servers.length > 0) firstDns.servers = mergeUniqueValues(servers);

    const hosts = Object.assign({}, ...objectConfigs.map((dns) => (
        dns.hosts && typeof dns.hosts === 'object' && !Array.isArray(dns.hosts) ? dns.hosts : {}
    )).reverse());
    if (Object.keys(hosts).length > 0) firstDns.hosts = hosts;
    return firstDns;
}

function mergeRoutingConfigs(configs) {
    const routingConfigs = configs.map((config) => config?.routing)
        .filter((routing) => routing && typeof routing === 'object' && !Array.isArray(routing));
    if (routingConfigs.length === 0) return undefined;

    const merged = {};
    for (const [key, value] of Object.entries(routingConfigs[0])) {
        if (key !== 'rules' && key !== 'balancers') merged[key] = structuredClone(value);
    }
    merged.rules = mergeUniqueValues(routingConfigs.flatMap((routing) => (
        Array.isArray(routing.rules) ? routing.rules : []
    )));
    return merged;
}

function mergeProfileBaseConfigs(configs) {
    const validConfigs = configs.filter((config) => config && typeof config === 'object' && !Array.isArray(config));
    if (validConfigs.length === 0) return {};

    const merged = structuredClone(validConfigs[0]);
    const mergedOutbounds = Array.isArray(merged.outbounds) ? merged.outbounds : [];
    const seenOutboundTags = new Set(mergedOutbounds.map((outbound) => outbound?.tag).filter(Boolean));
    for (const config of validConfigs.slice(1)) {
        for (const outbound of config.outbounds || []) {
            if (!outbound?.tag || !SYSTEM_OUTBOUND_PROTOCOLS.has(outbound.protocol) || seenOutboundTags.has(outbound.tag)) continue;
            mergedOutbounds.push(structuredClone(outbound));
            seenOutboundTags.add(outbound.tag);
        }
    }
    if (mergedOutbounds.length > 0) merged.outbounds = mergedOutbounds;
    const dns = mergeDnsConfigs(validConfigs);
    const routing = mergeRoutingConfigs(validConfigs);
    if (dns === undefined) delete merged.dns;
    else merged.dns = dns;
    if (routing === undefined) delete merged.routing;
    else merged.routing = routing;
    return merged;
}

function buildSystemOutbounds(baseConfig, reservedTags) {
    const systemOutbounds = [];
    const seenTags = new Set(reservedTags);
    for (const outbound of baseConfig.outbounds || []) {
        if (!outbound?.tag || !SYSTEM_OUTBOUND_PROTOCOLS.has(outbound.protocol) || seenTags.has(outbound.tag)) continue;
        systemOutbounds.push(structuredClone(outbound));
        seenTags.add(outbound.tag);
    }
    if (!seenTags.has('direct')) {
        systemOutbounds.push({ tag: 'direct', protocol: 'freedom' });
        seenTags.add('direct');
    }
    if (!seenTags.has('block')) {
        systemOutbounds.push({ tag: 'block', protocol: 'blackhole' });
    }
    return systemOutbounds;
}

function normalizeProfileRules(rules, availableOutboundTags, balancerTag) {
    const normalized = [];
    for (const sourceRule of rules || []) {
        if (!sourceRule || typeof sourceRule !== 'object' || Array.isArray(sourceRule)) continue;
        const rule = structuredClone(sourceRule);
        if (rule.outboundTag === 'proxy') {
            delete rule.outboundTag;
            rule.balancerTag = balancerTag;
        } else if (typeof rule.outboundTag === 'string') {
            if (!availableOutboundTags.has(rule.outboundTag)) continue;
        } else if (rule.balancerTag !== undefined) {
            continue;
        } else {
            continue;
        }
        normalized.push(rule);
    }
    return mergeUniqueValues(normalized);
}

function buildStrategy(strategy, settings) {
    if (strategy !== 'leastLoad') {
        return { type: strategy };
    }
    return {
        type: strategy,
        settings,
    };
}

function needsObservedFallback(strategy) {
    return strategy === 'leastPing' || strategy === 'leastLoad';
}

function buildGroupConfig(baseConfig, groupName, outbounds, opts) {
    const {
        fallbackOutbounds = [],
        probeConnectivity = '',
        probeHttpMethod = 'HEAD',
        probeUrl,
        probeInterval,
        probeSampling = 1,
        probeTimeout = '3s',
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

    const tags = outbounds.map((outbound) => outbound.tag);
    const fallbackTags = fallbackOutbounds.map((outbound) => outbound.tag);
    const allTags = [...tags, ...fallbackTags];
    const prefix = sanitizeTag(groupName);
    const balancerTag = `${prefix}-balancer`;
    const hasPreferredAndFallback = tags.length > 0 && fallbackTags.length > 0;
    const usesFallbackBalancer = hasPreferredAndFallback && fallbackTags.length > 1;
    const fallbackBalancerTag = `${prefix}-fallback-balancer`;
    const fallbackDispatchTag = `${prefix}-fallback-dispatch`;
    const fallbackInboundTag = `${prefix}-fallback-in`;
    const proxyInboundTag = `${prefix}-proxy-in`;
    const reservedTags = new Set(['proxy', ...allTags, ...(usesFallbackBalancer ? [fallbackDispatchTag] : [])]);
    const systemOutbounds = buildSystemOutbounds(baseConfig, reservedTags);

    const cfg = {
        ...inherited,
        remarks: groupName,
        dns: baseConfig.dns ? structuredClone(baseConfig.dns) : {
            servers: ['1.1.1.1', '1.0.0.1'],
            queryStrategy: 'UseIP',
        },
        inbounds,
        outbounds: [
            {
                tag: 'proxy',
                protocol: 'loopback',
                settings: { inboundTag: proxyInboundTag },
            },
            ...allOutboundsForConfig.map((outbound) => ({ ...outbound })),
            ...(usesFallbackBalancer ? [{
                tag: fallbackDispatchTag,
                protocol: 'loopback',
                settings: { inboundTag: fallbackInboundTag },
            }] : []),
            ...systemOutbounds,
        ],
    };

    cfg.burstObservatory = {
        subjectSelector: allTags,
        pingConfig: {
            destination: probeUrl,
            connectivity: probeConnectivity,
            interval: probeInterval,
            sampling: probeSampling,
            timeout: probeTimeout,
            httpMethod: probeHttpMethod,
        },
    };

    const selector = tags.length > 0 ? tags : fallbackTags;
    const balancer = {
        tag: balancerTag,
        selector,
        strategy: buildStrategy(strategy, hasPreferredAndFallback ? {
            expected: 1,
            baselines: ['1500ms'],
            tolerance: 0.5,
        } : {
            expected: 1,
            baselines: ['1s'],
            tolerance: 0.8,
        }),
    };

    if (hasPreferredAndFallback) {
        balancer.fallbackTag = usesFallbackBalancer ? fallbackDispatchTag : fallbackTags[0];
    } else if (needsObservedFallback(strategy)) {
        // Xray fallbackTag accepts an outbound tag, not another balancer tag.
        balancer.fallbackTag = selector[0];
    }

    const balancers = [balancer];
    if (usesFallbackBalancer) {
        const fallbackBalancer = {
            tag: fallbackBalancerTag,
            selector: fallbackTags,
            strategy: buildStrategy(strategy, {
                expected: 1,
                baselines: ['4s'],
                tolerance: 0.8,
            }),
        };
        if (needsObservedFallback(strategy)) {
            fallbackBalancer.fallbackTag = fallbackTags[0];
        }
        balancers.push(fallbackBalancer);
    }

    const routingBase = {};
    for (const [key, value] of Object.entries(baseConfig.routing || {})) {
        if (key !== 'rules' && key !== 'balancers') routingBase[key] = structuredClone(value);
    }
    const availableOutboundTags = new Set(cfg.outbounds.map((outbound) => outbound.tag));
    const profileRules = normalizeProfileRules(baseConfig.routing?.rules, availableOutboundTags, balancerTag);
    const managedRules = [
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
        { type: 'field', network: 'tcp,udp', balancerTag },
    ];

    cfg.routing = {
        ...routingBase,
        domainStrategy: routingBase.domainStrategy || 'IPIfNonMatch',
        balancers,
        rules: mergeUniqueValues([
            {
                type: 'field',
                inboundTag: [proxyInboundTag],
                balancerTag,
            },
            ...(usesFallbackBalancer ? [{
                type: 'field',
                inboundTag: [fallbackInboundTag],
                balancerTag: fallbackBalancerTag,
            }] : []),
            ...profileRules,
            ...managedRules,
        ]),
    };

    return cfg;
}

module.exports = {
    buildGroupConfig,
    mergeProfileBaseConfigs,
};
