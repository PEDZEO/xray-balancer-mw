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
    assert.equal(typeof schema.properties.fastest_fallback, 'object');
    assert.equal(typeof schema.properties.node_stats_exclude, 'object');
    assert.equal(typeof schema.properties.expand_groups_to_nodes, 'object');
    assert.equal(typeof schema.properties.token_limiter_max_entries, 'object');
    assert.equal(typeof schema.properties.token_limiter_cleanup_batch, 'object');
    assert.equal(typeof schema.properties.sticky_enabled, 'object');
    assert.equal(typeof schema.properties.sticky_new_connections_only, 'object');
    assert.equal(typeof schema.properties.auto_quarantine_nodes, 'object');
    assert.equal(schema.properties.strategy.enum.includes('leastPing'), true);
});
