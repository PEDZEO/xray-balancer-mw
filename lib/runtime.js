'use strict';

function createTokenCache(ttlSec) {
    const ttlMs = ttlSec * 1000;
    const map = new Map();

    function set(token, body, headers = {}) {
        map.set(token, {
            body,
            headers,
            updatedAt: Date.now(),
        });
    }

    function get(token) {
        const item = map.get(token);
        if (!item) return null;
        if ((Date.now() - item.updatedAt) > ttlMs) {
            map.delete(token);
            return null;
        }
        return item;
    }

    function hasFreshAny() {
        const now = Date.now();
        for (const [token, item] of map.entries()) {
            if ((now - item.updatedAt) <= ttlMs) return true;
            map.delete(token);
        }
        return false;
    }

    return { set, get, hasFreshAny };
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

module.exports = {
    createRateLimiter,
    createTokenCache,
};
