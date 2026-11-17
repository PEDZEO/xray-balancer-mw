'use strict';

const YAML = require('yaml');
const { matchGroupCandidates } = require('./balancing');

const SYSTEM_PROXY_TYPES = new Set(['direct', 'dns', 'reject', 'pass', 'compatible']);
const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];
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

function hasDynamicMembers(group) {
    return (Array.isArray(group.use) && group.use.length > 0)
        || group['include-all'] || group['include-all-proxies'] || group['include-all-providers'];
}

function resolveDialerGroups(metadata, proxies, groupsByName) {
    const dialerGroups = new Map();
    const dialer = (entry) => entry.proxy['dialer-proxy'];
    const groupQueue = metadata.filter((entry) => !entry.hidden && typeof dialer(entry) === 'string')
        .map(dialer);
    if (groupQueue.length === 0) return dialerGroups;

    const members = (group) => Array.isArray(group.proxies) ? group.proxies : [];
    const dependencies = new Map();
    const dependents = new Map();
    const roots = new Set(BUILTIN_POLICIES.filter((name) => name !== 'GLOBAL'));
    const connect = (name, targets) => {
        dependencies.set(name, targets);
        for (const target of targets) {
            if (!dependents.has(target)) dependents.set(target, []);
            dependents.get(target).push(name);
        }
    };
    for (const proxy of proxies) {
        if (proxy?.name && !isRemoteProxy(proxy)) roots.add(proxy.name);
    }
    for (const entry of metadata) {
        if (entry.hidden) continue;
        if (typeof dialer(entry) === 'string' && dialer(entry)) connect(entry.originalName, [dialer(entry)]);
        else roots.add(entry.originalName);
    }
    for (const [name, group] of groupsByName) {
        connect(name, members(group));
        if (hasDynamicMembers(group)) roots.add(name);
    }
    function reachableFromRoots() {
        const reachable = new Set(roots);
        for (const target of reachable) {
            for (const dependent of dependents.get(target) || []) reachable.add(dependent);
        }
        return reachable;
    }

    const reachable = reachableFromRoots();
    const wouldLoop = (groupName, target) => {
        const pending = [target];
        const seen = new Set(pending);
        for (const name of pending) {
            if (name === groupName) return true;
            for (const next of dependencies.get(name) || []) {
                if (!reachable.has(next) || seen.has(next)) continue;
                seen.add(next);
                pending.push(next);
            }
        }
        return false;
    };
    for (const name of groupQueue) {
        const group = groupsByName.get(name);
        if (!group || dialerGroups.has(name)) continue;
        const usable = members(group).filter((target) => reachable.has(target) && !wouldLoop(name, target));
        dialerGroups.set(name, usable);
        groupQueue.push(...usable.filter((target) => groupsByName.has(target)));
    }
    for (const [name, usable] of dialerGroups) {
        const kept = new Set(usable);
        for (const removed of dependencies.get(name).filter((target) => !kept.has(target))) {
            dependents.set(removed, dependents.get(removed).filter((dependent) => dependent !== name));
        }
    }
    const publishable = reachableFromRoots();
    for (const entry of metadata) {
        if (!publishable.has(entry.originalName)) entry.hidden = true;
    }
    for (const [name, usable] of dialerGroups) {
        dialerGroups.set(name, usable.filter((member) => publishable.has(member)));
    }
    return dialerGroups;
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
    const metadata = remoteProxies.map((proxy) => {
        const originalName = proxy.name;
        const identity = options.identifyProxy?.(originalName, [{ address: proxy.server, port: proxy.port }]);
        const groupName = identity?.groupName || matchMihomoProxyGroup(configuredGroups, proxy);
        const hidden = hiddenNodeSet.has(normalizeName(originalName))
            || excludedNodeSet.has(normalizeName(originalName)) || identity?.isolated || identity?.quarantined
            || (groupName && hiddenGroupSet.has(normalizeName(groupName)));
        return { proxy, originalName, groupName, hidden, publishedName: null };
    });
    const groupsByName = new Map(proxyGroups.filter((group) => typeof group?.name === 'string')
        .map((group) => [group.name, group]));
    const originalGroupNames = new Map([...groupsByName].map(([name, group]) => [group, name]));
    const dialerGroups = resolveDialerGroups(metadata, proxies, groupsByName);
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
            .filter((name) => typeof name === 'string' && (!KNOWN_AUTO_GROUP_NAMES.has(name) || dialerGroups.has(name)))
            .map(normalizeName)
    );
    const conflictingGroupNames = [fastestName, otherGroupName, ...configuredGroupNames]
        .filter((name) => sourceRouteGroupNames.has(normalizeName(name)));
    const sourceGroupRenames = new Map();
    const conflictingNames = new Set(conflictingGroupNames.map(normalizeName));
    const occupiedSourceNames = new Set([
        ...proxies.map(proxy => normalizeName(proxy?.name)),
        ...proxyGroups.map(group => normalizeName(group?.name)),
        ...[fastestName, otherGroupName, ...configuredGroupNames].map(normalizeName),
    ]);
    for (const group of proxyGroups) {
        if (!conflictingNames.has(normalizeName(group?.name))) continue;
        const oldName = group.name;
        group.name = allocateUniqueName(`${oldName} (panel)`, occupiedSourceNames);
        sourceGroupRenames.set(oldName, group.name);
    }
    const existingRouteGroupNames = new Set(
        proxyGroups
            .map((group) => group?.name)
            .filter((name) => typeof name === 'string'
                && (!KNOWN_AUTO_GROUP_NAMES.has(name) || dialerGroups.has(name) || providerBackedAutoGroups.has(name)))
    );
    const reservedNames = new Set([
        ...proxies.filter((proxy) => !isRemoteProxy(proxy)).map((proxy) => normalizeName(proxy.name)),
        ...[...existingRouteGroupNames].map(normalizeName),
        ...configuredGroupNames.map(normalizeName),
        normalizeName(fastestName),
        normalizeName(otherGroupName),
    ].filter(Boolean));

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

    const keptProxies = new Set(keptMetadata.map((entry) => entry.proxy));
    document.proxies = proxies.filter((proxy) => !isRemoteProxy(proxy) || keptProxies.has(proxy));

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
        const probeUrl = options.fastestProbeUrl || options.probeUrl;
        if (allPrimaryMembers.length > 0 && allFallbackMembers.length > 0) {
            if (options.strategy === 'leastPing' || options.strategy === 'roundRobin') {
                const primaryName = allocateUniqueName(`${fastestName} (primary)`, reservedNames);
                generatedGroups.push(createHealthGroup(primaryName, allPrimaryMembers, options, probeUrl));
                fastestGroup = createHealthGroup(fastestName, [primaryName, ...allFallbackMembers], {
                    ...options, strategy: 'fallback',
                }, probeUrl);
            } else {
                fastestGroup = createHealthGroup(fastestName, [...allPrimaryMembers, ...allFallbackMembers], options, probeUrl);
            }
        } else {
            fastestGroup = createHealthGroup(fastestName, fastestMembers, options, probeUrl);
        }
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
    const policyRenames = new Map(sourceGroupRenames);
    for (const name of KNOWN_AUTO_GROUP_NAMES) {
        if (!providerBackedAutoGroups.has(name) && !dialerGroups.has(name)) policyRenames.set(name, firstPolicy);
    }
    if (fastestName !== firstPolicy && !sourceGroupRenames.has(fastestName)) policyRenames.set(fastestName, firstPolicy);
    const hiddenProxyRenames = metadata
        .filter((entry) => entry.hidden)
        .map((entry) => [entry.originalName, firstPolicy]);
    const referenceRenames = new Map([...proxyRenames, ...hiddenProxyRenames, ...policyRenames]);
    const dialerRenames = new Map([...proxyRenames, ...sourceGroupRenames]);

    for (const entry of keptMetadata) {
        const dialerProxy = entry.proxy['dialer-proxy'];
        if (typeof dialerProxy === 'string' && dialerRenames.has(dialerProxy)) {
            entry.proxy['dialer-proxy'] = dialerRenames.get(dialerProxy);
        }
    }

    const preservedGroups = [];
    for (const group of proxyGroups) {
        if (!group || typeof group !== 'object' || typeof group.name !== 'string') continue;
        const originalName = originalGroupNames.get(group);
        if (dialerGroups.has(originalName)) {
            group.proxies = dialerGroups.get(originalName).map((name) => dialerRenames.get(name) || name);
            const selected = dialerRenames.get(group['default-selected']) || group['default-selected'];
            if (group.proxies.includes(selected)) group['default-selected'] = selected;
            else delete group['default-selected'];
            group['empty-fallback'] = 'REJECT';
            if (group.proxies.length === 0 && !hasDynamicMembers(group)) group.proxies.push('REJECT');
            preservedGroups.push(group);
            continue;
        }
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

    const publishedNames = new Set([
        ...BUILTIN_POLICIES,
        ...document.proxies.map(proxy => proxy.name),
        ...document['proxy-groups'].map(group => group.name),
    ]);
    for (const group of preservedGroups) {
        if (hasDynamicMembers(group)) continue;
        group.proxies = group.proxies.filter(member => {
            if (publishedNames.has(member)) return true;
            referenceRenames.set(member, firstPolicy);
            return false;
        });
        if (group.proxies.length === 0) group.proxies.push(firstPolicy);
        if (group['default-selected'] && !group.proxies.includes(group['default-selected'])) {
            group['default-selected'] = group.proxies[0];
        }
        if (group['empty-fallback'] && !publishedNames.has(group['empty-fallback'])) {
            group['empty-fallback'] = firstPolicy;
        }
    }

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
