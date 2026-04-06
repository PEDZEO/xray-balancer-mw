'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readEffectiveRuntime } = require('../lib/runtime-config');

test('readEffectiveRuntime returns config-driven mutable settings', () => {
    const runtime = readEffectiveRuntime({
        probe_interval: '1m',
        probe_url: 'https://www.gstatic.com/generate_204',
        fastest_probe_url: 'https://ya.ru',
        fastest_exclude_groups: ['🇷🇺 White List'],
        fastest_fallback: [' 🇪🇺 LTE ', '', 42],
        node_stats_exclude: [' 🇷🇺 White List ', '', 7],
        hidden_groups: [' 🇺🇸 USA ', '', 42],
        hidden_nodes: [' Germany-9 ', '', 7],
        quarantine_nodes: [' Pedze ', '', 42, 'DEplay'],
        sticky_enabled: true,
        sticky_mode: 'prefer',
        sticky_new_connections_only: true,
        sticky_ttl_sec: 60,
        sticky_max_entries: 500,
        auto_quarantine_enabled: true,
        auto_quarantine_failures: 5,
        auto_quarantine_release_successes: 3,
        auto_quarantine_max_nodes: 50,
        auto_drain_enabled: true,
        auto_drain_failures: 4,
        auto_drain_release_successes: 3,
        auto_drain_load_threshold: 0.95,
        auto_drain_score_penalty: 0.7,
        balancer_load_weight: 0.5,
        balancer_latency_weight: 0.5,
        balancer_max_latency_ms: 250,
        balancer_smoothing_alpha: 0.25,
        balancer_hysteresis_delta: 0.1,
    }, {});

    assert.equal(runtime.probeInterval, '1m');
    assert.equal(runtime.fastestProbeUrl, 'https://ya.ru');
    assert.deepEqual(runtime.fastestExcludeGroups, ['🇷🇺 White List']);
    assert.deepEqual(runtime.fastestFallbackGroups, ['🇪🇺 LTE']);
    assert.deepEqual(runtime.nodeStatsExcludeGroups, ['🇷🇺 White List']);
    assert.deepEqual(runtime.hiddenGroups, ['🇺🇸 USA']);
    assert.deepEqual(runtime.hiddenNodes, ['Germany-9']);
    assert.deepEqual(runtime.quarantineNodes, ['Pedze', 'DEplay']);
    assert.equal(runtime.stickyEnabled, true);
    assert.equal(runtime.stickyMode, 'prefer');
    assert.equal(runtime.stickyNewConnectionsOnly, true);
    assert.equal(runtime.stickyTtlSec, 60);
    assert.equal(runtime.stickyMaxEntries, 500);
    assert.equal(runtime.autoQuarantineEnabled, true);
    assert.equal(runtime.autoQuarantineFailures, 5);
    assert.equal(runtime.autoQuarantineReleaseSuccesses, 3);
    assert.equal(runtime.autoQuarantineMaxNodes, 50);
    assert.equal(runtime.autoDrainEnabled, true);
    assert.equal(runtime.autoDrainFailures, 4);
    assert.equal(runtime.autoDrainReleaseSuccesses, 3);
    assert.equal(runtime.autoDrainLoadThreshold, 0.95);
    assert.equal(runtime.autoDrainScorePenalty, 0.7);
    assert.equal(runtime.balancerLoadWeight, 0.5);
    assert.equal(runtime.balancerLatencyWeight, 0.5);
    assert.equal(runtime.balancerMaxLatencyMs, 250);
    assert.equal(runtime.balancerSmoothingAlpha, 0.25);
    assert.equal(runtime.balancerHysteresisDelta, 0.1);
});

test('readEffectiveRuntime honors env overrides for mutable settings', () => {
    const runtime = readEffectiveRuntime({
        probe_url: 'https://www.gstatic.com/generate_204',
        sticky_enabled: true,
        sticky_mode: 'prefer',
        sticky_new_connections_only: false,
        sticky_ttl_sec: 60,
        sticky_max_entries: 500,
        auto_quarantine_enabled: false,
        auto_quarantine_failures: 5,
        auto_drain_enabled: true,
        auto_drain_load_threshold: 0.95,
        balancer_load_weight: 0.5,
        balancer_max_latency_ms: 250,
    }, {
        STICKY_ENABLED: 'false',
        STICKY_NEW_CONNECTIONS_ONLY: 'true',
        STICKY_TTL_SEC: '120',
        STICKY_MAX_ENTRIES: '750',
        AUTO_QUARANTINE_ENABLED: 'true',
        AUTO_QUARANTINE_FAILURES: '9',
        AUTO_DRAIN_ENABLED: 'false',
        AUTO_DRAIN_LOAD_THRESHOLD: '0.9',
        BALANCER_LOAD_WEIGHT: '0.7',
        BALANCER_MAX_LATENCY_MS: '200',
    });

    assert.equal(runtime.fastestProbeUrl, 'https://www.gstatic.com/generate_204');
    assert.equal(runtime.stickyEnabled, false);
    assert.equal(runtime.stickyMode, 'prefer');
    assert.equal(runtime.stickyNewConnectionsOnly, true);
    assert.equal(runtime.stickyTtlSec, 120);
    assert.equal(runtime.stickyMaxEntries, 750);
    assert.equal(runtime.autoQuarantineEnabled, true);
    assert.equal(runtime.autoQuarantineFailures, 9);
    assert.equal(runtime.autoDrainEnabled, false);
    assert.equal(runtime.autoDrainLoadThreshold, 0.9);
    assert.equal(runtime.balancerLoadWeight, 0.7);
    assert.equal(runtime.balancerMaxLatencyMs, 200);
});
