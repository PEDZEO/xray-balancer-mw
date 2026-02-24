'use strict';

function matchGroup(groups, outboundTag) {
    const tagLower = outboundTag.toLowerCase();
    let bestGroup = null;
    let bestLen = 0;

    for (const [groupName, patterns] of Object.entries(groups)) {
        for (const pattern of patterns) {
            const patLower = pattern.toLowerCase();
            if (patLower.length <= 2) {
                const regex = new RegExp(`(?:^|[^a-z])${patLower}(?:$|[^a-z])`);
                if (regex.test(tagLower) && patLower.length > bestLen) {
                    bestGroup = groupName;
                    bestLen = patLower.length;
                }
            } else if (tagLower.includes(patLower) && patLower.length > bestLen) {
                bestGroup = groupName;
                bestLen = patLower.length;
            }
        }
    }
    return bestGroup;
}

function isFakeConfig(configArray) {
    const systemProtocols = new Set(['freedom', 'blackhole', 'dns']);
    let proxyCount = 0;
    let fakeCount = 0;

    for (const cfg of configArray) {
        for (const ob of (cfg.outbounds || [])) {
            if (systemProtocols.has(ob.protocol)) continue;
            if (!ob.tag) continue;
            proxyCount++;

            const addr = ob.settings?.vnext?.[0]?.address || ob.settings?.servers?.[0]?.address || '';
            const port = ob.settings?.vnext?.[0]?.port || ob.settings?.servers?.[0]?.port || null;

            if (addr === '0.0.0.0' && port === 1) {
                fakeCount++;
            }
        }
    }

    return proxyCount > 0 && proxyCount === fakeCount;
}

function getNodeStats(nodeStatsCache, outboundTag) {
    if (nodeStatsCache[outboundTag]) return nodeStatsCache[outboundTag];

    const tagLower = outboundTag.toLowerCase();
    let bestMatch = null;
    let bestLen = 0;

    for (const [nodeName, stats] of Object.entries(nodeStatsCache)) {
        const nameL = nodeName.toLowerCase();
        if (nameL.length < 3) continue;
        if (tagLower.includes(nameL) && nameL.length > bestLen) {
            bestMatch = stats;
            bestLen = nameL.length;
        }
    }

    return bestMatch;
}

function filterAndSortByLoad(outbounds, nodeStatsCache) {
    if (Object.keys(nodeStatsCache).length === 0) return outbounds;

    const withStats = outbounds.map(ob => {
        const stats = getNodeStats(nodeStatsCache, ob.tag);
        return { ob, stats, load: stats ? stats.load : 0.5 };
    });

    const filtered = withStats.filter(({ stats }) => {
        if (!stats) return true;
        if (!stats.isConnected || stats.isDisabled) return false;
        if (stats.load > 1.0) return false;
        return true;
    });

    if (filtered.length === 0) {
        const connected = withStats.filter(({ stats }) => !stats || (stats.isConnected && !stats.isDisabled));
        if (connected.length === 0) return outbounds;
        connected.sort((a, b) => a.load - b.load);
        return connected.map(({ ob }) => ob);
    }

    filtered.sort((a, b) => a.load - b.load);
    return filtered.map(({ ob }) => ob);
}

module.exports = {
    filterAndSortByLoad,
    getNodeStats,
    isFakeConfig,
    matchGroup,
};
