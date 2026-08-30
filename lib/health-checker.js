'use strict';

function createHealthChecker(opts = {}) {
    const maxHistory = Number.isInteger(opts.maxHistory) && opts.maxHistory > 0
        ? opts.maxHistory
        : 10;
    const metricsMap = new Map();

    function normalizeNodeName(nodeName) {
        return String(nodeName || '').trim().toLowerCase();
    }

    function ensureMetrics(nodeName) {
        const key = normalizeNodeName(nodeName);
        if (!key) throw new Error('nodeName is required');
        if (!metricsMap.has(key)) {
            metricsMap.set(key, {
                nodeName: String(nodeName).trim(),
                outcomes: [],
                lastCheckAt: null,
            });
        }
        return metricsMap.get(key);
    }

    function calculateJitter(history) {
        if (history.length < 2) return 0;
        let sumDiff = 0;
        for (let index = 1; index < history.length; index += 1) {
            sumDiff += Math.abs(history[index] - history[index - 1]);
        }
        return Math.round(sumDiff / (history.length - 1));
    }

    function serializeMetrics(metrics) {
        const successfulRtts = metrics.outcomes
            .filter((outcome) => outcome.success && Number.isFinite(outcome.rttMs))
            .map((outcome) => outcome.rttMs);
        const latestRtt = [...metrics.outcomes]
            .reverse()
            .find((outcome) => outcome.success && Number.isFinite(outcome.rttMs));
        const failedCount = metrics.outcomes.filter((outcome) => !outcome.success).length;
        const totalCount = metrics.outcomes.length;

        return {
            nodeName: metrics.nodeName,
            lastRttMs: latestRtt?.rttMs ?? null,
            avgRttMs: successfulRtts.length > 0
                ? Math.round(successfulRtts.reduce((sum, value) => sum + value, 0) / successfulRtts.length)
                : null,
            jitterMs: calculateJitter(successfulRtts),
            lossPercent: totalCount > 0 ? Math.round((failedCount / totalCount) * 100) : 0,
            rstCount: metrics.outcomes.filter((outcome) => outcome.isRst).length,
            throttled: metrics.outcomes.some((outcome) => outcome.throttled),
            partialBlock: metrics.outcomes.some((outcome) => outcome.partialBlock),
            lastCheckAt: metrics.lastCheckAt,
        };
    }

    function recordProbeResult(nodeName, result = {}) {
        const metrics = ensureMetrics(nodeName);
        const rttMs = result.rttMs === null || result.rttMs === undefined
            ? null
            : Number(result.rttMs);
        metrics.lastCheckAt = Number.isFinite(result.checkedAt) ? result.checkedAt : Date.now();
        metrics.outcomes.push({
            success: result.success === true,
            rttMs: Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : null,
            isRst: result.isRst === true,
            throttled: result.throttled === true,
            partialBlock: result.partialBlock === true || result.isPartialBlock === true,
        });
        if (metrics.outcomes.length > maxHistory) {
            metrics.outcomes.splice(0, metrics.outcomes.length - maxHistory);
        }
        return serializeMetrics(metrics);
    }

    function getMetrics(nodeName) {
        const metrics = metricsMap.get(normalizeNodeName(nodeName));
        return metrics ? serializeMetrics(metrics) : null;
    }

    function getAllMetrics() {
        return Object.fromEntries(
            [...metricsMap.entries()].map(([key, metrics]) => [key, serializeMetrics(metrics)]),
        );
    }

    function retainNodes(nodeNames) {
        const active = new Set(nodeNames.map(normalizeNodeName).filter(Boolean));
        for (const key of metricsMap.keys()) {
            if (!active.has(key)) metricsMap.delete(key);
        }
    }

    return {
        recordProbeResult,
        getMetrics,
        getAllMetrics,
        retainNodes,
    };
}

module.exports = {
    createHealthChecker,
};
