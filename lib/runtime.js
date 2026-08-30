'use strict';

function createTokenCache(ttlSec, maxEntries = 1000, opts = {}) {
    const options = (maxEntries && typeof maxEntries === 'object') ? maxEntries : opts;
    const entryLimit = (maxEntries && typeof maxEntries === 'object')
        ? (Number.isInteger(options.maxEntries) && options.maxEntries >= 0 ? options.maxEntries : 1000)
        : (Number.isInteger(maxEntries) && maxEntries >= 0 ? maxEntries : 1000);
    const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes >= 0
        ? options.maxBytes
        : Infinity;
    const maxItemBytes = Number.isInteger(options.maxItemBytes) && options.maxItemBytes >= 0
        ? options.maxItemBytes
        : Infinity;
    const ttlMs = ttlSec * 1000;
    const map = new Map();
    let totalBytes = 0;

    function valueBytes(value) {
        if (Buffer.isBuffer(value)) return value.length;
        if (typeof value === 'string') return Buffer.byteLength(value);
        let serialized;
        try {
            serialized = JSON.stringify(value);
        } catch {
            serialized = String(value);
        }
        return Buffer.byteLength(serialized === undefined ? String(value) : serialized);
    }

    function itemBytes(body, headers) {
        return valueBytes(body) + valueBytes(headers);
    }

    function deleteEntry(key) {
        const entry = map.get(key);
        if (!entry) return false;
        totalBytes -= entry.bytes;
        map.delete(key);
        return true;
    }

    function touch(key, entry) {
        map.delete(key);
        map.set(key, entry);
    }

    function evictIfNeeded() {
        while (map.size > entryLimit || totalBytes > maxBytes) {
            const oldest = map.keys().next().value;
            deleteEntry(oldest);
        }
    }

    function set(token, body, headers = {}) {
        const bytes = itemBytes(body, headers);
        deleteEntry(token);
        if (bytes > maxItemBytes || bytes > maxBytes || entryLimit <= 0) {
            return;
        }

        const entry = {
            value: {
                body,
                headers,
                updatedAt: Date.now(),
            },
            bytes,
        };
        map.set(token, entry);
        totalBytes += bytes;
        evictIfNeeded();
    }

    function get(token) {
        const entry = map.get(token);
        if (!entry) return null;
        if ((Date.now() - entry.value.updatedAt) > ttlMs) {
            return null;
        }
        touch(token, entry);
        return entry.value;
    }

    function getStale(token, staleSec) {
        const entry = map.get(token);
        if (!entry) return null;
        if ((Date.now() - entry.value.updatedAt) > (staleSec * 1000)) {
            deleteEntry(token);
            return null;
        }
        return entry.value;
    }

    function hasFreshAny() {
        const now = Date.now();
        for (const entry of map.values()) {
            if ((now - entry.value.updatedAt) <= ttlMs) return true;
        }
        return false;
    }

    function clear() {
        const size = map.size;
        map.clear();
        totalBytes = 0;
        return size;
    }

    function size() {
        return map.size;
    }

    function bytes() {
        return totalBytes;
    }

    return { set, get, getStale, hasFreshAny, clear, size, bytes };
}

function createRateLimiter(limitPerMinute, burst10s, opts = {}) {
    const options = (typeof opts === 'number') ? { cleanupIntervalMs: opts } : opts;
    const idleMs = Number.isInteger(options.idleMs) && options.idleMs > 0 ? options.idleMs : 120000;
    const cleanupBatch = Number.isInteger(options.cleanupBatch) && options.cleanupBatch > 0 ? options.cleanupBatch : 200;
    const cleanupIntervalMs = Number.isInteger(options.cleanupIntervalMs) && options.cleanupIntervalMs > 0
        ? options.cleanupIntervalMs
        : 10000;
    const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries >= 0
        ? options.maxEntries
        : Infinity;
    const ipMap = new Map();
    let lastCleanupAt = 0;
    let cleanupCursor = ipMap.entries();

    function nextCleanupEntry() {
        let next = cleanupCursor.next();
        if (next.done) {
            cleanupCursor = ipMap.entries();
            next = cleanupCursor.next();
        }
        return next;
    }

    function cleanup(now, force = false) {
        if (!force && (now - lastCleanupAt) < cleanupIntervalMs) return;
        lastCleanupAt = now;
        let scanned = 0;
        while (scanned < cleanupBatch && ipMap.size > 0) {
            const next = nextCleanupEntry();
            if (next.done) break;
            const [ip, entry] = next.value;
            if ((now - entry.lastSeen) > idleMs) {
                ipMap.delete(ip);
            }
            scanned += 1;
        }
    }

    function allow(ip, now = Date.now()) {
        cleanup(now);

        let entry = ipMap.get(ip);
        if (!entry) {
            if (maxEntries <= 0) return false;
            if (ipMap.size >= maxEntries) cleanup(now, true);
            if (ipMap.size >= maxEntries) return false;
            entry = { minHits: [], burstHits: [], lastSeen: now };
        }
        entry.lastSeen = now;

        entry.minHits = entry.minHits.filter(ts => (now - ts) < 60000);
        entry.burstHits = entry.burstHits.filter(ts => (now - ts) < 10000);

        if (entry.minHits.length >= limitPerMinute || entry.burstHits.length >= burst10s) {
            ipMap.set(ip, entry);
            return false;
        }

        entry.minHits.push(now);
        entry.burstHits.push(now);
        ipMap.set(ip, entry);
        return true;
    }

    function size() {
        return ipMap.size;
    }

    return { allow, size };
}

function createCircuitBreaker(failuresThreshold, openSec, opts = {}) {
    const clock = typeof opts.now === 'function' ? opts.now : Date.now;
    const halfOpenLeaseMs = Number.isInteger(opts.halfOpenLeaseMs) && opts.halfOpenLeaseMs > 0
        ? opts.halfOpenLeaseMs
        : Math.max(1000, openSec * 1000);
    let failures = 0;
    let openUntil = 0;
    let state = 'CLOSED';
    let halfOpenProbeUntil = 0;

    function now() {
        return clock();
    }

    function refreshState(current) {
        if (state === 'OPEN' && current >= openUntil) {
            state = 'HALF_OPEN';
            halfOpenProbeUntil = 0;
        }
    }

    function openCircuit(current) {
        state = 'OPEN';
        openUntil = current + (openSec * 1000);
        halfOpenProbeUntil = 0;
        failures = 0;
    }

    function allowRequest() {
        const current = now();
        refreshState(current);
        if (state === 'CLOSED') return true;
        if (state === 'OPEN') return false;
        if (halfOpenProbeUntil > current) return false;
        halfOpenProbeUntil = current + halfOpenLeaseMs;
        return true;
    }

    function recordSuccess() {
        failures = 0;
        openUntil = 0;
        halfOpenProbeUntil = 0;
        state = 'CLOSED';
    }

    function recordFailure() {
        const current = now();
        refreshState(current);
        if (state !== 'CLOSED') {
            openCircuit(current);
            return;
        }
        failures += 1;
        if (failures >= failuresThreshold) {
            openCircuit(current);
        }
    }

    function cancelProbe() {
        if (state === 'HALF_OPEN') halfOpenProbeUntil = 0;
    }

    function status() {
        const current = now();
        refreshState(current);
        return {
            state,
            open: state === 'OPEN',
            half_open_probe_in_flight: state === 'HALF_OPEN' && halfOpenProbeUntil > current,
            failures,
            open_until_ms: openUntil,
            remaining_open_ms: Math.max(0, openUntil - current),
        };
    }

    return {
        allowRequest,
        cancelProbe,
        recordSuccess,
        recordFailure,
        status,
    };
}

function createCircuitBreakerRegistry(failuresThreshold, openSec, opts = {}) {
    const maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : 64;
    const breakers = new Map();

    function normalizeKey(key) {
        const normalized = String(key || 'default').trim();
        return normalized || 'default';
    }

    function getBreaker(key) {
        const normalized = normalizeKey(key);
        let breaker = breakers.get(normalized);
        if (breaker) return breaker;
        if (breakers.size >= maxEntries) {
            const closedEntry = [...breakers.entries()].find(([, candidate]) => candidate.status().state === 'CLOSED');
            const evictKey = closedEntry?.[0] || breakers.keys().next().value;
            breakers.delete(evictKey);
        }
        breaker = createCircuitBreaker(failuresThreshold, openSec, opts);
        breakers.set(normalized, breaker);
        return breaker;
    }

    function status(key) {
        if (key !== undefined) return getBreaker(key).status();
        const upstreams = Object.fromEntries(
            [...breakers.entries()].map(([entryKey, breaker]) => [entryKey, breaker.status()])
        );
        const values = Object.values(upstreams);
        return {
            state: values.some((item) => item.state === 'OPEN')
                ? 'OPEN'
                : (values.some((item) => item.state === 'HALF_OPEN') ? 'HALF_OPEN' : 'CLOSED'),
            open: values.some((item) => item.state === 'OPEN'),
            upstreams,
        };
    }

    return {
        allowRequest: (key) => getBreaker(key).allowRequest(),
        cancelProbe: (key) => getBreaker(key).cancelProbe(),
        recordFailure: (key) => getBreaker(key).recordFailure(),
        recordSuccess: (key) => getBreaker(key).recordSuccess(),
        status,
        size: () => breakers.size,
    };
}

function createKeyedRateLimiter(limitPerMinute, burst10s, opts = {}) {
    const options = (typeof opts === 'number') ? { idleMs: opts } : opts;
    const idleMs = Number.isInteger(options.idleMs) && options.idleMs > 0 ? options.idleMs : 120000;
    const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 5000;
    const cleanupBatch = Number.isInteger(options.cleanupBatch) && options.cleanupBatch > 0 ? options.cleanupBatch : 200;
    const cleanupIntervalMs = Number.isInteger(options.cleanupIntervalMs) && options.cleanupIntervalMs > 0
        ? options.cleanupIntervalMs
        : 10000;
    const limiters = new Map();
    let lastCleanupAt = 0;
    let cleanupCursor = limiters.entries();

    function nextCleanupEntry() {
        let next = cleanupCursor.next();
        if (next.done) {
            cleanupCursor = limiters.entries();
            next = cleanupCursor.next();
        }
        return next;
    }

    function cleanup(now, force = false) {
        if (!force && (now - lastCleanupAt) < cleanupIntervalMs) return;
        lastCleanupAt = now;
        let scanned = 0;
        while (scanned < cleanupBatch && limiters.size > 0) {
            const next = nextCleanupEntry();
            if (next.done) break;
            const [key, item] = next.value;
            if ((now - item.lastSeen) > idleMs) {
                limiters.delete(key);
            }
            scanned += 1;
        }
    }

    function allow(key, now = Date.now()) {
        cleanup(now);
        let entry = limiters.get(key);
        if (!entry) {
            if (maxEntries <= 0) return false;
            if (limiters.size >= maxEntries) cleanup(now, true);
            if (limiters.size >= maxEntries) return false;
            entry = { limiter: createRateLimiter(limitPerMinute, burst10s), lastSeen: now };
            limiters.set(key, entry);
        }
        entry.lastSeen = now;
        return entry.limiter.allow(key, now);
    }

    function size() {
        return limiters.size;
    }

    return { allow, size };
}

module.exports = {
    createCircuitBreaker,
    createCircuitBreakerRegistry,
    createKeyedRateLimiter,
    createRateLimiter,
    createTokenCache,
};
