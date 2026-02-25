'use strict';

function createTokenCache(ttlSec, maxEntries = 1000) {
    const ttlMs = ttlSec * 1000;
    const map = new Map();

    function touch(key, value) {
        map.delete(key);
        map.set(key, value);
    }

    function evictIfNeeded() {
        while (map.size > maxEntries) {
            const oldest = map.keys().next().value;
            map.delete(oldest);
        }
    }

    function set(token, body, headers = {}) {
        const item = {
            body,
            headers,
            updatedAt: Date.now(),
        };
        touch(token, item);
        evictIfNeeded();
    }

    function get(token) {
        const item = map.get(token);
        if (!item) return null;
        if ((Date.now() - item.updatedAt) > ttlMs) {
            return null;
        }
        touch(token, item);
        return item;
    }

    function getStale(token, staleSec) {
        const item = map.get(token);
        if (!item) return null;
        if ((Date.now() - item.updatedAt) > (staleSec * 1000)) {
            map.delete(token);
            return null;
        }
        return item;
    }

    function hasFreshAny() {
        const now = Date.now();
        for (const item of map.values()) {
            if ((now - item.updatedAt) <= ttlMs) return true;
        }
        return false;
    }

    return { set, get, getStale, hasFreshAny };
}

function createRateLimiter(limitPerMinute, burst10s, opts = {}) {
    const options = (typeof opts === 'number') ? { cleanupIntervalMs: opts } : opts;
    const idleMs = Number.isInteger(options.idleMs) && options.idleMs > 0 ? options.idleMs : 120000;
    const cleanupBatch = Number.isInteger(options.cleanupBatch) && options.cleanupBatch > 0 ? options.cleanupBatch : 200;
    const cleanupIntervalMs = Number.isInteger(options.cleanupIntervalMs) && options.cleanupIntervalMs > 0
        ? options.cleanupIntervalMs
        : 10000;
    const ipMap = new Map();
    let lastCleanupAt = 0;

    function cleanup(now) {
        if ((now - lastCleanupAt) < cleanupIntervalMs) return;
        lastCleanupAt = now;
        let scanned = 0;
        for (const [ip, entry] of ipMap.entries()) {
            if ((now - entry.lastSeen) > idleMs) {
                ipMap.delete(ip);
            }
            scanned += 1;
            if (scanned >= cleanupBatch) break;
        }
    }

    function allow(ip, now = Date.now()) {
        cleanup(now);

        const entry = ipMap.get(ip) || { minHits: [], burstHits: [], lastSeen: now };
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

    return { allow };
}

function createCircuitBreaker(failuresThreshold, openSec) {
    let failures = 0;
    let openUntil = 0;

    function now() {
        return Date.now();
    }

    function allowRequest() {
        return now() >= openUntil;
    }

    function recordSuccess() {
        failures = 0;
        openUntil = 0;
    }

    function recordFailure() {
        failures += 1;
        if (failures >= failuresThreshold) {
            openUntil = now() + (openSec * 1000);
            failures = 0;
        }
    }

    function status() {
        const current = now();
        return {
            open: current < openUntil,
            open_until_ms: openUntil,
            remaining_open_ms: Math.max(0, openUntil - current),
        };
    }

    return {
        allowRequest,
        recordSuccess,
        recordFailure,
        status,
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

    function cleanup(now) {
        if ((now - lastCleanupAt) < cleanupIntervalMs) return;
        lastCleanupAt = now;
        let scanned = 0;
        for (const [key, item] of limiters.entries()) {
            if ((now - item.lastSeen) > idleMs) {
                limiters.delete(key);
            }
            scanned += 1;
            if (scanned >= cleanupBatch) break;
        }
    }

    function allow(key, now = Date.now()) {
        cleanup(now);
        let entry = limiters.get(key);
        if (!entry) {
            if (limiters.size >= maxEntries) {
                const oldest = limiters.keys().next().value;
                limiters.delete(oldest);
            }
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
    createKeyedRateLimiter,
    createRateLimiter,
    createTokenCache,
};
