const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// ─── Загрузка конфига ───
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    console.error(`❌ Ошибка чтения ${CONFIG_PATH}:`, err.message);
    process.exit(1);
}

const PORT = config.port || 4100;
const REMNAWAVE_URL = config.remnawave_url;
const REMNAWAVE_SUB_PATH = config.sub_path || '/api/sub';
const API_TOKEN = config.api_token || process.env.REMNAWAVE_API_TOKEN || '';

const SUB_PAGE_URL = config.sub_page_url || '';
const SUB_DOMAIN = config.sub_domain || '';

let GROUPS = config.groups || {};

const AUTO_GROUPS = config.auto_groups || false;
const AUTO_GROUPS_INTERVAL = (config.auto_groups_interval_sec || 300) * 1000;

const STRATEGY = config.strategy || 'leastLoad';
const PROBE_INTERVAL = config.probe_interval || '1m';
const PROBE_URL = config.probe_url || 'https://www.gstatic.com/generate_204';

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB лимит ответа от upstream

// ─── Утилиты ───

function fetchUrl(targetUrl, headers = {}, maxRedirects = 3) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const mod = parsed.protocol === 'https:' ? https : http;
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { ...headers },
        };
        const req = mod.request(opts, (res) => {
            // Обработка редиректов
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
                if (maxRedirects <= 0) {
                    return reject(new Error('Too many redirects'));
                }
                return fetchUrl(res.headers.location, headers, maxRedirects - 1).then(resolve).catch(reject);
            }

            let data = '';
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_RESPONSE_SIZE) {
                    req.destroy();
                    return reject(new Error('Response too large'));
                }
                data += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

function sanitizeTag(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

function matchGroup(outboundTag) {
    const tagLower = outboundTag.toLowerCase();
    for (const [groupName, patterns] of Object.entries(GROUPS)) {
        for (const pattern of patterns) {
            if (tagLower.includes(pattern.toLowerCase())) {
                return groupName;
            }
        }
    }
    return null;
}

// ─── Remnawave API ───

const COUNTRY_PATTERNS = {
    'Finland': { emoji: '🇫🇮', patterns: ['Finland', 'Финлянд', 'FI', 'Helsinki'] },
    'Germany': { emoji: '🇩🇪', patterns: ['Germany', 'German', 'Германи', 'DE', 'Berlin', 'Frankfurt'] },
    'Netherlands': { emoji: '🇳🇱', patterns: ['Netherlands', 'Нидерланд', 'NL', 'Amsterdam', 'Holland'] },
    'USA': { emoji: '🇺🇸', patterns: ['USA', 'United States', 'Америк', 'US', 'New York', 'Los Angeles', 'Dallas'] },
    'Sweden': { emoji: '🇸🇪', patterns: ['Sweden', 'Швеци', 'SE', 'Stockholm'] },
    'France': { emoji: '🇫🇷', patterns: ['France', 'Франци', 'FR', 'Paris'] },
    'UK': { emoji: '🇬🇧', patterns: ['United Kingdom', 'UK', 'Британи', 'GB', 'London', 'England'] },
    'Poland': { emoji: '🇵🇱', patterns: ['Poland', 'Польш', 'PL', 'Warsaw'] },
    'Turkey': { emoji: '🇹🇷', patterns: ['Turkey', 'Турци', 'TR', 'Istanbul'] },
    'Japan': { emoji: '🇯🇵', patterns: ['Japan', 'Япони', 'JP', 'Tokyo'] },
    'Singapore': { emoji: '🇸🇬', patterns: ['Singapore', 'Сингапур', 'SG'] },
    'Austria': { emoji: '🇦🇹', patterns: ['Austria', 'Австри', 'AT', 'Vienna'] },
    'Canada': { emoji: '🇨🇦', patterns: ['Canada', 'Канад', 'CA', 'Toronto'] },
    'Australia': { emoji: '🇦🇺', patterns: ['Australia', 'Австрали', 'AU', 'Sydney'] },
    'Italy': { emoji: '🇮🇹', patterns: ['Italy', 'Итали', 'IT', 'Rome', 'Milan'] },
    'Spain': { emoji: '🇪🇸', patterns: ['Spain', 'Испани', 'ES', 'Madrid'] },
    'Czech': { emoji: '🇨🇿', patterns: ['Czech', 'Чехи', 'CZ', 'Prague'] },
    'Romania': { emoji: '🇷🇴', patterns: ['Romania', 'Румыни', 'RO'] },
    'Bulgaria': { emoji: '🇧🇬', patterns: ['Bulgaria', 'Болгари', 'BG'] },
    'Latvia': { emoji: '🇱🇻', patterns: ['Latvia', 'Латви', 'LV', 'Riga'] },
    'Lithuania': { emoji: '🇱🇹', patterns: ['Lithuania', 'Литв', 'LT', 'Vilnius'] },
    'Estonia': { emoji: '🇪🇪', patterns: ['Estonia', 'Эстони', 'EE', 'Tallinn'] },
    'Ireland': { emoji: '🇮🇪', patterns: ['Ireland', 'Ирланди', 'IE', 'Dublin'] },
    'Kazakhstan': { emoji: '🇰🇿', patterns: ['Kazakhstan', 'Казахстан', 'KZ'] },
    'Ukraine': { emoji: '🇺🇦', patterns: ['Ukraine', 'Украин', 'UA', 'Kyiv'] },
    'Moldova': { emoji: '🇲🇩', patterns: ['Moldova', 'Молдов', 'MD'] },
    'India': { emoji: '🇮🇳', patterns: ['India', 'Инди', 'IN', 'Mumbai'] },
    'Brazil': { emoji: '🇧🇷', patterns: ['Brazil', 'Бразили', 'BR'] },
    'LTE': { emoji: '🇪🇺', patterns: ['LTE', 'ЕВРОПА'] },
};

function detectCountryFromRemark(remark) {
    const remarkLower = remark.toLowerCase();
    for (const [country, info] of Object.entries(COUNTRY_PATTERNS)) {
        for (const pattern of info.patterns) {
            if (remarkLower.includes(pattern.toLowerCase())) {
                return { country, emoji: info.emoji, patterns: info.patterns };
            }
        }
    }
    return null;
}

async function fetchHostsFromApi() {
    if (!API_TOKEN) return null;
    try {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/hosts/`, {
            'Authorization': `Bearer ${API_TOKEN}`,
            'X-Forwarded-For': '127.0.0.1',
            'X-Forwarded-Proto': 'https',
        });
        if (response.status !== 200) return null;
        const data = JSON.parse(response.body);
        return data.response || (Array.isArray(data) ? data : null);
    } catch (err) {
        console.error('[auto-groups] Ошибка:', err.message);
        return null;
    }
}

function buildGroupsFromHosts(hosts) {
    const groups = {};
    const seen = new Set();
    for (const host of hosts.filter(h => !h.isDisabled)) {
        const remark = host.remark || host.tag || host.address || '';
        const detected = detectCountryFromRemark(remark);
        if (detected && !seen.has(detected.country)) {
            seen.add(detected.country);
            groups[`${detected.emoji} ${detected.country}`] = detected.patterns;
        }
    }
    return groups;
}

async function refreshGroups() {
    const hosts = await fetchHostsFromApi();
    if (!hosts) return;
    const newGroups = buildGroupsFromHosts(hosts);
    if (Object.keys(newGroups).length === 0) return;
    GROUPS = { ...newGroups, ...(config.groups || {}) };
    console.log(`[auto-groups] Обновлены: ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v}]`).join(' | ')}`);
}

// ─── Собрать все прокси-outbound'ы из XRAY-JSON массива ───

function collectAllProxyOutbounds(configArray) {
    const systemProtocols = new Set(['freedom', 'blackhole', 'dns']);
    const allOutbounds = [];
    const seenTags = new Set();

    for (let i = 0; i < configArray.length; i++) {
        const cfg = configArray[i];
        const outbounds = cfg.outbounds || [];
        const remarks = cfg.remarks || `connection-${i}`;

        for (const ob of outbounds) {
            if (systemProtocols.has(ob.protocol)) continue;
            if (!ob.tag) continue;

            // Deep clone чтобы не мутировать оригинал
            const cloned = JSON.parse(JSON.stringify(ob));

            let tag = cloned.tag;
            if (tag === 'proxy' && remarks) {
                tag = remarks;
            }
            if (seenTags.has(tag)) {
                tag = `${tag}-${i}`;
            }
            cloned.tag = tag;
            seenTags.add(tag);
            allOutbounds.push(cloned);
        }
    }

    return allOutbounds;
}

// ─── Создать конфиг для одной группы с балансировкой ───

function buildGroupConfig(baseConfig, groupName, outbounds) {
    const cfg = {
        remarks: groupName,
        dns: baseConfig.dns ? JSON.parse(JSON.stringify(baseConfig.dns)) : {
            servers: ['1.1.1.1', '1.0.0.1'],
            queryStrategy: 'UseIP',
        },
        inbounds: baseConfig.inbounds ? JSON.parse(JSON.stringify(baseConfig.inbounds)) : [
            {
                tag: 'socks', port: 10808, listen: '127.0.0.1', protocol: 'socks',
                settings: { udp: true, auth: 'noauth' },
                sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] },
            },
            {
                tag: 'http', port: 10809, listen: '127.0.0.1', protocol: 'http',
                settings: { allowTransparent: false },
                sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] },
            },
        ],
        outbounds: [
            ...JSON.parse(JSON.stringify(outbounds)),
            { tag: 'direct', protocol: 'freedom' },
            { tag: 'block', protocol: 'blackhole' },
        ],
    };

    const tags = outbounds.map(o => o.tag);
    const prefix = sanitizeTag(groupName);

    // burstObservatory — пингует серверы группы
    cfg.burstObservatory = {
        subjectSelector: tags,
        pingConfig: {
            destination: PROBE_URL,
            interval: PROBE_INTERVAL,
            sampling: 2,
            timeout: '2s',
            httpMethod: 'GET',
        },
    };

    // Routing с балансером
    cfg.routing = {
        domainStrategy: 'IPIfNonMatch',
        balancers: [
            {
                tag: `${prefix}-balancer`,
                selector: tags,
                strategy: {
                    type: 'leastLoad',
                    settings: {
                        expected: 2,
                        baselines: ['1s'],
                        tolerance: 0.5,
                    },
                },
            },
        ],
        rules: [
            { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
            { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
            { type: 'field', domain: ['geosite:private'], outboundTag: 'direct' },
            { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
            { type: 'field', network: 'tcp,udp', balancerTag: `${prefix}-balancer` },
        ],
    };

    return cfg;
}

// ─── HTTP сервер ───

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/health' || pathname === '/mw-health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            groups: Object.keys(GROUPS),
            auto_groups: AUTO_GROUPS,
            fastest_group: config.fastest_group !== false,
            sub_page: SUB_PAGE_URL || 'disabled',
        }));
        return;
    }

    if (pathname === '/refresh-groups' && API_TOKEN) {
        await refreshGroups();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', groups: GROUPS }));
        return;
    }

    const match = pathname.match(/^(?:\/sub)?\/([a-zA-Z0-9_-]+)$/);
    if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    const token = match[1];
    const targetUrl = SUB_PAGE_URL
        ? `${SUB_PAGE_URL}/${token}`
        : `${REMNAWAVE_URL}${REMNAWAVE_SUB_PATH}/${token}`;

    console.log(`[proxy] ${req.method} ${pathname} → ${targetUrl}`);

    try {
        const forwardHeaders = {};

        if (req.headers['user-agent']) forwardHeaders['User-Agent'] = req.headers['user-agent'];
        if (req.headers['accept']) forwardHeaders['Accept'] = req.headers['accept'];
        if (req.headers['accept-language']) forwardHeaders['Accept-Language'] = req.headers['accept-language'];
        if (!req.headers['user-agent']) forwardHeaders['User-Agent'] = 'Happ/1.0';

        // Форвардим ВСЕ X-* заголовки (HWID, Device-Os, Device-Model и т.д.)
        // НЕ форвардим Accept-Encoding чтобы upstream не сжимал ответ
        for (const [key, value] of Object.entries(req.headers)) {
            if (key.startsWith('x-') && !forwardHeaders[key]) {
                forwardHeaders[key] = value;
            }
        }

        if (SUB_PAGE_URL) {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
            forwardHeaders['X-Forwarded-Proto'] = 'https';
            forwardHeaders['X-Forwarded-For'] = clientIp;
            forwardHeaders['X-Real-IP'] = clientIp;
            forwardHeaders['Host'] = SUB_DOMAIN || req.headers['host'] || 'localhost';
        }

        console.log(`[proxy] Headers: HWID=${req.headers['x-hwid'] || 'нет'} Device=${req.headers['x-device-model'] || 'нет'} OS=${req.headers['x-device-os'] || 'нет'}`);

        const upstream = await fetchUrl(targetUrl, forwardHeaders);
        console.log(`[proxy] Upstream: ${upstream.status}, ${upstream.body.length} bytes`);

        if (upstream.status !== 200) {
            res.writeHead(upstream.status, { 'Content-Type': 'text/plain' });
            res.end(upstream.body);
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(upstream.body);
        } catch (e) {
            console.log('[proxy] Не JSON, проксируем');
            res.writeHead(200, {
                'Content-Type': upstream.headers['content-type'] || 'text/plain',
                'subscription-userinfo': upstream.headers['subscription-userinfo'] || '',
                'profile-update-interval': upstream.headers['profile-update-interval'] || '',
                'content-disposition': upstream.headers['content-disposition'] || '',
            });
            res.end(upstream.body);
            return;
        }

        let configArray = Array.isArray(parsed) ? parsed : [parsed];

        if (configArray.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(upstream.body);
            return;
        }

        const baseConfig = configArray[0];
        const allOutbounds = collectAllProxyOutbounds(configArray);
        console.log(`[proxy] Собрано ${allOutbounds.length} прокси-outbound(ов)`);

        if (allOutbounds.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(upstream.body);
            return;
        }

        // ─── Группируем ───
        const grouped = {};
        const ungrouped = [];

        for (const ob of allOutbounds) {
            const group = matchGroup(ob.tag);
            if (group) {
                if (!grouped[group]) grouped[group] = [];
                grouped[group].push(ob);
            } else {
                ungrouped.push(ob);
            }
        }

        if (ungrouped.length > 0) {
            const firstGroup = Object.keys(grouped)[0];
            if (firstGroup) {
                grouped[firstGroup].push(...ungrouped);
                console.log(`[proxy] ${ungrouped.length} без группы → ${firstGroup}`);
            } else {
                grouped['🌐 Other'] = ungrouped;
            }
        }

        // ─── Конфиги ───
        const resultConfigs = [];

        // ⚡ "Fastest" — все серверы, автовыбор лучшего (отключается в config.json)
        const fastestEnabled = config.fastest_group !== false;
        if (fastestEnabled && allOutbounds.length > 1) {
            const fastestConfig = buildGroupConfig(baseConfig, '⚡ Fastest', allOutbounds);
            resultConfigs.push(fastestConfig);
            console.log(`[group] ⚡ Fastest: ${allOutbounds.length} серверов (все)`);
        }

        // Группы по странам
        for (const [groupName, outbounds] of Object.entries(grouped)) {
            if (outbounds.length === 0) continue;
            const groupConfig = buildGroupConfig(baseConfig, groupName, outbounds);
            resultConfigs.push(groupConfig);
            console.log(`[group] ${groupName}: ${outbounds.length} серверов`);
        }

        console.log(`[proxy] Итого: ${resultConfigs.length} групп, ${allOutbounds.length} серверов`);

        const responseBody = JSON.stringify(resultConfigs, null, 2);

        const responseHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
        if (upstream.headers['subscription-userinfo']) responseHeaders['subscription-userinfo'] = upstream.headers['subscription-userinfo'];
        if (upstream.headers['profile-update-interval']) responseHeaders['profile-update-interval'] = upstream.headers['profile-update-interval'];
        if (upstream.headers['content-disposition']) responseHeaders['content-disposition'] = upstream.headers['content-disposition'];
        if (upstream.headers['profile-title']) responseHeaders['profile-title'] = upstream.headers['profile-title'];

        res.writeHead(200, responseHeaders);
        res.end(responseBody);

    } catch (err) {
        console.error('[error]', err.message);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway: ' + err.message);
    }
});

// ─── Graceful shutdown ───

function shutdown(signal) {
    console.log(`\n[shutdown] ${signal} — завершаем...`);
    server.close(() => {
        console.log('[shutdown] Готово');
        process.exit(0);
    });
    setTimeout(() => { process.exit(1); }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Старт ───

async function start() {
    if (AUTO_GROUPS && API_TOKEN) {
        await refreshGroups();
        setInterval(() => refreshGroups(), AUTO_GROUPS_INTERVAL);
    }

    const fastestEnabled = config.fastest_group !== false;

    server.listen(PORT, () => {
        console.log(`\n🚀 Xray Balancer Middleware — порт ${PORT}`);
        console.log(`📋 Группы: ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v.join(',')}]`).join(' | ')}`);
        console.log(`⚡ Fastest: ${fastestEnabled ? '✅' : '❌'}`);
        console.log(`🎯 Стратегия: leastLoad (expected=2, baselines=1s, tolerance=0.5)`);
        console.log(`📡 Probe: ${PROBE_URL} каждые ${PROBE_INTERVAL}`);
        console.log(`📡 Sub page: ${SUB_PAGE_URL || 'не задан'}`);
        console.log(`🔀 Форвард: все X-* заголовки (HWID, Device и т.д.)`);
        console.log(`\n   Подписка: http://localhost:${PORT}/{token}`);
        console.log(`   Health:   http://localhost:${PORT}/health\n`);
    });
}

start().catch(err => { console.error('Ошибка:', err); process.exit(1); });