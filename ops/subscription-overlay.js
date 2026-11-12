'use strict';

const http = require('node:http');

// Compatibility changes are limited to profiles already published by the balancer.
function appendTests(configs) {
    if (!Array.isArray(configs)) return configs;
    const result = [...configs];
    const unavailable = new Set();
    for (const [address, label] of [
        ['pl.ultimteam.ru', '\u{1f9ea} \u0422\u0435\u0441\u0442 \u2014 \u{1f1f5}\u{1f1f1} \u041f\u043e\u043b\u044c\u0448\u0430'],
        ['de.ultimteam.ru', '\u{1f9ea} \u0422\u0435\u0441\u0442 \u2014 \u{1f1e9}\u{1f1ea} \u0413\u0435\u0440\u043c\u0430\u043d\u0438\u044f'],
        ['cl-541e19d9.service.cdn.msk.vkcs.cloud', '\u{1f9ea} \u0422\u0435\u0441\u0442 \u2014 \u{1f1f7}\u{1f1fa} CDN VK'],
        ['cl-541e19d9.service.cdn.msk.vkcs.cloud', '\u{1f9ea} \u0422\u0435\u0441\u0442 \u2014 \u{1f1f7}\u{1f1fa} CDN HTTPS'],
        ['cl-541e19d9.service.cdn.msk.vkcs.cloud', '\u{1f1f7}\u{1f1fa} \u0422\u043e\u043b\u044c\u043a\u043e \u043a\u043e\u0433\u0434\u0430 \u0433\u043b\u0443\u0448\u0430\u0442 LTE - 1'],
        ['cl-541e19d9.service.cdn.msk.vkcs.cloud', '\u{1f9ea} \u0422\u0435\u0441\u0442 \u2014 \u{1f1f7}\u{1f1fa} CDN 3.4.3'],
        ['usaai.ultimteam.ru', '\u{1f9ea} \u0422\u0435\u0441\u0442 \u2014 \u{1f1fa}\u{1f1f8} USA \u2014 \u0418\u0418'],
        ['cl-541e19d9.service.cdn.msk.vkcs.cloud', '\u{1f9ea} \u0422\u0435\u0441\u0442 \u2014 \u{1f1f7}\u{1f1fa} CDN \u0447\u0435\u0440\u0435\u0437 \u0420\u043e\u0441\u0441\u0438\u044e'],
    ]) {
        const index = configs.findIndex(config => config?.remarks === label);
        if (index < 0) continue;
        const source = configs[index];
        if (!Array.isArray(source.outbounds)) continue;
        const config = structuredClone(source);
        const matches = outbound => outbound.protocol === 'vless'
            && outbound.settings?.vnext?.some(server => server.address === address);
        const selected = config.outbounds.find(outbound => outbound.tag !== 'proxy' && matches(outbound))
            || config.outbounds.find(matches);
        if (!selected?.tag || !config.routing) continue;
        if (label.endsWith('LTE - 1') && (selected.streamSettings?.security !== 'tls'
            || !selected.settings.vnext.every(server => server.port === 443))) continue;
        if (label.endsWith('\u0447\u0435\u0440\u0435\u0437 \u0420\u043e\u0441\u0441\u0438\u044e')) {
            const russian = configs.find(item => item?.remarks === RUSSIA_LABEL);
            const entry = russian?.outbounds?.find(outbound => outbound.protocol === 'vless'
                && outbound.settings?.vnext?.some(server => server.address === 'mw.ultimteam.ru'));
            if (!entry || entry.proxySettings || entry.streamSettings?.sockopt?.dialerProxy) {
                unavailable.add(index);
                continue;
            }
            const relay = structuredClone(entry);
            relay.tag = 'ut_test_cdn_entry_ru';
            for (const outbound of config.outbounds.filter(matches)) {
                outbound.streamSettings ||= {};
                outbound.streamSettings.sockopt = { ...(outbound.streamSettings.sockopt || {}), dialerProxy: relay.tag };
            }
            config.outbounds.push(relay);
        }
        config.dns = { tag: 'dns_q', queryStrategy: 'UseIPv4', servers: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'] };
        for (const balancer of config.routing.balancers || []) {
            balancer.selector = [selected.tag];
            balancer.fallbackTag = selected.tag;
        }
        config.routing.rules = [{ type: 'field', inboundTag: ['dns_q'], outboundTag: selected.tag },
            ...(config.routing.rules || []).filter(rule => !rule.inboundTag?.includes('dns_q'))];
        if (config.burstObservatory) config.burstObservatory.subjectSelector = [selected.tag];
        if (config.observatory) config.observatory.subjectSelector = [selected.tag];
        result[index] = config;
    }
    return result.filter((_, index) => !unavailable.has(index));
}

const RUSSIA_LABEL = '\u{1f1f7}\u{1f1fa} \u0420\u043e\u0441\u0441\u0438\u044f';

function applyRussiaDoh(configs) {
    if (!Array.isArray(configs)) return configs;
    return configs.filter(config => config?.remarks !== '\u{1f9ea} \u0422\u0435\u0441\u0442 \u2014 \u{1f1f7}\u{1f1fa} \u0420\u043e\u0441\u0441\u0438\u044f DoH').map(config => {
        if (config?.remarks !== RUSSIA_LABEL) return config;
        const result = structuredClone(config);
        const selected = result.outbounds?.find(outbound => outbound.protocol === 'vless' && outbound.tag !== 'proxy')
            || result.outbounds?.find(outbound => outbound.protocol === 'vless');
        if (!selected || !result.routing) throw new Error('RU DoH outbound missing');
        const scoped = (result.dns?.servers || []).filter(server => typeof server === 'object'
            && Array.isArray(server.domains) && server.domains.length);
        result.dns = { ...(result.dns || {}), tag: 'dns_q', queryStrategy: 'UseIPv4',
            servers: [...scoped, 'https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'] };
        for (const outbound of result.outbounds) {
            if (outbound.protocol === 'vless' && outbound.settings?.vnext) {
                for (const server of outbound.settings.vnext) server.address = '45.132.185.177';
            }
        }
        result.outbounds.push({ tag: 'ut_ru_doh_dns', protocol: 'dns', settings: {} });
        result.routing.rules = [{ type: 'field', inboundTag: ['dns_q'], outboundTag: selected.tag },
            { type: 'field', network: 'tcp,udp', port: '53', outboundTag: 'ut_ru_doh_dns' },
            ...(result.routing.rules || []).filter(rule => !rule.inboundTag?.includes('dns_q'))];
        return result;
    });
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
function headers(source) {
    return Object.fromEntries(Object.entries(source).filter(([key]) => !HOP_HEADERS.has(key.toLowerCase())));
}

function transformProfiles(configs) {
    return applyRussiaDoh(appendTests(configs));
}

function start({ upstreamHost = 'xray-balancer-mw', upstreamPort = 4100, port = 4112, host = '0.0.0.0' } = {}) {
    return http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://local').pathname;
        const allowed = req.method === 'GET' && /^\/[a-zA-Z0-9_-]+$/.test(pathname);
        const requestHeaders = headers(req.headers);
        requestHeaders['accept-encoding'] = 'identity';
        const upstream = http.request({ hostname: upstreamHost, port: upstreamPort, path: req.url,
            method: req.method, headers: requestHeaders, timeout: 25000 }, response => {
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > 8 * 1024 * 1024) { response.destroy(); return; }
                chunks.push(chunk);
            });
            response.on('end', () => {
                let body = Buffer.concat(chunks);
                const responseHeaders = headers(response.headers);
                if (allowed && response.statusCode === 200 && !response.headers['content-encoding']) {
                    try {
                        const parsed = JSON.parse(body);
                        if (Array.isArray(parsed)) {
                            body = Buffer.from(JSON.stringify(transformProfiles(parsed)));
                            delete responseHeaders.etag;
                            delete responseHeaders['content-md5'];
                            responseHeaders['cache-control'] = 'no-store';
                            responseHeaders['content-type'] = 'application/json; charset=utf-8';
                        }
                    } catch { /* Preserve unsupported upstream responses. */ }
                }
                res.writeHead(response.statusCode, responseHeaders);
                res.end(body);
            });
            response.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        });
        upstream.on('timeout', () => upstream.destroy());
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(upstream);
    }).listen(port, host);
}

module.exports = { appendTests, applyRussiaDoh, transformProfiles, start };
if (require.main === module) start();
