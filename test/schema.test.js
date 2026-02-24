'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('config schema is valid JSON and contains key sections', () => {
    const p = path.join(__dirname, '..', 'config.schema.json');
    const schema = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(schema.type, 'object');
    assert.equal(typeof schema.properties, 'object');
    assert.equal(typeof schema.properties.profile_mode, 'object');
    assert.equal(typeof schema.properties.groups, 'object');
    assert.equal(typeof schema.properties.token_limiter_max_entries, 'object');
    assert.equal(typeof schema.properties.token_limiter_cleanup_batch, 'object');
});
