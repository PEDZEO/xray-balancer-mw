const http = require('http');
const https = require('https');
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

const PORT = parseInt(process.env.PORT, 10) || config.port || 4100;
const REMNAWAVE_URL = process.env.REMNAWAVE_URL || config.remnawave_url;
if (!REMNAWAVE_URL && !process.env.SUB_PAGE_URL && !config.sub_page_url) {
    console.error('❌ REMNAWAVE_URL не задан (ни в .env, ни в config.json). Укажите хотя бы REMNAWAVE_URL или SUB_PAGE_URL.');
    process.exit(1);
}
const REMNAWAVE_SUB_PATH = process.env.SUB_PATH || config.sub_path || '/api/sub';
const API_TOKEN = process.env.API_TOKEN || config.api_token || '';

const SUB_PAGE_URL = process.env.SUB_PAGE_URL || config.sub_page_url || '';
const SUB_DOMAIN = process.env.SUB_DOMAIN || config.sub_domain || '';

let GROUPS = config.groups || {};

const AUTO_GROUPS = config.auto_groups || false;
const AUTO_GROUPS_INTERVAL = (config.auto_groups_interval_sec || 300) * 1000;

const STRATEGY = config.strategy || 'leastLoad';
const PROBE_INTERVAL = config.probe_interval || '3m';
const PROBE_URL = config.probe_url || 'https://www.gstatic.com/generate_204';

// Node stats — опрос нагрузки нод из API панели
const NODE_STATS_ENABLED = process.env.NODE_STATS === 'true' || config.node_stats || false;
const NODE_STATS_INTERVAL = (parseInt(process.env.NODE_STATS_INTERVAL_SEC, 10) || config.node_stats_interval_sec || 120) * 1000;
const MAX_USERS_PER_GB = parseInt(process.env.MAX_USERS_PER_GB, 10) || config.max_users_per_gb || 20;

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// Cookie-авторизация для панели за nginx (egam.es и подобные)
const PANEL_AUTH_COOKIE = process.env.PANEL_AUTH_COOKIE || config.panel_auth_cookie || '';

// Собрать заголовки для API панели
function panelHeaders() {
    const h = {
        'Authorization': `Bearer ${API_TOKEN}`,
        'X-Forwarded-For': '127.0.0.1',
        'X-Forwarded-Proto': 'https',
    };
    if (PANEL_AUTH_COOKIE) {
        h['Cookie'] = PANEL_AUTH_COOKIE;
    }
    return h;
}

// Кэш статистики нод: { "Finland2": { usersOnline: 9, totalRamGb: 2.06, load: 4.37 }, ... }
let nodeStatsCache = {};

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
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
                if (maxRedirects <= 0) {
                    return reject(new Error('Too many redirects'));
                }
                return fetchUrl(new URL(res.headers.location, targetUrl).href, headers, maxRedirects - 1).then(resolve).catch(reject);
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
    let bestGroup = null;
    let bestLen = 0;

    for (const [groupName, patterns] of Object.entries(GROUPS)) {
        for (const pattern of patterns) {
            const patLower = pattern.toLowerCase();
            // Короткие паттерны (≤2 символа) проверяем только как отдельные слова
            if (patLower.length <= 2) {
                const regex = new RegExp(`(?:^|[^a-z])${patLower}(?:$|[^a-z])`);
                if (regex.test(tagLower) && patLower.length > bestLen) {
                    bestGroup = groupName;
                    bestLen = patLower.length;
                }
            } else if (tagLower.includes(patLower) && patLower.length > bestLen) {
                bestGroup = groupName;
                bestLen = patLower.length;
            }
        }
    }
    return bestGroup;
}

// ─── Парсинг RAM ───

function parseRamGb(ramStr) {
    if (!ramStr) return 1;
    const match = ramStr.match(/([\d.]+)\s*(GB|MB)/i);
    if (!match) return 1;
    const val = parseFloat(match[1]);
    if (match[2].toUpperCase() === 'MB') return val / 1024;
    return val;
}

// ─── Node Stats — опрос панели ───

async function fetchNodeStats() {
    if (!API_TOKEN || !REMNAWAVE_URL) return;
    try {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/nodes/`, panelHeaders());
        if (response.status !== 200) {
            console.error('[node-stats] API вернул', response.status);
            return;
        }
        const data = JSON.parse(response.body);
        const nodes = data.response || (Array.isArray(data) ? data : []);

        const newCache = {};
        for (const node of nodes) {
            const name = node.name || '';
            const usersOnline = node.usersOnline || 0;
            const totalRamGb = parseRamGb(node.totalRam);
            const isConnected = node.isConnected || false;
            const isDisabled = node.isDisabled || false;

            // load = юзеров на 1GB RAM
            const load = totalRamGb > 0 ? usersOnline / totalRamGb : 999;

            newCache[name] = {
                usersOnline,
                totalRamGb,
                load: Math.round(load * 100) / 100,
                isConnected,
                isDisabled,
            };

            // Также кэшируем по тегам inbound'ов (для матчинга с outbound тегами)
            if (node.configProfile && node.configProfile.activeInbounds) {
                for (const inb of node.configProfile.activeInbounds) {
                    if (inb.tag && inb.tag !== name) {
                        newCache[inb.tag] = newCache[name];
                    }
                }
            }
        }

        nodeStatsCache = newCache;
        const sorted = Object.entries(newCache)
            .filter(([_, s]) => s.isConnected && !s.isDisabled)
            .sort((a, b) => a[1].load - b[1].load);

        console.log(`[node-stats] Обновлено: ${sorted.length} нод`);
        for (const [name, s] of sorted.slice(0, 5)) {
            console.log(`  ${name}: ${s.usersOnline} юзеров, ${s.totalRamGb}GB RAM, load=${s.load}`);
        }
        if (sorted.length > 5) console.log(`  ... и ещё ${sorted.length - 5}`);

    } catch (err) {
        console.error('[node-stats] Ошибка:', err.message);
    }
}

// ─── Получить статистику ноды по тегу outbound'а ───

function getNodeStats(outboundTag) {
    // Прямой матч по имени
    if (nodeStatsCache[outboundTag]) return nodeStatsCache[outboundTag];

    // Матч по словам — ищем имя ноды как отдельное слово в теге
    // Защита от ложных совпадений (nl → finland, de → node и т.д.)
    const tagLower = outboundTag.toLowerCase();
    let bestMatch = null;
    let bestLen = 0;

    for (const [nodeName, stats] of Object.entries(nodeStatsCache)) {
        const nameL = nodeName.toLowerCase();
        // Минимум 3 символа для fuzzy матча (защита от "nl", "de", "fi")
        if (nameL.length < 3) continue;
        // Ищем имя ноды в теге
        if (tagLower.includes(nameL) && nameL.length > bestLen) {
            bestMatch = stats;
            bestLen = nameL.length;
        }
    }
    return bestMatch;
}

// ─── Фильтрация и сортировка outbound'ов по нагрузке ───

function filterAndSortByLoad(outbounds) {
    if (Object.keys(nodeStatsCache).length === 0) return outbounds;

    const withStats = outbounds.map(ob => {
        const stats = getNodeStats(ob.tag);
        return { ob, stats, load: stats ? stats.load : MAX_USERS_PER_GB / 2 };
    });

    // Исключаем перегруженные (load > max_users_per_gb) и отключённые
    const filtered = withStats.filter(({ stats }) => {
        if (!stats) return true; // Нет данных — пропускаем
        if (!stats.isConnected || stats.isDisabled) return false; // Офлайн
        if (stats.load > MAX_USERS_PER_GB) return false; // Перегружен
        return true;
    });

    // Если все отфильтрованы — вернуть всех подключённых (fallback)
    if (filtered.length === 0) {
        const connected = withStats.filter(({ stats }) => !stats || (stats.isConnected && !stats.isDisabled));
        if (connected.length === 0) return outbounds; // Совсем ничего — вернуть как есть
        connected.sort((a, b) => a.load - b.load);
        return connected.map(({ ob }) => ob);
    }

    // Сортируем: менее загруженные первыми
    filtered.sort((a, b) => a.load - b.load);

    return filtered.map(({ ob }) => ob);
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
    let bestMatch = null;
    let bestLen = 0;

    for (const [country, info] of Object.entries(COUNTRY_PATTERNS)) {
        for (const pattern of info.patterns) {
            const patLower = pattern.toLowerCase();
            let matched = false;

            if (patLower.length <= 2) {
                const regex = new RegExp(`(?:^|[^a-z])${patLower}(?:$|[^a-z])`);
                matched = regex.test(remarkLower);
            } else {
                matched = remarkLower.includes(patLower);
            }

            if (matched && patLower.length > bestLen) {
                bestMatch = { country, emoji: info.emoji, patterns: info.patterns };
                bestLen = patLower.length;
            }
        }
    }
    return bestMatch;
}

async function fetchHostsFromApi() {
    if (!API_TOKEN) return null;
    try {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/hosts/`, panelHeaders());
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

// ─── Детектировать фейковый конфиг (лимит устройств, истекла подписка) ───

function isFakeConfig(configArray) {
    const systemProtocols = new Set(['freedom', 'blackhole', 'dns']);
    let proxyCount = 0;
    let fakeCount = 0;

    for (const cfg of configArray) {
        for (const ob of (cfg.outbounds || [])) {
            if (systemProtocols.has(ob.protocol)) continue;
            if (!ob.tag) continue;
            proxyCount++;

            // Проверяем все известные форматы: vless/vmess/trojan/shadowsocks
            const addr = (
                ob.settings?.vnext?.[0]?.address ||
                ob.settings?.servers?.[0]?.address ||
                ''
            );
            const port = (
                ob.settings?.vnext?.[0]?.port ||
                ob.settings?.servers?.[0]?.port ||
                null
            );

            if (addr === '0.0.0.0' && port === 1) {
                fakeCount++;
            }
        }
    }

    return proxyCount > 0 && proxyCount === fakeCount;
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

// Поля, которые балансировщик контролирует сам — остальное наследуем из baseConfig
const MANAGED_FIELDS = new Set(['remarks', 'dns', 'inbounds', 'outbounds', 'routing', 'burstObservatory']);

function buildGroupConfig(baseConfig, groupName, outbounds) {
    // Наследуем все верхнеуровневые поля из baseConfig которые мы не перезаписываем:
    // announce, log, stats и всё остальное что Remnawave может добавить
    const inherited = {};
    for (const [key, val] of Object.entries(baseConfig)) {
        if (!MANAGED_FIELDS.has(key)) {
            inherited[key] = JSON.parse(JSON.stringify(val));
        }
    }

    const cfg = {
        ...inherited,
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

    cfg.burstObservatory = {
        subjectSelector: tags,
        pingConfig: {
            destination: PROBE_URL,
            interval: PROBE_INTERVAL,
            sampling: 3,
            timeout: '2s',
            httpMethod: 'GET',
        },
    };

    cfg.routing = {
        domainStrategy: 'IPIfNonMatch',
        balancers: [
            {
                tag: `${prefix}-balancer`,
                selector: tags,
                strategy: {
                    type: STRATEGY,
                    settings: {
                        expected: 1,
                        baselines: ['1s'],
                        tolerance: 0.8,
                    },
                },
            },
        ],
        rules: [
            { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
            { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
            {
                type: 'field',
                domain: [
                    'localhost',
                    'localhost.localdomain',
                    'local',
                    '*.local',
                    '*.localdomain',
                    '*.lan',
                    '*.internal',
                ],
                outboundTag: 'direct',
            },
            {
                type: 'field',
                ip: [
                    '127.0.0.0/8',
                    '10.0.0.0/8',
                    '172.16.0.0/12',
                    '192.168.0.0/16',
                    '169.254.0.0/16',
                    '::1/128',
                    'fc00::/7',
                    'fe80::/10',
                ],
                outboundTag: 'direct',
            },
            { type: 'field', network: 'tcp,udp', balancerTag: `${prefix}-balancer` },
        ],
    };

    return cfg;
}

// ─── HTTP сервер ───

// Заголовки запроса которые НЕ пробрасываем на upstream
const SKIP_REQUEST_HEADERS = new Set([
    'accept-encoding',      // Чтобы upstream не сжимал ответ
    'host',                 // Перезаписываем сами
    'connection',           // Hop-by-hop
    'keep-alive',           // Hop-by-hop
    'transfer-encoding',    // Hop-by-hop
    'te',                   // Hop-by-hop
    'upgrade',              // Hop-by-hop
    'proxy-authorization',  // Не нужен для upstream
    'proxy-connection',     // Hop-by-hop
]);

// Заголовки ответа которые НЕ пробрасываем клиенту
const SKIP_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
    'content-length',       // Пересчитываем сами
    'content-encoding',     // Мы отдаём без сжатия
    'date',                 // Своё выставит Node.js
    'server',               // Не светим upstream (nginx и т.д.)
]);

// Собрать все заголовки от upstream кроме служебных
function forwardResponseHeaders(upstreamHeaders, contentType) {
    const result = { 'Content-Type': contentType || 'application/json; charset=utf-8' };
    for (const [key, val] of Object.entries(upstreamHeaders)) {
        if (!SKIP_RESPONSE_HEADERS.has(key) && key !== 'content-type') {
            result[key] = val;
        }
    }
    return result;
}

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
            node_stats: NODE_STATS_ENABLED,
            panel_auth: PANEL_AUTH_COOKIE ? true : false,
            cached_nodes: Object.keys(nodeStatsCache).length,
            sub_page: SUB_PAGE_URL || 'disabled',
        }));
        return;
    }

    if (pathname === '/node-stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nodeStatsCache, null, 2));
        return;
    }

    if (pathname === '/refresh-groups' && API_TOKEN) {
        await refreshGroups();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', groups: GROUPS }));
        return;
    }

    if (pathname === '/refresh-stats' && API_TOKEN) {
        await fetchNodeStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', nodes: nodeStatsCache }));
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
        // Пробрасываем ВСЕ заголовки от клиента, кроме тех что ломают проксирование
        const forwardHeaders = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (!SKIP_REQUEST_HEADERS.has(key)) {
                forwardHeaders[key] = value;
            }
        }

        // Дефолтный User-Agent если клиент не прислал
        if (!forwardHeaders['user-agent']) {
            forwardHeaders['user-agent'] = 'Happ/1.0';
        }

        // Проксирование через subscription page — подставляем правильные заголовки
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
            res.writeHead(upstream.status, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(upstream.body);
        } catch (e) {
            console.log('[proxy] Не JSON, проксируем');
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        let configArray = Array.isArray(parsed) ? parsed : [parsed];

        if (configArray.length === 0) {
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        const baseConfig = configArray[0];

        // Детектируем фейковые конфиги — когда Remnawave возвращает сообщение об ошибке
        // (лимит устройств, истекла подписка и т.д.) вместо реальных серверов.
        // Признак: все прокси-outbound'ы имеют адрес 0.0.0.0 и порт 1.
        if (isFakeConfig(configArray)) {
            console.log('[proxy] Обнаружен фейковый конфиг (лимит устройств / истекла подписка) — проксируем как есть');
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        let allOutbounds = collectAllProxyOutbounds(configArray);
        console.log(`[proxy] Собрано ${allOutbounds.length} прокси-outbound(ов)`);

        if (allOutbounds.length === 0) {
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        // ─── Фильтрация и сортировка по нагрузке ───
        if (NODE_STATS_ENABLED && Object.keys(nodeStatsCache).length > 0) {
            const before = allOutbounds.length;
            allOutbounds = filterAndSortByLoad(allOutbounds);
            const after = allOutbounds.length;
            if (before !== after) {
                console.log(`[node-stats] Отфильтровано: ${before} → ${after} серверов (исключены перегруженные >${MAX_USERS_PER_GB} users/GB)`);
            }
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

        // ─── Сортировка внутри групп по нагрузке (без повторной фильтрации) ───
        if (NODE_STATS_ENABLED && Object.keys(nodeStatsCache).length > 0) {
            for (const [groupName, obs] of Object.entries(grouped)) {
                grouped[groupName] = obs.slice().sort((a, b) => {
                    const sa = getNodeStats(a.tag);
                    const sb = getNodeStats(b.tag);
                    const la = sa ? sa.load : MAX_USERS_PER_GB / 2;
                    const lb = sb ? sb.load : MAX_USERS_PER_GB / 2;
                    return la - lb;
                });
            }
        }

        // ─── Конфиги ───
        const resultConfigs = [];

        // ⚡ Fastest
        const fastestEnabled = config.fastest_group !== false;
        if (fastestEnabled && allOutbounds.length > 1) {
            const fastestConfig = buildGroupConfig(baseConfig, '🏁 Самые быстрые', allOutbounds);
            resultConfigs.push(fastestConfig);
            console.log(`[group] 🏁 Самые быстрые: ${allOutbounds.length} серверов (все)`);
        }

        // Группы по странам
        for (const [groupName, outbounds] of Object.entries(grouped)) {
            if (outbounds.length === 0) continue;
            const groupConfig = buildGroupConfig(baseConfig, groupName, outbounds);
            resultConfigs.push(groupConfig);

            // Логируем порядок серверов если есть стата
            if (NODE_STATS_ENABLED && Object.keys(nodeStatsCache).length > 0) {
                const order = outbounds.map(ob => {
                    const s = getNodeStats(ob.tag);
                    return s ? `${ob.tag}(${s.usersOnline}u/${s.totalRamGb}G)` : ob.tag;
                }).join(', ');
                console.log(`[group] ${groupName}: ${outbounds.length} серверов → ${order}`);
            } else {
                console.log(`[group] ${groupName}: ${outbounds.length} серверов`);
            }
        }

        console.log(`[proxy] Итого: ${resultConfigs.length} групп, ${allOutbounds.length} серверов`);

        const responseBody = JSON.stringify(resultConfigs, null, 2);

        const responseHeaders = forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8');

        res.writeHead(200, responseHeaders);
        res.end(responseBody);

    } catch (err) {
        console.error('[error]', err.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Bad Gateway: ' + err.message);
        }
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

    if (NODE_STATS_ENABLED && API_TOKEN) {
        await fetchNodeStats();
        setInterval(() => fetchNodeStats(), NODE_STATS_INTERVAL);
    }

    const fastestEnabled = config.fastest_group !== false;

    server.listen(PORT, () => {
        console.log(`\n🚀 Xray Balancer Middleware — порт ${PORT}`);
        console.log(`📋 Группы: ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v.join(',')}]`).join(' | ')}`);
        console.log(`🏁 Самые быстрые: ${fastestEnabled ? '✅' : '❌'}`);
        console.log(`🎯 Стратегия: ${STRATEGY} (expected=1, baselines=1s, tolerance=0.8)`);
        console.log(`📡 Probe: ${PROBE_URL} каждые ${PROBE_INTERVAL}`);
        console.log(`📊 Node stats: ${NODE_STATS_ENABLED ? `✅ (каждые ${NODE_STATS_INTERVAL/1000}с, макс ${MAX_USERS_PER_GB} users/GB)` : '❌'}`);
        console.log(`🔐 Panel cookie: ${PANEL_AUTH_COOKIE ? '✅' : '❌ (не нужен)'}`);
        console.log(`📡 Sub page: ${SUB_PAGE_URL || 'не задан'}`);
        console.log(`🔀 Форвард: все заголовки клиента → upstream, все заголовки upstream → клиент`);
        console.log(`\n   Подписка: http://localhost:${PORT}/{token}`);
        console.log(`   Health:   http://localhost:${PORT}/health`);
        console.log(`   Стата:    http://localhost:${PORT}/node-stats\n`);
    });
}

start().catch(err => { console.error('Ошибка:', err); process.exit(1); });