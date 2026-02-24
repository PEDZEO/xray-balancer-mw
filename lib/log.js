'use strict';

function buildLogger() {
    function write(level, event, fields = {}) {
        const payload = {
            ts: new Date().toISOString(),
            level,
            event,
            ...fields,
        };
        const line = JSON.stringify(payload);
        if (level === 'error') {
            console.error(line);
            return;
        }
        console.log(line);
    }

    return {
        info(event, fields) {
            write('info', event, fields);
        },
        warn(event, fields) {
            write('warn', event, fields);
        },
        error(event, fields) {
            write('error', event, fields);
        },
    };
}

module.exports = { buildLogger };
