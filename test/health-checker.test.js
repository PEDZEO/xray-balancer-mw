'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthChecker } = require('../lib/health-checker');

test('health-checker initializes and records probe results', () => {
    const checker = createHealthChecker({ targets: ['https://www.gstatic.com/generate_204'] });
    
    const r1 = checker.recordProbeResult('Node-1', { success: true, rttMs: 40 });
    assert.equal(r1.nodeName, 'Node-1');
    assert.equal(r1.lastRttMs, 40);
    assert.equal(r1.lossPercent, 0);

    const r2 = checker.recordProbeResult('Node-1', { success: false, isRst: true, isPartialBlock: true });
    assert.equal(r2.rstCount, 1);
    assert.equal(r2.partialBlock, true);
    assert.equal(r2.lossPercent, 50);
});

test('health-checker calculates jitter across multiple probes', () => {
    const checker = createHealthChecker();
    checker.recordProbeResult('Node-2', { success: true, rttMs: 50 });
    checker.recordProbeResult('Node-2', { success: true, rttMs: 70 });
    checker.recordProbeResult('Node-2', { success: true, rttMs: 40 });

    const m = checker.getMetrics('Node-2');
    assert.equal(m.avgRttMs, 53);
    assert.ok(m.jitterMs > 0);
});

test('health-checker clears transient penalties outside the bounded window', () => {
    const checker = createHealthChecker({ maxHistory: 2 });
    checker.recordProbeResult('Node-3', {
        success: false,
        isRst: true,
        throttled: true,
        partialBlock: true,
    });
    checker.recordProbeResult('Node-3', { success: true, rttMs: 30 });

    const degraded = checker.getMetrics('Node-3');
    assert.equal(degraded.lossPercent, 50);
    assert.equal(degraded.rstCount, 1);
    assert.equal(degraded.throttled, true);
    assert.equal(degraded.partialBlock, true);

    checker.recordProbeResult('Node-3', { success: true, rttMs: 20 });
    const recovered = checker.getMetrics('Node-3');
    assert.equal(recovered.lossPercent, 0);
    assert.equal(recovered.rstCount, 0);
    assert.equal(recovered.throttled, false);
    assert.equal(recovered.partialBlock, false);
});

test('health-checker removes metrics for nodes missing from the panel', () => {
    const checker = createHealthChecker();
    checker.recordProbeResult('Node-4', { success: true, rttMs: 10 });
    checker.recordProbeResult('Node-5', { success: true, rttMs: 20 });

    checker.retainNodes(['Node-5']);

    assert.equal(checker.getMetrics('Node-4'), null);
    assert.equal(checker.getMetrics('Node-5').lastRttMs, 20);
});

test('health-checker does not turn missing latency into a zero RTT', () => {
    const checker = createHealthChecker();
    const metrics = checker.recordProbeResult('Node-6', { success: true, rttMs: null });

    assert.equal(metrics.lastRttMs, null);
    assert.equal(metrics.avgRttMs, null);
});
