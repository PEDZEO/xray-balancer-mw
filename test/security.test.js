'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactTokenPath, sanitizeClientMetadata } = require('../lib/security');

test('redactTokenPath masks subscription token', () => {
    const out = redactTokenPath('/GMfWZNmbtqyR4fgk');
    assert.equal(out, '/GMfW...4fgk');
});

test('sanitizeClientMetadata does not leak device details', () => {
    const req = {
        headers: {
            'x-hwid': 'abc',
            'x-device-model': 'Pixel',
            'x-device-os': 'Android',
        },
    };

    assert.deepEqual(sanitizeClientMetadata(req), {
        hwid: 'present',
        device: 'present',
        os: 'present',
    });
});
