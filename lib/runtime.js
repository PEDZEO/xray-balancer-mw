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
        touch(token, item);
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

function createRateLimiter(limitPerMinute, burst10s) {
    const ipMap = new Map();

    function cleanup(now) {
        for (const [ip, entry] of ipMap.entries()) {
            if ((now - entry.lastSeen) > 120000) {
                ipMap.delete(ip);
            }
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

function createKeyedRateLimiter(limitPerMinute, burst10s, idleMs = 120000) {
    const limiters = new Map();

    function cleanup(now) {
        for (const [key, item] of limiters.entries()) {
            if ((now - item.lastSeen) > idleMs) {
                limiters.delete(key);
            }
        }
    }

    function allow(key, now = Date.now()) {
        cleanup(now);
        let entry = limiters.get(key);
        if (!entry) {
            entry = { limiter: createRateLimiter(limitPerMinute, burst10s), lastSeen: now };
            limiters.set(key, entry);
        }
        entry.lastSeen = now;
        return entry.limiter.allow(key, now);
    }

    return { allow };
}

module.exports = {
    createCircuitBreaker,
    createKeyedRateLimiter,
    createRateLimiter,
    createTokenCache,
};
