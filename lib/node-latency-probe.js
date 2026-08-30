const net = require('node:net');

const DEFAULT_PORT = 443;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CONCURRENCY = 8;

function toPort(value) {
    if (value === null || value === undefined || value === '') return null;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return port;
}

function parseAddress(rawAddress) {
    const value = String(rawAddress || '').trim();
    if (!value) return null;

    if (/^https?:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            return {
                host: url.hostname,
                port: toPort(url.port) || (url.protocol === 'http:' ? 80 : DEFAULT_PORT),
            };
        } catch {
            return null;
        }
    }

    const bracketedIpv6 = value.match(/^\[([^\]]+)](?::(\d+))?$/);
    if (bracketedIpv6) {
        return {
            host: bracketedIpv6[1],
            port: toPort(bracketedIpv6[2]),
        };
    }

    const hostAndPort = value.match(/^([^:]+):(\d+)$/);
    if (hostAndPort) {
        return {
            host: hostAndPort[1],
            port: toPort(hostAndPort[2]),
        };
    }

    return { host: value, port: null };
}

function resolveNodeProbeTarget(node, defaultPort = DEFAULT_PORT) {
    const parsed = parseAddress(node?.address);
    if (!parsed?.host) return null;

    const configuredPort = [
        node?.port,
        node?.serverPort,
        node?.server_port,
        node?.xrayPort,
        node?.xray_port,
    ].map(toPort).find((port) => port !== null);

    return {
        host: parsed.host,
        port: parsed.port || configuredPort || toPort(defaultPort) || DEFAULT_PORT,
    };
}

function parseTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.round(value);
    }

    const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);
    if (!match) return fallback;

    const amount = Number(match[1]);
    const unit = (match[2] || 'ms').toLowerCase();
    const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
    const result = Math.round(amount * multiplier);
    return result > 0 ? result : fallback;
}

function measureTcpLatency(target, options = {}) {
    const timeoutMs = parseTimeoutMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);

    return new Promise((resolve) => {
        const startedAt = process.hrtime.bigint();
        const socket = net.createConnection({ host: target.host, port: target.port });
        let settled = false;

        const finish = (latencyMs) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(latencyMs);
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => {
            const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            finish(Math.max(1, Math.round(elapsedMs)));
        });
        socket.once('timeout', () => finish(null));
        socket.once('error', () => finish(null));
    });
}

function nodeProbeKey(node) {
    return String(node?.uuid || node?.id || node?.name || node?.address || '').trim();
}

async function probeNodeLatencies(nodes, options = {}) {
    const entries = Array.isArray(nodes)
        ? nodes.filter((node) => nodeProbeKey(node) && resolveNodeProbeTarget(node, options.defaultPort))
        : [];
    const concurrency = Math.max(
        1,
        Math.min(entries.length || 1, Number(options.concurrency) || DEFAULT_CONCURRENCY),
    );
    const probe = options.probe || measureTcpLatency;
    const results = new Map();
    let cursor = 0;

    async function worker() {
        while (cursor < entries.length) {
            const index = cursor;
            cursor += 1;
            const node = entries[index];
            const target = resolveNodeProbeTarget(node, options.defaultPort);
            const latencyMs = await probe(target, { timeoutMs: options.timeoutMs });
            results.set(nodeProbeKey(node), Number.isFinite(latencyMs) ? latencyMs : null);
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
}

module.exports = {
    measureTcpLatency,
    nodeProbeKey,
    parseTimeoutMs,
    probeNodeLatencies,
    resolveNodeProbeTarget,
};
