'use strict';

function parsePositiveInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveBoolean(envValue, configValue) {
    if (envValue === 'true') return true;
    if (envValue === 'false') return false;
    return configValue === true;
}

function normalizeStringList(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolvePositiveInt(envValue, configValue, fallback) {
    return parsePositiveInt(envValue) ?? parsePositiveInt(configValue) ?? fallback;
}

function resolveFiniteNumber(envValue, configValue, fallback) {
    return parseFiniteNumber(envValue) ?? parseFiniteNumber(configValue) ?? fallback;
}

function readEffectiveRuntime(config = {}, env = process.env) {
    const probeUrl = config.probe_url || 'https://www.gstatic.com/generate_204';

    return {
        probeInterval: config.probe_interval || '3m',
        fastestProbeUrl: config.fastest_probe_url || probeUrl,
        fastestExcludeGroups: Array.isArray(config.fastest_exclude_groups) ? config.fastest_exclude_groups : [],
        quarantineNodes: normalizeStringList(config.quarantine_nodes),
        stickyEnabled: resolveBoolean(env.STICKY_ENABLED, config.sticky_enabled),
        stickyMode: config.sticky_mode || 'pin',
        stickyTtlSec: resolvePositiveInt(env.STICKY_TTL_SEC, config.sticky_ttl_sec, 3600),
        stickyMaxEntries: resolvePositiveInt(env.STICKY_MAX_ENTRIES, config.sticky_max_entries, 10000),
        autoQuarantineEnabled: resolveBoolean(env.AUTO_QUARANTINE_ENABLED, config.auto_quarantine_enabled),
        autoQuarantineFailures: resolvePositiveInt(env.AUTO_QUARANTINE_FAILURES, config.auto_quarantine_failures, 3),
        autoQuarantineReleaseSuccesses: resolvePositiveInt(
            env.AUTO_QUARANTINE_RELEASE_SUCCESSES,
            config.auto_quarantine_release_successes,
            2
        ),
        autoQuarantineMaxNodes: resolvePositiveInt(env.AUTO_QUARANTINE_MAX_NODES, config.auto_quarantine_max_nodes, 100),
        autoDrainEnabled: resolveBoolean(env.AUTO_DRAIN_ENABLED, config.auto_drain_enabled),
        autoDrainFailures: resolvePositiveInt(env.AUTO_DRAIN_FAILURES, config.auto_drain_failures, 2),
        autoDrainReleaseSuccesses: resolvePositiveInt(
            env.AUTO_DRAIN_RELEASE_SUCCESSES,
            config.auto_drain_release_successes,
            2
        ),
        autoDrainLoadThreshold: resolveFiniteNumber(env.AUTO_DRAIN_LOAD_THRESHOLD, config.auto_drain_load_threshold, 0.85),
        autoDrainScorePenalty: resolveFiniteNumber(env.AUTO_DRAIN_SCORE_PENALTY, config.auto_drain_score_penalty, 0.6),
        balancerLoadWeight: resolveFiniteNumber(env.BALANCER_LOAD_WEIGHT, config.balancer_load_weight, 0.4),
        balancerLatencyWeight: resolveFiniteNumber(env.BALANCER_LATENCY_WEIGHT, config.balancer_latency_weight, 0.6),
        balancerMaxLatencyMs: resolvePositiveInt(env.BALANCER_MAX_LATENCY_MS, config.balancer_max_latency_ms, 300),
        balancerSmoothingAlpha: resolveFiniteNumber(env.BALANCER_SMOOTHING_ALPHA, config.balancer_smoothing_alpha, 0.35),
        balancerHysteresisDelta: resolveFiniteNumber(env.BALANCER_HYSTERESIS_DELTA, config.balancer_hysteresis_delta, 0.08),
    };
}

module.exports = {
    readEffectiveRuntime,
};
