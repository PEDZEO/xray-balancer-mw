'use strict';

const { isFakeConfig } = require('./balancing');

function classifyUpstreamPayload(body) {
    try {
        const parsed = JSON.parse(body);
        const array = Array.isArray(parsed) ? parsed : [parsed];

        if (array.length === 0) {
            return { type: 'empty_json', parsed: array };
        }

        if (isFakeConfig(array)) {
            return { type: 'fake_config', parsed: array };
        }

        return { type: 'xray_json', parsed: array };
    } catch {
        return { type: 'non_json', parsed: null };
    }
}

module.exports = {
    classifyUpstreamPayload,
};
