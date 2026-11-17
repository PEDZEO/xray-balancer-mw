'use strict';

function normalizeName(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeAddress(value) {
    return normalizeName(value).replace(/^\[|\]$|\.$/g, '');
}

function endpointKey(address, port) {
    const host = normalizeAddress(address);
    const number = Number(port);
    return host && Number.isInteger(number) && number > 0 ? JSON.stringify([host, number]) : null;
}

function outboundEndpoints(outbound) {
    const settings = outbound.settings || {};
    return [
        ...(Array.isArray(settings.vnext) ? settings.vnext : []),
        ...(Array.isArray(settings.servers) ? settings.servers : []),
        ...(Array.isArray(settings.peers) ? settings.peers : []).map((peer) => {
            const match = /^(.+):(\d+)$/.exec(peer?.endpoint || '');
            return match && { address: match[1], port: match[2] };
        }),
        settings,
    ].filter((endpoint) => endpoint?.address);
}

function addToIndex(index, key, item) {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(item);
}

function readHostNodeIds(host) {
    return [...new Set((Array.isArray(host?.nodes) ? host.nodes : [])
        .map((node) => normalizeName(typeof node === 'string' ? node : (node?.uuid || node?.id)))
        .filter(Boolean))].sort();
}

function createSubscriptionIdentity({ hosts, groupHosts, groupOrder, nodes, quarantine, protectedNodes }) {
    const hostsByName = new Map();
    const groupByHostId = new Map();
    const nodesById = new Map();
    const nodesByName = new Map();
    const nodesByAddress = new Map();
    const protectedIds = new Set();
    const protectedNames = new Set();
    const legacyProtectedNames = new Set();

    for (const host of hosts) addToIndex(hostsByName, normalizeName(host.remark), host);
    for (const group of groupOrder) {
        for (const hostId of groupHosts[group] || []) {
            const id = normalizeName(hostId);
            if (!groupByHostId.has(id)) groupByHostId.set(id, group);
        }
    }
    for (const node of nodes) {
        if (node.id) nodesById.set(node.id, node);
        addToIndex(nodesByName, node.name, node);
        addToIndex(nodesByAddress, node.address, node);
    }
    for (const node of protectedNodes) {
        const id = normalizeName(node.nodeId);
        if (id) protectedIds.add(id);
        else legacyProtectedNames.add(node.normalizedNode);
        protectedNames.add(node.normalizedNode);
    }

    return (name, endpoints) => {
        const label = normalizeName(name);
        const keys = new Set(endpoints.map(({ address, port }) => endpointKey(address, port)).filter(Boolean));
        const hostsWithName = hostsByName.get(label) || [];
        const matchingHosts = hostsWithName.filter((host) => keys.has(endpointKey(host.address, host.port)));
        let host = matchingHosts.length === 1 ? matchingHosts[0] : null;
        if (!host && hostsWithName.length === 1) {
            const [onlyHost] = hostsWithName;
            if (!keys.size || !endpointKey(onlyHost.address, onlyHost.port)) host = onlyHost;
        }
        const groupName = host && !host.is_disabled ? groupByHostId.get(normalizeName(host.uuid)) : undefined;
        const addressMatches = [...new Set(endpoints.flatMap(({ address }) => (
            nodesByAddress.get(normalizeAddress(address)) || []
        )))];

        let candidates = addressMatches;
        if (host?.nodeIds.length) {
            const hostIds = new Set(host.nodeIds);
            const matchingNodes = addressMatches.filter((node) => hostIds.has(node.id));
            candidates = matchingNodes.length > 0 ? matchingNodes : host.nodeIds.map((id) => (
                nodesById.get(id) || { id, name: '' }
            ));
        } else if (candidates.length === 0) {
            candidates = nodesByName.get(label) || [];
        }

        const quarantined = quarantine.has(label) || candidates.some((node) => quarantine.has(node.name));
        const isolated = legacyProtectedNames.has(label)
            || (candidates.every((node) => !node.id) && protectedNames.has(label))
            || candidates.some(({ id, name: nodeName }) => (
                protectedIds.has(id) || (!id && protectedNames.has(nodeName)) || legacyProtectedNames.has(nodeName)
            ));
        return { groupName, quarantined, isolated };
    };
}

module.exports = { createSubscriptionIdentity, normalizeName, normalizeAddress, outboundEndpoints, readHostNodeIds };
