'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildGroupConfig } = require('../lib/group-builder');

test('buildGroupConfig output matches snapshot fixture', () => {
    const base = {
        remarks: 'base',
        dns: { servers: ['1.1.1.1'] },
        inbounds: [{ tag: 'socks', protocol: 'socks' }],
        extraField: { x: 1 },
    };
    const outbounds = [
        { tag: 'Germany-1', protocol: 'vless' },
        { tag: 'USA-1', protocol: 'vless' },
    ];

    const out = buildGroupConfig(base, '🇪🇺 Europe', outbounds, {
        probeUrl: 'https://example.com/ping',
        probeInterval: '3m',
        strategy: 'leastLoad',
    });

    const snapPath = path.join(__dirname, 'fixtures', 'group_snapshot.json');
    const expected = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    assert.deepEqual(out, expected);
});

test('buildGroupConfig does not inherit per-server description fields from base config', () => {
    const base = {
        remarks: 'base',
        description: 'node-specific description',
        serverDescription: 'node-specific server description',
        server_description: 'node specific snake case description',
        extraField: { x: 1 },
    };

    const out = buildGroupConfig(base, '🇪🇺 Europe', [{ tag: 'Germany-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '3m',
        strategy: 'leastLoad',
    });

    assert.equal(out.description, undefined);
    assert.equal(out.serverDescription, undefined);
    assert.equal(out.server_description, undefined);
    assert.deepEqual(out.extraField, { x: 1 });
});
