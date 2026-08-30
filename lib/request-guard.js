'use strict';

function createRequestGuard(opts) {
    const {
        ipLimiter,
        tokenLimiter,
        circuitBreaker,
        stats,
    } = opts;

    function evaluateRateLimits(ip, token) {
        if (!ipLimiter.allow(ip)) {
            stats.rate_limited_ip_total += 1;
            return { ok: false, status: 429, code: 'RATE_LIMITED', allowFallback: false };
        }

        if (!tokenLimiter.allow(token)) {
            stats.rate_limited_token_total += 1;
            return { ok: false, status: 429, code: 'TOKEN_RATE_LIMITED', allowFallback: false };
        }

        return { ok: true };
    }

    function evaluateCircuit(upstreamKey) {
        if (!circuitBreaker.allowRequest(upstreamKey)) {
            stats.circuit_open_total += 1;
            return { ok: false, status: 503, code: 'UPSTREAM_CIRCUIT_OPEN', allowFallback: true };
        }

        return { ok: true };
    }

    function evaluate(ip, token, upstreamKey) {
        const rateDecision = evaluateRateLimits(ip, token);
        return rateDecision.ok ? evaluateCircuit(upstreamKey) : rateDecision;
    }

    return {
        evaluate,
        evaluateCircuit,
        evaluateRateLimits,
    };
}

module.exports = {
    createRequestGuard,
};
