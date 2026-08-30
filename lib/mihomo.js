'use strict';

const YAML = require('yaml');
const { matchGroupCandidates } = require('./balancing');

const SYSTEM_PROXY_TYPES = new Set(['direct', 'dns', 'reject', 'pass', 'compatible']);
const KNOWN_AUTO_GROUP_NAMES = new Set([
    '⚡ Авто-переключение',
    '🎲 Любой доступный сервер',
]);

function normalizeName(value) {
    return (value || '').toString().trim().toLowerCase();
}

function uniqueStrings(values) {
    const result = [];
    const seen = new Set();
    for (const value of values || []) {
        if (typeof value !== 'string' || !value.trim()) continue;
        const normalized = normalizeName(value);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(value.trim());
    }
    return result;
}

function collectMihomoProxyCandidates(proxy) {
    const wsHeaders = proxy?.['ws-opts']?.headers || {};
    const grpcOpts = proxy?.['grpc-opts'] || {};
    return uniqueStrings([
        proxy?.name,
        proxy?.server,
        proxy?.sni,
        proxy?.servername,
        proxy?.['server-name'],
        proxy?.host,
        wsHeaders.Host,
        wsHeaders.host,
        grpcOpts['grpc-service-name'],
        grpcOpts.authority,
    ]);
}

function matchMihomoProxyGroup(groups, proxy) {
    const nameMatch = matchGroupCandidates(groups, [proxy?.name]);
    if (nameMatch) return nameMatch;

    const technicalGroups = Object.fromEntries(
        Object.entries(groups || {})
            .map(([groupName, patterns]) => [
                groupName,
                (patterns || []).filter((pattern) => typeof pattern === 'string' && pattern.length > 2),
            ])
            .filter(([, patterns]) => patterns.length > 0)
    );
    return matchGroupCandidates(technicalGroups, collectMihomoProxyCandidates(proxy).slice(1));
}

function isRemoteProxy(proxy) {
    return Boolean(
        proxy
        && typeof proxy === 'object'
        && typeof proxy.name === 'string'
        && proxy.name.trim()
        && !SYSTEM_PROXY_TYPES.has(normalizeName(proxy.type))
    );
}

function applyMihomoCompatibilityFixes(proxy) {
    if (
        normalizeName(proxy?.network) === 'xhttp'
        && Number(proxy?.port) === 80
        && proxy?.tls !== true
        && (!Array.isArray(proxy?.alpn) || proxy.alpn.length === 0)
    ) {
        proxy.alpn = ['http/1.1'];
        return 1;
    }
    return 0;
}

function isFakeMihomoConfig(proxies) {
    const remote = proxies.filter(isRemoteProxy);
    return remote.length > 0 && remote.every((proxy) => (
        String(proxy.server || '') === '0.0.0.0' && Number(proxy.port) === 1
    ));
}

function parseDuration(value, fallback, targetUnit) {
    if (Number.isFinite(value) && value > 0) {
        return Math.max(1, Math.round(value));
    }
    if (typeof value !== 'string') return fallback;
    const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
    if (!match) return fallback;

    const amount = Number(match[1]);
    const unit = (match[2] || targetUnit).toLowerCase();
    const milliseconds = amount * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[unit] || 1);
    return Math.max(1, Math.round(targetUnit === 'ms' ? milliseconds : milliseconds / 1000));
}

function createHealthGroup(name, members, options, probeUrl) {
    const leastPing = options.strategy === 'leastPing';
    const roundRobin = options.strategy === 'roundRobin';
    return {
        name,
        type: leastPing ? 'url-test' : (roundRobin ? 'load-balance' : 'fallback'),
        proxies: members,
        url: probeUrl,
        interval: parseDuration(options.probeInterval, 30, 's'),
        timeout: parseDuration(options.probeTimeout, 3000, 'ms'),
        'max-failed-times': 1,
        lazy: false,
        ...(leastPing ? { tolerance: 50 } : {}),
        ...(roundRobin ? { strategy: 'round-robin' } : {}),
    };
}

function allocateUniqueName(preferred, reserved) {
    let candidate = preferred;
    let suffix = 2;
    while (reserved.has(normalizeName(candidate))) {
        candidate = `${preferred} #${suffix}`;
        suffix += 1;
    }
    reserved.add(normalizeName(candidate));
    return candidate;
}

function replacePolicyInRule(rule, policyRenames) {
    if (typeof rule !== 'string') return rule;
    const parts = rule.split(',');
    if (parts.length < 2) return rule;
    let policyIndex = parts.length - 1;
    if (parts[policyIndex].trim().toLowerCase() === 'no-resolve') policyIndex -= 1;
    if (policyIndex < 1) return rule;
    const policy = parts[policyIndex].trim();
    parts[policyIndex] = policyRenames.get(policy) || parts[policyIndex];
    return parts.join(',');
}

function replacePolicyString(value, policyRenames) {
    if (typeof value !== 'string') return value;
    if (policyRenames.has(value)) return policyRenames.get(value);

    let result = value;
    for (const [oldName, newName] of policyRenames) {
        result = result.replaceAll(`#${oldName}`, `#${newName}`);
    }
    return result;
}

function transformMihomoDocument(document, options = {}) {
    const proxies = Array.isArray(document?.proxies) ? document.proxies : null;
    const proxyGroups = Array.isArray(document?.['proxy-groups']) ? document['proxy-groups'] : null;
    if (!proxies || !proxyGroups) return null;
    if (isFakeMihomoConfig(proxies)) return { kind: 'fake', document };

    const configuredGroups = options.groups && typeof options.groups === 'object' ? options.groups : {};
    const configuredGroupNames = Object.keys(configuredGroups);
    const hiddenGroupSet = new Set((options.hiddenGroups || []).map(normalizeName).filter(Boolean));
    const hiddenNodeSet = new Set((options.hiddenNodes || []).map(normalizeName).filter(Boolean));
    const excludedNodeSet = options.excludedNodes instanceof Set
        ? options.excludedNodes
        : new Set((options.excludedNodes || []).map(normalizeName).filter(Boolean));
    const expandGroupSet = new Set((options.expandGroupsToNodes || []).map(normalizeName).filter(Boolean));
    const fastestExcludeSet = new Set((options.fastestExcludeGroups || []).map(normalizeName).filter(Boolean));
    const fastestFallbackSet = new Set((options.fastestFallbackGroups || []).map(normalizeName).filter(Boolean));
    const fastestEnabled = options.fastestEnabled !== false;
    const fastestName = String(options.fastestName || '🏁 Самые быстрые').trim();
    const otherGroupName = '🌐 Другие серверы';

    const remoteProxies = proxies.filter(isRemoteProxy);
    const compatibilityFixes = remoteProxies.reduce(
        (count, proxy) => count + applyMihomoCompatibilityFixes(proxy),
        0
    );
    const remoteNames = new Set(remoteProxies.map((proxy) => proxy.name));
    const providerBackedAutoGroups = new Set(
        proxyGroups
            .filter((group) => (
                KNOWN_AUTO_GROUP_NAMES.has(group?.name)
                && Array.isArray(group.use)
                && group.use.length > 0
            ))
            .map((group) => group.name)
    );
    const sourceRouteGroupNames = new Set(
        proxyGroups
            .map((group) => group?.name)
            .filter((name) => typeof name === 'string' && !KNOWN_AUTO_GROUP_NAMES.has(name))
            .map(normalizeName)
    );
    const conflictingGroupNames = [fastestName, otherGroupName, ...configuredGroupNames]
        .filter((name) => sourceRouteGroupNames.has(normalizeName(name)));
    if (conflictingGroupNames.length > 0) {
        return { kind: 'conflict', document, conflictingGroupNames };
    }
    const existingRouteGroupNames = new Set(
        proxyGroups
            .map((group) => group?.name)
            .filter((name) => typeof name === 'string' && !KNOWN_AUTO_GROUP_NAMES.has(name) && name !== fastestName)
    );
    const reservedNames = new Set([
        ...proxies.filter((proxy) => !isRemoteProxy(proxy)).map((proxy) => normalizeName(proxy.name)),
        ...[...existingRouteGroupNames].map(normalizeName),
        ...configuredGroupNames.map(normalizeName),
        normalizeName(fastestName),
        normalizeName(otherGroupName),
    ].filter(Boolean));

    const metadata = remoteProxies.map((proxy) => {
        const originalName = proxy.name;
        const groupName = matchMihomoProxyGroup(configuredGroups, proxy);
        const hidden = hiddenNodeSet.has(normalizeName(originalName))
            || excludedNodeSet.has(normalizeName(originalName))
            || (groupName && hiddenGroupSet.has(normalizeName(groupName)));
        return { proxy, originalName, groupName, hidden, publishedName: null };
    });

    const groupOrdinals = new Map();
    const proxyRenames = new Map();
    for (const entry of metadata) {
        if (entry.hidden) continue;
        let preferred = entry.originalName;
        if (entry.groupName) {
            const ordinal = (groupOrdinals.get(entry.groupName) || 0) + 1;
            groupOrdinals.set(entry.groupName, ordinal);
            preferred = `${entry.groupName} · ${ordinal}`;
        }
        entry.publishedName = allocateUniqueName(preferred, reservedNames);
        proxyRenames.set(entry.originalName, entry.publishedName);
        entry.proxy.name = entry.publishedName;
    }

    const keptMetadata = metadata.filter((entry) => !entry.hidden);
    if (remoteProxies.length > 0 && keptMetadata.length === 0) {
        return { kind: 'empty', document, removed: remoteProxies.length };
    }

    document.proxies = proxies.filter((proxy) => !isRemoteProxy(proxy) || metadata.some((entry) => (
        entry.proxy === proxy && !entry.hidden
    )));

    const groupedMembers = new Map(configuredGroupNames.map((name) => [name, []]));
    const unmatchedMembers = [];
    for (const entry of keptMetadata) {
        if (entry.groupName && groupedMembers.has(entry.groupName)) {
            groupedMembers.get(entry.groupName).push(entry.publishedName);
        } else {
            unmatchedMembers.push(entry.publishedName);
        }
    }

    const generatedGroups = [];
    const selectorEntries = [];
    const allPrimaryMembers = [];
    const allFallbackMembers = [];
    for (const groupName of configuredGroupNames) {
        const members = groupedMembers.get(groupName) || [];
        if (members.length === 0 || hiddenGroupSet.has(normalizeName(groupName))) continue;

        if (fastestFallbackSet.has(normalizeName(groupName))) {
            allFallbackMembers.push(...members);
        } else if (!fastestExcludeSet.has(normalizeName(groupName))) {
            allPrimaryMembers.push(...members);
        }

        if (expandGroupSet.has(normalizeName(groupName))) {
            selectorEntries.push(...members);
            continue;
        }

        generatedGroups.push(createHealthGroup(groupName, members, options, options.probeUrl));
        selectorEntries.push(groupName);
    }

    if (unmatchedMembers.length > 0) {
        generatedGroups.push(createHealthGroup(otherGroupName, unmatchedMembers, options, options.probeUrl));
        selectorEntries.push(otherGroupName);
        allPrimaryMembers.push(...unmatchedMembers);
    }

    const fastestMembers = allPrimaryMembers.length > 0 ? allPrimaryMembers : allFallbackMembers;
    let fastestGroup = null;
    if (fastestEnabled && fastestMembers.length > 0) {
        fastestGroup = createHealthGroup(fastestName, fastestMembers, options, options.fastestProbeUrl || options.probeUrl);
    }

    const proxyPolicyTargets = new Map();
    for (const entry of keptMetadata) {
        if (entry.groupName && groupedMembers.get(entry.groupName)?.length > 0) {
            proxyPolicyTargets.set(
                entry.originalName,
                expandGroupSet.has(normalizeName(entry.groupName)) ? entry.publishedName : entry.groupName,
            );
        } else {
            proxyPolicyTargets.set(entry.originalName, otherGroupName);
        }
    }

    const firstPolicy = fastestGroup?.name || selectorEntries[0] || keptMetadata[0]?.publishedName || 'DIRECT';
    const policyRenames = new Map();
    for (const name of KNOWN_AUTO_GROUP_NAMES) {
        if (!providerBackedAutoGroups.has(name)) policyRenames.set(name, firstPolicy);
    }
    if (fastestName !== firstPolicy) policyRenames.set(fastestName, firstPolicy);
    const hiddenProxyRenames = metadata
        .filter((entry) => entry.hidden)
        .map((entry) => [entry.originalName, firstPolicy]);
    const referenceRenames = new Map([...proxyRenames, ...hiddenProxyRenames, ...policyRenames]);

    for (const entry of keptMetadata) {
        const dialerProxy = entry.proxy['dialer-proxy'];
        if (typeof dialerProxy === 'string' && referenceRenames.has(dialerProxy)) {
            entry.proxy['dialer-proxy'] = referenceRenames.get(dialerProxy);
        }
    }

    const preservedGroups = [];
    for (const group of proxyGroups) {
        if (!group || typeof group !== 'object' || typeof group.name !== 'string') continue;
        if ((KNOWN_AUTO_GROUP_NAMES.has(group.name) && !providerBackedAutoGroups.has(group.name))
            || group.name === fastestName) continue;

        const originalMembers = Array.isArray(group.proxies) ? group.proxies : [];
        const nextMembers = [];
        const seen = new Set();
        const addMember = (member) => {
            if (typeof member !== 'string' || !member || seen.has(member)) return;
            seen.add(member);
            nextMembers.push(member);
        };

        for (const member of originalMembers) {
            if (remoteNames.has(member)) {
                addMember(proxyPolicyTargets.get(member) || firstPolicy);
                continue;
            }
            addMember(policyRenames.get(member) || proxyRenames.get(member) || member);
        }

        group.proxies = nextMembers;
        if (typeof group['default-selected'] === 'string') {
            const originalDefault = group['default-selected'];
            const renamedDefault = referenceRenames.get(originalDefault) || originalDefault;
            if (nextMembers.includes(renamedDefault)) {
                group['default-selected'] = renamedDefault;
            } else if (remoteNames.has(originalDefault)) {
                const replacement = proxyPolicyTargets.get(originalDefault) || firstPolicy || nextMembers[0];
                if (replacement) group['default-selected'] = replacement;
                else delete group['default-selected'];
            }
        }
        if (typeof group['empty-fallback'] === 'string') {
            group['empty-fallback'] = referenceRenames.get(group['empty-fallback']) || group['empty-fallback'];
        }
        preservedGroups.push(group);
    }

    document['proxy-groups'] = [
        ...preservedGroups,
        ...(fastestGroup ? [fastestGroup] : []),
        ...generatedGroups,
    ];

    if (Array.isArray(document.rules)) {
        document.rules = document.rules.map((rule) => replacePolicyInRule(rule, referenceRenames));
    }
    if (document['rule-providers'] && typeof document['rule-providers'] === 'object') {
        for (const provider of Object.values(document['rule-providers'])) {
            if (provider && typeof provider === 'object' && typeof provider.proxy === 'string') {
                provider.proxy = referenceRenames.get(provider.proxy) || provider.proxy;
            }
        }
    }
    if (document.dns && typeof document.dns === 'object') {
        for (const key of ['nameserver', 'fallback', 'proxy-server-nameserver', 'direct-nameserver']) {
            if (Array.isArray(document.dns[key])) {
                document.dns[key] = document.dns[key].map((value) => replacePolicyString(value, referenceRenames));
            }
        }
    }

    document.profile = document.profile && typeof document.profile === 'object' ? document.profile : {};
    document.profile['store-selected'] = false;

    return {
        kind: 'mihomo',
        document,
        stats: {
            proxies: keptMetadata.length,
            removed: metadata.length - keptMetadata.length,
            configuredGroups: generatedGroups.length,
            unmatched: unmatchedMembers.length,
            fastest: Boolean(fastestGroup),
            compatibilityFixes,
        },
    };
}

function transformMihomoYaml(body, options = {}) {
    let document;
    try {
        document = YAML.parse(body, {
            maxAliasCount: 50,
            prettyErrors: false,
        });
    } catch {
        return null;
    }

    const result = transformMihomoDocument(document, options);
    if (!result || result.kind !== 'mihomo') return result;
    return {
        ...result,
        body: YAML.stringify(result.document, {
            lineWidth: 0,
        }),
    };
}

module.exports = {
    collectMihomoProxyCandidates,
    isFakeMihomoConfig,
    matchMihomoProxyGroup,
    transformMihomoDocument,
    transformMihomoYaml,
};
