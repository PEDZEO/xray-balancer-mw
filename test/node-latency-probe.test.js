const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const {
    measureTcpLatency,
    nodeProbeKey,
    parseTimeoutMs,
    probeNodeLatencies,
    resolveNodeProbeTarget,
} = require('../lib/node-latency-probe');

test('resolveNodeProbeTarget supports panel addresses and explicit ports', () => {
    assert.deepEqual(resolveNodeProbeTarget({ address: 'nl.example.com' }), {
        host: 'nl.example.com',
        port: 443,
    });
    assert.deepEqual(resolveNodeProbeTarget({ address: 'http://edge.example.com/status' }), {
        host: 'edge.example.com',
        port: 80,
    });
    assert.deepEqual(resolveNodeProbeTarget({ address: '[2001:db8::1]:8443' }), {
        host: '2001:db8::1',
        port: 8443,
    });
    assert.deepEqual(resolveNodeProbeTarget({ address: 'edge.example.com', port: 2053 }), {
        host: 'edge.example.com',
        port: 2053,
    });
});

test('parseTimeoutMs handles admin duration values', () => {
    assert.equal(parseTimeoutMs('500ms'), 500);
    assert.equal(parseTimeoutMs('3s'), 3000);
    assert.equal(parseTimeoutMs('1m'), 60_000);
    assert.equal(parseTimeoutMs('invalid', 2500), 2500);
});

test('measureTcpLatency returns a positive RTT for a reachable TCP endpoint', async (t) => {
    const server = net.createServer((socket) => {
        socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const address = server.address();
    const latencyMs = await measureTcpLatency(
        { host: '127.0.0.1', port: address.port },
        { timeoutMs: 500 },
    );

    assert.ok(Number.isFinite(latencyMs));
    assert.ok(latencyMs >= 1);
});

test('probeNodeLatencies keeps bounded results and unavailable nodes as null', async () => {
    const nodes = [
        { uuid: 'one', address: 'one.example.com' },
        { uuid: 'two', address: 'two.example.com:8443' },
        { uuid: 'missing', address: '' },
    ];
    const seenTargets = [];
    const results = await probeNodeLatencies(nodes, {
        concurrency: 2,
        probe: async (target) => {
            seenTargets.push(target);
            return target.host === 'one.example.com' ? 24 : null;
        },
    });

    assert.equal(results.get(nodeProbeKey(nodes[0])), 24);
    assert.equal(results.get(nodeProbeKey(nodes[1])), null);
    assert.equal(results.has(nodeProbeKey(nodes[2])), false);
    assert.deepEqual(seenTargets, [
        { host: 'one.example.com', port: 443 },
        { host: 'two.example.com', port: 8443 },
    ]);
});
