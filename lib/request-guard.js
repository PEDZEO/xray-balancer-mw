'use strict';

function createRequestGuard(opts) {
    const {
        ipLimiter,
        tokenLimiter,
        circuitBreaker,
        stats,
    } = opts;

    function evaluate(ip, token) {
        if (!ipLimiter.allow(ip)) {
            stats.rate_limited_ip_total += 1;
            return { ok: false, status: 429, code: 'RATE_LIMITED', allowFallback: false };
        }

        if (!tokenLimiter.allow(token)) {
            stats.rate_limited_token_total += 1;
            return { ok: false, status: 429, code: 'TOKEN_RATE_LIMITED', allowFallback: false };
        }

        if (!circuitBreaker.allowRequest()) {
            stats.circuit_open_total += 1;
            return { ok: false, status: 503, code: 'UPSTREAM_CIRCUIT_OPEN', allowFallback: true };
        }

        return { ok: true };
    }

    return {
        evaluate,
    };
}

module.exports = {
    createRequestGuard,
};
