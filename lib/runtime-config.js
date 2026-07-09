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

function resolveFiniteNumberInRange(envValue, configValue, fallback, min, max) {
    const envParsed = parseFiniteNumber(envValue);
    if (envParsed !== null && envParsed >= min && envParsed <= max) return envParsed;
    const configParsed = parseFiniteNumber(configValue);
    if (configParsed !== null && configParsed >= min && configParsed <= max) return configParsed;
    return fallback;
}

function readEffectiveRuntime(config = {}, env = process.env) {
    const probeUrl = config.probe_url || 'https://www.gstatic.com/generate_204';

    return {
        probeInterval: config.probe_interval || '3m',
        fastestProbeUrl: config.fastest_probe_url || probeUrl,
        fastestExcludeGroups: normalizeStringList(config.fastest_exclude_groups),
        fastestFallbackGroups: normalizeStringList(config.fastest_fallback),
        nodeStatsExcludeGroups: normalizeStringList(config.node_stats_exclude),
        expandGroupsToNodes: normalizeStringList(config.expand_groups_to_nodes),
        hiddenGroups: normalizeStringList(config.hidden_groups),
        hiddenNodes: normalizeStringList(config.hidden_nodes),
        quarantineNodes: normalizeStringList(config.quarantine_nodes),
        autoQuarantineNodes: normalizeStringList(config.auto_quarantine_nodes),
        stickyEnabled: resolveBoolean(env.STICKY_ENABLED, config.sticky_enabled),
        stickyMode: config.sticky_mode || 'pin',
        stickyNewConnectionsOnly: resolveBoolean(
            env.STICKY_NEW_CONNECTIONS_ONLY,
            config.sticky_new_connections_only
        ),
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
        balancerSmoothingAlpha: resolveFiniteNumberInRange(
            env.BALANCER_SMOOTHING_ALPHA,
            config.balancer_smoothing_alpha,
            0.35,
            0,
            1
        ),
        balancerHysteresisDelta: resolveFiniteNumber(env.BALANCER_HYSTERESIS_DELTA, config.balancer_hysteresis_delta, 0.08),
    };
}

module.exports = {
    readEffectiveRuntime,
};
