'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyUpstreamPayload } = require('../lib/upstream-contract');

function fixture(name) {
    return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

test('classify upstream XRAY JSON payload', () => {
    const out = classifyUpstreamPayload(fixture('upstream_valid.json'));
    assert.equal(out.type, 'xray_json');
    assert.equal(Array.isArray(out.parsed), true);
});

test('classify fake payload from panel restrictions', () => {
    const out = classifyUpstreamPayload(fixture('upstream_fake.json'));
    assert.equal(out.type, 'fake_config');
});

test('classify non-json payload (base64/text)', () => {
    const out = classifyUpstreamPayload(fixture('upstream_non_json.txt'));
    assert.equal(out.type, 'non_json');
    assert.equal(out.parsed, null);
});
