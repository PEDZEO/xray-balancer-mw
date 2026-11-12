'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { start, transformProfiles } = require('../ops/subscription-overlay');

const RUSSIA = '\u{1f1f7}\u{1f1fa} \u0420\u043e\u0441\u0441\u0438\u044f';
const YANDEX = '\u{1f9ea} DNS \u2014 \u{1f1f7}\u{1f1fa} \u042f\u043d\u0434\u0435\u043a\u0441';
const DOH = '\u{1f9ea} DNS \u2014 \u{1f1f7}\u{1f1fa} DoH';
function profile(remarks) {
    return { remarks, outbounds: [{ tag: 'node', protocol: 'vless', settings: { vnext: [{ address: 'node.example', port: 443 }] } }],
        dns: { servers: ['1.1.1.1'] }, routing: { rules: [] } };
}

test('public overlay never synthesizes DNS comparison profiles from the Russia profile', () => {
    const input = [profile(RUSSIA), profile('Germany')];
    const snapshot = structuredClone(input);
    const output = transformProfiles(input);
    assert.deepEqual(output.map(item => item.remarks), [RUSSIA, 'Germany']);
    assert.deepEqual(input, snapshot);
    assert.equal(output.some(item => [YANDEX, DOH].includes(item.remarks)), false);
    assert.deepEqual(transformProfiles([]), []);
});

test('public overlay respects DNS host deletion and re-addition on successive HTTP refreshes', async (t) => {
    let profiles = [profile(RUSSIA), profile(YANDEX), profile(DOH)];
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(profiles));
    }).listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const overlay = start({ upstreamHost: '127.0.0.1', upstreamPort: upstream.address().port, port: 0, host: '127.0.0.1' });
    await once(overlay, 'listening');
    t.after(() => { overlay.closeAllConnections(); overlay.close(); upstream.closeAllConnections(); upstream.close(); });
    const read = async () => {
        const response = await fetch(`http://127.0.0.1:${overlay.address().port}/test-token`, { headers: { 'user-agent': 'Happ/1.0' } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return (await response.json()).map(item => item.remarks);
    };
    assert.deepEqual(await read(), [RUSSIA, YANDEX, DOH]);
    profiles = [profile(RUSSIA)];
    assert.deepEqual(await read(), [RUSSIA]);
    assert.deepEqual(await read(), [RUSSIA]);
    profiles = [profile(RUSSIA), profile(YANDEX)];
    assert.deepEqual(await read(), [RUSSIA, YANDEX]);
});
