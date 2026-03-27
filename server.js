const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateConfig } = require('./lib/config');
const { redactTokenPath, sanitizeClientMetadata } = require('./lib/security');
const {
    filterAndSortByLoad,
    getNodeStats,
    matchGroup,
} = require('./lib/balancing');
const { createCircuitBreaker, createKeyedRateLimiter, createRateLimiter, createTokenCache } = require('./lib/runtime');
const { buildLogger } = require('./lib/log');
const { resolveProfile } = require('./lib/profile');
const { classifyUpstreamPayload } = require('./lib/upstream-contract');
const { buildGroupConfig } = require('./lib/group-builder');
const { createStickyStore } = require('./lib/sticky');
const { createRequestGuard } = require('./lib/request-guard');

// ─── Загрузка конфига ───
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const CONFIG_RUNTIME_PATH = process.env.CONFIG_RUNTIME_PATH || '';
const MUTABLE_CONFIG_KEYS = [
    'groups',
    'fastest_group',
    'fastest_group_name',
    'fastest_exclude_groups',
    'quarantine_nodes',
    'auto_quarantine_enabled',
    'auto_quarantine_failures',
    'auto_quarantine_release_successes',
    'auto_quarantine_max_nodes',
    'auto_drain_enabled',
    'auto_drain_failures',
    'auto_drain_release_successes',
    'auto_drain_load_threshold',
    'auto_drain_score_penalty',
    'sticky_enabled',
    'sticky_ttl_sec',
    'sticky_max_entries',
    'balancer_load_weight',
    'balancer_latency_weight',
    'balancer_max_latency_ms',
    'balancer_smoothing_alpha',
    'balancer_hysteresis_delta',
];
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (CONFIG_RUNTIME_PATH && fs.existsSync(CONFIG_RUNTIME_PATH)) {
        const runtimePatchRaw = fs.readFileSync(CONFIG_RUNTIME_PATH, 'utf8');
        if (runtimePatchRaw.trim()) {
            const runtimePatch = JSON.parse(runtimePatchRaw);
            if (runtimePatch && typeof runtimePatch === 'object' && !Array.isArray(runtimePatch)) {
                config = { ...config, ...runtimePatch };
            }
        }
    }
    validateConfig(config);
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

const AUTO_GROUPS = config.auto_groups === true;
const AUTO_GROUPS_INTERVAL = (config.auto_groups_interval_sec || 300) * 1000;

const STRATEGY = config.strategy || 'leastLoad';
const PROBE_INTERVAL = config.probe_interval || '3m';
const PROBE_URL = config.probe_url || 'https://www.gstatic.com/generate_204';
const PROFILE_MODE = process.env.PROFILE_MODE || config.profile_mode || 'balanced';
const PROFILE = resolveProfile(PROFILE_MODE);

function pickRuntimeInt(envKey, configKey) {
    const envVal = parseInt(process.env[envKey], 10);
    if (Number.isInteger(envVal) && envVal > 0) return envVal;
    if (Number.isInteger(config[configKey]) && config[configKey] > 0) return config[configKey];
    return PROFILE.values[configKey];
}

// Node stats — опрос нагрузки нод из API панели
const NODE_STATS_ENABLED = process.env.NODE_STATS === 'true' || config.node_stats === true;
const NODE_STATS_INTERVAL = (parseInt(process.env.NODE_STATS_INTERVAL_SEC, 10) || config.node_stats_interval_sec || 120) * 1000;
const MAX_USERS_PER_GB = parseInt(process.env.MAX_USERS_PER_GB, 10) || config.max_users_per_gb || 20;
const MAX_USERS_PER_CPU = parseInt(process.env.MAX_USERS_PER_CPU, 10) || config.max_users_per_cpu || 40;
const CACHE_TTL_SEC = pickRuntimeInt('CACHE_TTL_SEC', 'cache_ttl_sec');
const CACHE_STALE_IF_ERROR_SEC = pickRuntimeInt('CACHE_STALE_IF_ERROR_SEC', 'cache_stale_if_error_sec');
const CACHE_MAX_ENTRIES = pickRuntimeInt('CACHE_MAX_ENTRIES', 'cache_max_entries');
const RATE_LIMIT_PER_MINUTE = pickRuntimeInt('RATE_LIMIT_PER_MINUTE', 'rate_limit_per_minute');
const RATE_LIMIT_BURST_10S = pickRuntimeInt('RATE_LIMIT_BURST_10S', 'rate_limit_burst_10s');
const TOKEN_RATE_LIMIT_PER_MINUTE = pickRuntimeInt('TOKEN_RATE_LIMIT_PER_MINUTE', 'token_rate_limit_per_minute');
const TOKEN_RATE_LIMIT_BURST_10S = pickRuntimeInt('TOKEN_RATE_LIMIT_BURST_10S', 'token_rate_limit_burst_10s');
const TOKEN_LIMITER_MAX_ENTRIES = parseInt(process.env.TOKEN_LIMITER_MAX_ENTRIES, 10) || config.token_limiter_max_entries || 5000;
const TOKEN_LIMITER_CLEANUP_BATCH = parseInt(process.env.TOKEN_LIMITER_CLEANUP_BATCH, 10) || config.token_limiter_cleanup_batch || 200;
const TRUST_X_FORWARDED_FOR = process.env.TRUST_X_FORWARDED_FOR === 'true' || config.trust_x_forwarded_for === true;
const ADMIN_RATE_LIMIT_PER_MINUTE = parseInt(process.env.ADMIN_RATE_LIMIT_PER_MINUTE, 10) || config.admin_rate_limit_per_minute || 60;
const ADMIN_RATE_LIMIT_BURST_10S = parseInt(process.env.ADMIN_RATE_LIMIT_BURST_10S, 10) || config.admin_rate_limit_burst_10s || 20;
const AUTO_QUARANTINE_ENABLED = process.env.AUTO_QUARANTINE_ENABLED === 'true' || config.auto_quarantine_enabled === true;
const AUTO_QUARANTINE_FAILURES = parseInt(process.env.AUTO_QUARANTINE_FAILURES, 10) || config.auto_quarantine_failures || 3;
const AUTO_QUARANTINE_RELEASE_SUCCESSES =
    parseInt(process.env.AUTO_QUARANTINE_RELEASE_SUCCESSES, 10) || config.auto_quarantine_release_successes || 2;
const AUTO_QUARANTINE_MAX_NODES = parseInt(process.env.AUTO_QUARANTINE_MAX_NODES, 10) || config.auto_quarantine_max_nodes || 100;
const AUTO_DRAIN_ENABLED = process.env.AUTO_DRAIN_ENABLED === 'true' || config.auto_drain_enabled === true;
const AUTO_DRAIN_FAILURES = parseInt(process.env.AUTO_DRAIN_FAILURES, 10) || config.auto_drain_failures || 2;
const AUTO_DRAIN_RELEASE_SUCCESSES = parseInt(process.env.AUTO_DRAIN_RELEASE_SUCCESSES, 10)
    || config.auto_drain_release_successes
    || 2;
const AUTO_DRAIN_LOAD_THRESHOLD = Number.isFinite(parseFloat(process.env.AUTO_DRAIN_LOAD_THRESHOLD))
    ? parseFloat(process.env.AUTO_DRAIN_LOAD_THRESHOLD)
    : (Number.isFinite(config.auto_drain_load_threshold) ? config.auto_drain_load_threshold : 0.85);
const AUTO_DRAIN_SCORE_PENALTY = Number.isFinite(parseFloat(process.env.AUTO_DRAIN_SCORE_PENALTY))
    ? parseFloat(process.env.AUTO_DRAIN_SCORE_PENALTY)
    : (Number.isFinite(config.auto_drain_score_penalty) ? config.auto_drain_score_penalty : 0.6);
const STICKY_ENABLED = process.env.STICKY_ENABLED === 'true'
    || (process.env.STICKY_ENABLED !== 'false' && config.sticky_enabled === true);
const STICKY_TTL_SEC = parseInt(process.env.STICKY_TTL_SEC, 10) || config.sticky_ttl_sec || 3600;
const STICKY_MAX_ENTRIES = parseInt(process.env.STICKY_MAX_ENTRIES, 10) || config.sticky_max_entries || 10000;
const BALANCER_LOAD_WEIGHT = Number.isFinite(parseFloat(process.env.BALANCER_LOAD_WEIGHT))
    ? parseFloat(process.env.BALANCER_LOAD_WEIGHT)
    : (Number.isFinite(config.balancer_load_weight) ? config.balancer_load_weight : 0.4);
const BALANCER_LATENCY_WEIGHT = Number.isFinite(parseFloat(process.env.BALANCER_LATENCY_WEIGHT))
    ? parseFloat(process.env.BALANCER_LATENCY_WEIGHT)
    : (Number.isFinite(config.balancer_latency_weight) ? config.balancer_latency_weight : 0.6);
const BALANCER_MAX_LATENCY_MS = parseInt(process.env.BALANCER_MAX_LATENCY_MS, 10)
    || config.balancer_max_latency_ms
    || 300;
const BALANCER_SMOOTHING_ALPHA = Number.isFinite(parseFloat(process.env.BALANCER_SMOOTHING_ALPHA))
    ? parseFloat(process.env.BALANCER_SMOOTHING_ALPHA)
    : (Number.isFinite(config.balancer_smoothing_alpha) ? config.balancer_smoothing_alpha : 0.35);
const BALANCER_HYSTERESIS_DELTA = Number.isFinite(parseFloat(process.env.BALANCER_HYSTERESIS_DELTA))
    ? parseFloat(process.env.BALANCER_HYSTERESIS_DELTA)
    : (Number.isFinite(config.balancer_hysteresis_delta) ? config.balancer_hysteresis_delta : 0.08);
const READY_SUCCESS_WINDOW_SEC = pickRuntimeInt('READY_SUCCESS_WINDOW_SEC', 'ready_success_window_sec');
const REQUEST_TIMEOUT_MS = pickRuntimeInt('REQUEST_TIMEOUT_MS', 'request_timeout_ms');
const MAX_REDIRECTS = pickRuntimeInt('MAX_REDIRECTS', 'max_redirects');
const CIRCUIT_BREAKER_FAILURES = pickRuntimeInt('CIRCUIT_BREAKER_FAILURES', 'circuit_breaker_failures');
const CIRCUIT_BREAKER_OPEN_SEC = pickRuntimeInt('CIRCUIT_BREAKER_OPEN_SEC', 'circuit_breaker_open_sec');
let FASTEST_EXCLUDE_GROUPS = Array.isArray(config.fastest_exclude_groups) ? config.fastest_exclude_groups : [];
const DEFAULT_FASTEST_GROUP_NAME = '🏁 🇪🇺 Самые быстрые';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || config.admin_token || '';
const WARMUP_TOKENS = Array.isArray(config.warmup_tokens) ? config.warmup_tokens : [];
let QUARANTINE_NODES = Array.isArray(config.quarantine_nodes)
    ? config.quarantine_nodes.filter((name) => typeof name === 'string' && name.trim().length > 0)
    : [];

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

// Кэш статистики нод: { "Finland2": { usersOnline: 9, totalRamGb: 2.06, cpuCount: 1, ramLoad: 4.37, cpuLoad: 9, load: 0.23 }, ... }
let nodeStatsCache = {};
let lastUpstreamSuccessAt = 0;
let lastUpstreamError = null;
let lastNodeStatsRefreshAt = 0;
let lastNodeStatsError = null;
const autoQuarantineState = new Map();
const subscriptionCache = createTokenCache(CACHE_TTL_SEC, CACHE_MAX_ENTRIES);
const rateLimiter = createRateLimiter(RATE_LIMIT_PER_MINUTE, RATE_LIMIT_BURST_10S);
const tokenRateLimiter = createKeyedRateLimiter(TOKEN_RATE_LIMIT_PER_MINUTE, TOKEN_RATE_LIMIT_BURST_10S, {
    maxEntries: TOKEN_LIMITER_MAX_ENTRIES,
    cleanupBatch: TOKEN_LIMITER_CLEANUP_BATCH,
});
const adminRateLimiter = createRateLimiter(ADMIN_RATE_LIMIT_PER_MINUTE, ADMIN_RATE_LIMIT_BURST_10S);
const circuitBreaker = createCircuitBreaker(CIRCUIT_BREAKER_FAILURES, CIRCUIT_BREAKER_OPEN_SEC);
const runtimeStats = {
    started_at: Date.now(),
    requests_total: 0,
    request_failures: 0,
    cache_fallback_total: 0,
    cache_fallback_stale_total: 0,
    circuit_open_total: 0,
    rate_limited_ip_total: 0,
    rate_limited_token_total: 0,
    upstream_non_json_total: 0,
    fake_config_passthrough_total: 0,
    quarantine_filtered_total: 0,
    sticky_assignments_total: 0,
    sticky_hits_total: 0,
    sticky_misses_total: 0,
};
const logger = buildLogger();
const requestGuard = createRequestGuard({
    ipLimiter: rateLimiter,
    tokenLimiter: tokenRateLimiter,
    circuitBreaker,
    stats: runtimeStats,
});
const autoDrainState = new Map();
const autoDrainNodes = new Set();
const balancerRankState = new Map();
const stickyStore = createStickyStore({
    ttlSec: STICKY_TTL_SEC,
    maxEntries: STICKY_MAX_ENTRIES,
});

// ─── Утилиты ───

function fetchUrl(targetUrl, headers = {}, maxRedirects = MAX_REDIRECTS) {
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
                const redirectUrl = new URL(res.headers.location, targetUrl);
                if (redirectUrl.protocol !== parsed.protocol || redirectUrl.host !== parsed.host) {
                    return reject(new Error('Unsafe redirect blocked'));
                }
                return fetchUrl(redirectUrl.href, headers, maxRedirects - 1).then(resolve).catch(reject);
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
        req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

function timingSafeEqualString(a, b) {
    const ba = Buffer.from(a || '');
    const bb = Buffer.from(b || '');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function isAdminAuthorized(req) {
    if (!ADMIN_TOKEN) return false;
    const headerToken = (req.headers['x-admin-token'] || '').toString();
    return timingSafeEqualString(headerToken, ADMIN_TOKEN);
}

function sanitizeAdminPath(pathname) {
    if (/^\/admin\/debug\/token\/[a-zA-Z0-9_-]+$/.test(pathname)) return '/admin/debug/token/:token';
    if (/^\/admin\/quarantine\/.+$/.test(pathname)) return '/admin/quarantine/:node';
    return pathname;
}

function resolveClientIp(req) {
    const remoteIp = (req.socket.remoteAddress || '127.0.0.1').toString().trim();
    if (!TRUST_X_FORWARDED_FOR) return remoteIp;
    const forwardedIp = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    return forwardedIp || remoteIp;
}

function enforceAdminAccess(req, res, requestId, clientIp, pathname) {
    if (!adminRateLimiter.allow(clientIp)) {
        logger.warn('admin_rate_limited', { request_id: requestId, ip: clientIp, path: sanitizeAdminPath(pathname) });
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', code: 'RATE_LIMITED', request_id: requestId }));
        return false;
    }

    if (!isAdminAuthorized(req)) {
        logger.warn('admin_auth_failed', { request_id: requestId, ip: clientIp, path: sanitizeAdminPath(pathname) });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', code: 'ADMIN_AUTH_REQUIRED', request_id: requestId }));
        return false;
    }

    return true;
}

function writeConfigFile(nextConfig) {
    const targetPath = CONFIG_RUNTIME_PATH || CONFIG_PATH;
    const payload = CONFIG_RUNTIME_PATH
        ? Object.fromEntries(MUTABLE_CONFIG_KEYS.map((key) => [key, nextConfig[key]]).filter(([_, value]) => value !== undefined))
        : nextConfig;

    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const tempPath = `${targetPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, targetPath);
}

function persistConfigIfPossible(nextConfig, requestId) {
    try {
        writeConfigFile(nextConfig);
        return { persisted: true, error: null };
    } catch (err) {
        logger.warn('config_persist_skipped', {
            request_id: requestId,
            error: err.message,
            config_path: CONFIG_PATH,
        });
        return { persisted: false, error: err.message };
    }
}

function upsertQuarantineNode(nodeName, requestId) {
    const normalized = normalizeNodeName(nodeName);
    if (!normalized) return { changed: false, persisted: true, error: null };
    const existing = new Set(QUARANTINE_NODES.map(normalizeNodeName));
    if (existing.has(normalized)) return { changed: false, persisted: true, error: null };

    if (QUARANTINE_NODES.length >= AUTO_QUARANTINE_MAX_NODES) {
        return { changed: false, persisted: false, error: 'AUTO_QUARANTINE_MAX_NODES reached' };
    }

    QUARANTINE_NODES = [...QUARANTINE_NODES, nodeName];
    const nextConfig = { ...config, quarantine_nodes: QUARANTINE_NODES };
    validateConfig(nextConfig);
    config = nextConfig;
    const persistResult = persistConfigIfPossible(nextConfig, requestId);
    return { changed: true, persisted: persistResult.persisted, error: persistResult.error };
}

function removeQuarantineNode(nodeName, requestId) {
    const normalized = normalizeNodeName(nodeName);
    if (!normalized) return { changed: false, persisted: true, error: null };
    const nextNodes = QUARANTINE_NODES.filter((name) => normalizeNodeName(name) !== normalized);
    if (nextNodes.length === QUARANTINE_NODES.length) return { changed: false, persisted: true, error: null };

    QUARANTINE_NODES = nextNodes;
    const nextConfig = { ...config, quarantine_nodes: QUARANTINE_NODES };
    validateConfig(nextConfig);
    config = nextConfig;
    const persistResult = persistConfigIfPossible(nextConfig, requestId);
    return { changed: true, persisted: persistResult.persisted, error: persistResult.error };
}

function updateAutoQuarantineFromNodes(nodes) {
    if (!AUTO_QUARANTINE_ENABLED || !Array.isArray(nodes) || nodes.length === 0) return;

    const requestId = `auto-quarantine-${Date.now()}`;
    const activeNames = new Set();
    const quarantinedSet = new Set(QUARANTINE_NODES.map(normalizeNodeName).filter(Boolean));

    for (const node of nodes) {
        const nodeName = (node.name || '').toString().trim();
        if (!nodeName) continue;
        activeNames.add(nodeName);

        const isConnected = Boolean(node.isConnected);
        const isDisabled = Boolean(node.isDisabled);
        const usersOnline = node.usersOnline || 0;
        const totalRamGb = parseRamGb(node.totalRam);
        const cpuCount = node.cpuCount || 1;
        const { load } = computeNodeLoad(usersOnline, totalRamGb, cpuCount);
        const degraded = !isConnected || isDisabled || load > 1.0;

        const prev = autoQuarantineState.get(nodeName) || { fail: 0, ok: 0, auto: false };
        if (degraded) {
            prev.fail += 1;
            prev.ok = 0;
        } else {
            prev.ok += 1;
            prev.fail = 0;
        }

        const normalizedNodeName = normalizeNodeName(nodeName);
        const currentlyQuarantined = quarantinedSet.has(normalizedNodeName);
        if (!currentlyQuarantined && prev.fail >= AUTO_QUARANTINE_FAILURES) {
            const result = upsertQuarantineNode(nodeName, requestId);
            if (result.changed) {
                prev.auto = true;
                quarantinedSet.add(normalizedNodeName);
                logger.warn('auto_quarantine_added', {
                    node: nodeName,
                    fail_count: prev.fail,
                    degraded,
                    persisted: result.persisted,
                    persist_error: result.error,
                });
            }
        } else if (currentlyQuarantined && prev.auto && prev.ok >= AUTO_QUARANTINE_RELEASE_SUCCESSES) {
            const result = removeQuarantineNode(nodeName, requestId);
            if (result.changed) {
                prev.auto = false;
                quarantinedSet.delete(normalizedNodeName);
                logger.info('auto_quarantine_released', {
                    node: nodeName,
                    success_count: prev.ok,
                    persisted: result.persisted,
                    persist_error: result.error,
                });
            }
        }

        autoQuarantineState.set(nodeName, prev);
    }

    for (const nodeName of autoQuarantineState.keys()) {
        if (!activeNames.has(nodeName)) {
            autoQuarantineState.delete(nodeName);
        }
    }
}

function readJsonBody(req, maxBytes = 512 * 1024) {
    return new Promise((resolve, reject) => {
        let raw = '';
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('Payload too large'));
                req.destroy();
                return;
            }
            raw += chunk;
        });
        req.on('end', () => {
            if (!raw.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
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

function computeNodeLoad(usersOnline, totalRamGb, cpuCount) {
    const ramLoad = totalRamGb > 0 ? usersOnline / totalRamGb : 999;
    const cpuLoad = cpuCount > 0 ? usersOnline / cpuCount : 999;
    const ramNorm = ramLoad / MAX_USERS_PER_GB;
    const cpuNorm = cpuLoad / MAX_USERS_PER_CPU;
    const load = Math.max(ramNorm, cpuNorm);
    return { ramLoad, cpuLoad, load };
}

function updateAutoDrainFromNodes(nodes) {
    if (!AUTO_DRAIN_ENABLED || !Array.isArray(nodes) || nodes.length === 0) return;

    const activeNames = new Set();
    for (const node of nodes) {
        const nodeName = (node.name || '').toString().trim();
        if (!nodeName) continue;
        activeNames.add(nodeName);

        const usersOnline = node.usersOnline || 0;
        const totalRamGb = parseRamGb(node.totalRam);
        const cpuCount = node.cpuCount || 1;
        const isConnected = Boolean(node.isConnected);
        const isDisabled = Boolean(node.isDisabled);
        const { load } = computeNodeLoad(usersOnline, totalRamGb, cpuCount);
        const degraded = !isConnected || isDisabled || load >= AUTO_DRAIN_LOAD_THRESHOLD;

        const prev = autoDrainState.get(nodeName) || { fail: 0, ok: 0, drained: false };
        if (degraded) {
            prev.fail += 1;
            prev.ok = 0;
        } else {
            prev.ok += 1;
            prev.fail = 0;
        }

        const normalizedName = normalizeNodeName(nodeName);
        if (!prev.drained && prev.fail >= AUTO_DRAIN_FAILURES) {
            prev.drained = true;
            if (normalizedName) autoDrainNodes.add(normalizedName);
            logger.warn('auto_drain_added', {
                node: nodeName,
                load,
                fail_count: prev.fail,
                threshold: AUTO_DRAIN_LOAD_THRESHOLD,
            });
        } else if (prev.drained && prev.ok >= AUTO_DRAIN_RELEASE_SUCCESSES) {
            prev.drained = false;
            if (normalizedName) autoDrainNodes.delete(normalizedName);
            logger.info('auto_drain_released', {
                node: nodeName,
                load,
                success_count: prev.ok,
            });
        }

        autoDrainState.set(nodeName, prev);
    }

    for (const nodeName of autoDrainState.keys()) {
        if (!activeNames.has(nodeName)) {
            autoDrainState.delete(nodeName);
            autoDrainNodes.delete(normalizeNodeName(nodeName));
        }
    }
}

// ─── Node Stats — опрос панели ───

async function fetchNodeStats() {
    if (!API_TOKEN || !REMNAWAVE_URL) {
        lastNodeStatsError = 'API token or REMNAWAVE_URL is missing';
        return { ok: false, error: lastNodeStatsError };
    }
    try {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/nodes/`, panelHeaders());
        if (response.status !== 200) {
            console.error('[node-stats] API вернул', response.status);
            lastNodeStatsError = `Panel API returned ${response.status}`;
            return { ok: false, error: lastNodeStatsError };
        }
        const data = JSON.parse(response.body);
        const nodes = data.response || (Array.isArray(data) ? data : []);
        updateAutoDrainFromNodes(nodes);
        updateAutoQuarantineFromNodes(nodes);

        const newCache = {};
        for (const node of nodes) {
            const name = node.name || '';
            const address = typeof node.address === 'string' ? node.address.trim() : '';
            const usersOnline = node.usersOnline || 0;
            const totalRamGb = parseRamGb(node.totalRam);
            const cpuCount = node.cpuCount || 1;
            const isConnected = node.isConnected || false;
            const isDisabled = node.isDisabled || false;

            const { ramLoad, cpuLoad, load } = computeNodeLoad(usersOnline, totalRamGb, cpuCount);
            const normalizedLoad = Math.round(load * 100) / 100;

            newCache[name] = {
                usersOnline,
                totalRamGb,
                cpuCount,
                ramLoad: Math.round(ramLoad * 100) / 100,
                cpuLoad: Math.round(cpuLoad * 100) / 100,
                load: normalizedLoad,
                isConnected,
                isDisabled,
                isAlias: false,
                sourceNode: name,
            };

            if (address && address !== name) {
                newCache[address] = {
                    ...newCache[name],
                    isAlias: true,
                    sourceNode: name,
                };
            }

            // Также кэшируем по тегам inbound'ов (для матчинга с outbound тегами)
            if (node.configProfile && node.configProfile.activeInbounds) {
                for (const inb of node.configProfile.activeInbounds) {
                    if (inb.tag && inb.tag !== name) {
                        newCache[inb.tag] = {
                            ...newCache[name],
                            isAlias: true,
                            sourceNode: name,
                        };
                    }
                }
            }
        }

        nodeStatsCache = newCache;
        const sorted = Object.entries(newCache)
            .filter(([_, s]) => s.isConnected && !s.isDisabled)
            .sort((a, b) => a[1].load - b[1].load);

        console.log(`[node-stats] Обновлено: ${sorted.length} нод (пороги: ${MAX_USERS_PER_GB} u/GB, ${MAX_USERS_PER_CPU} u/CPU)`);
        for (const [name, s] of sorted.slice(0, 5)) {
            console.log(`  ${name}: ${s.usersOnline}u, ${s.totalRamGb}GB/${s.cpuCount}CPU, ram=${s.ramLoad} cpu=${s.cpuLoad} load=${s.load}`);
        }
        if (sorted.length > 5) console.log(`  ... и ещё ${sorted.length - 5}`);
        lastNodeStatsRefreshAt = Date.now();
        lastNodeStatsError = null;
        return { ok: true, nodes: sorted.length };

    } catch (err) {
        console.error('[node-stats] Ошибка:', err.message);
        lastNodeStatsError = err.message;
        return { ok: false, error: lastNodeStatsError };
    }
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
    if (!API_TOKEN) return { ok: false, error: 'API token is missing', hosts: null };
    try {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/hosts/`, panelHeaders());
        if (response.status !== 200) return { ok: false, error: `Panel API returned ${response.status}`, hosts: null };
        const data = JSON.parse(response.body);
        const hosts = data.response || (Array.isArray(data) ? data : null);
        if (!hosts) return { ok: false, error: 'Panel API response does not contain hosts', hosts: null };
        return { ok: true, error: null, hosts };
    } catch (err) {
        console.error('[auto-groups] Ошибка:', err.message);
        return { ok: false, error: err.message, hosts: null };
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
    const hostsResult = await fetchHostsFromApi();
    if (!hostsResult.ok || !hostsResult.hosts) return { ok: false, error: hostsResult.error || 'Failed to fetch hosts' };
    const hosts = hostsResult.hosts;
    const newGroups = buildGroupsFromHosts(hosts);
    if (Object.keys(newGroups).length === 0) return { ok: false, error: 'No groups detected from enabled hosts' };
    GROUPS = { ...newGroups, ...(config.groups || {}) };
    console.log(`[auto-groups] Обновлены: ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v}]`).join(' | ')}`);
    return { ok: true, groups: GROUPS };
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

            const cloned = { ...ob };

            let tag = cloned.tag;
            if (tag === 'proxy' && remarks) {
                tag = remarks;
            }
            if (seenTags.has(tag)) {
                const baseTag = tag;
                let suffix = i;
                while (seenTags.has(tag)) {
                    tag = `${baseTag}-${suffix}`;
                    suffix += 1;
                }
            }
            cloned.tag = tag;
            seenTags.add(tag);
            allOutbounds.push(cloned);
        }
    }

    return allOutbounds;
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

function getCachedFallback(token) {
    const fresh = subscriptionCache.get(token);
    if (fresh) return { kind: 'fresh', item: fresh };
    const stale = subscriptionCache.getStale(token, CACHE_STALE_IF_ERROR_SEC);
    if (stale) return { kind: 'stale', item: stale };
    return null;
}

function toIsoTimestamp(ms) {
    return ms > 0 ? new Date(ms).toISOString() : null;
}

function normalizeNodeName(value) {
    return (value || '').toString().trim().toLowerCase();
}

function buildQuarantineSet() {
    return new Set(QUARANTINE_NODES.map(normalizeNodeName).filter(Boolean));
}

function isNodeQuarantined(tag, quarantineSet) {
    const normalizedTag = normalizeNodeName(tag);
    if (!normalizedTag || quarantineSet.size === 0) return false;
    if (quarantineSet.has(normalizedTag)) return true;

    for (const entry of quarantineSet) {
        if (entry.length < 3) continue;
        if (normalizedTag.includes(entry) || entry.includes(normalizedTag)) return true;
    }
    return false;
}

async function warmupToken(token) {
    const targetUrl = SUB_PAGE_URL
        ? `${SUB_PAGE_URL}/${token}`
        : `${REMNAWAVE_URL}${REMNAWAVE_SUB_PATH}/${token}`;
    try {
        const upstream = await fetchUrl(targetUrl, { 'user-agent': 'Happ/1.0' });
        if (upstream.status !== 200) return false;
        const classified = classifyUpstreamPayload(upstream.body);
        if (classified.type === 'xray_json') {
            subscriptionCache.set(token, upstream.body, upstream.headers);
            lastUpstreamSuccessAt = Date.now();
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    const clientIp = resolveClientIp(req);

    if (pathname === '/health' || pathname === '/mw-health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            request_id: requestId,
            groups: Object.keys(GROUPS),
            auto_groups: AUTO_GROUPS,
            fastest_group: config.fastest_group !== false,
            node_stats: NODE_STATS_ENABLED,
            panel_auth: PANEL_AUTH_COOKIE ? true : false,
            cached_nodes: Object.keys(nodeStatsCache).length,
            quarantine_nodes: QUARANTINE_NODES,
            quarantine_count: QUARANTINE_NODES.length,
            auto_quarantine_enabled: AUTO_QUARANTINE_ENABLED,
            auto_drain_enabled: AUTO_DRAIN_ENABLED,
            auto_drain_count: autoDrainNodes.size,
            sticky_enabled: STICKY_ENABLED,
            sticky: stickyStore.summary(),
            sub_page: SUB_PAGE_URL || 'disabled',
        }));
        return;
    }

    if (pathname === '/admin/groups') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }

        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                groups: GROUPS,
                fastest_group: config.fastest_group !== false,
                fastest_group_name: (config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME),
                fastest_exclude_groups: FASTEST_EXCLUDE_GROUPS,
                quarantine_nodes: QUARANTINE_NODES,
                auto_quarantine_enabled: config.auto_quarantine_enabled === true,
                auto_quarantine_failures: config.auto_quarantine_failures,
                auto_quarantine_release_successes: config.auto_quarantine_release_successes,
                auto_quarantine_max_nodes: config.auto_quarantine_max_nodes,
                auto_drain_enabled: config.auto_drain_enabled === true,
                auto_drain_failures: config.auto_drain_failures,
                auto_drain_release_successes: config.auto_drain_release_successes,
                auto_drain_load_threshold: config.auto_drain_load_threshold,
                auto_drain_score_penalty: config.auto_drain_score_penalty,
                sticky_enabled: config.sticky_enabled === true,
                sticky_ttl_sec: config.sticky_ttl_sec,
                sticky_max_entries: config.sticky_max_entries,
                balancer_load_weight: config.balancer_load_weight,
                balancer_latency_weight: config.balancer_latency_weight,
                balancer_max_latency_ms: config.balancer_max_latency_ms,
                balancer_smoothing_alpha: config.balancer_smoothing_alpha,
                balancer_hysteresis_delta: config.balancer_hysteresis_delta,
            }));
            return;
        }

        if (req.method !== 'PUT') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'METHOD_NOT_ALLOWED', request_id: requestId }));
            return;
        }

        try {
            const payload = await readJsonBody(req);
            const incomingGroups = payload.groups;
            const incomingExclude = payload.fastest_exclude_groups;
            const incomingFastest = payload.fastest_group;
            const incomingFastestName = payload.fastest_group_name;

            const nextConfig = { ...config };
            if (incomingGroups !== undefined) nextConfig.groups = incomingGroups;
            if (incomingExclude !== undefined) nextConfig.fastest_exclude_groups = incomingExclude;
            if (incomingFastest !== undefined) nextConfig.fastest_group = incomingFastest;
            if (incomingFastestName !== undefined) nextConfig.fastest_group_name = incomingFastestName;
            for (const key of MUTABLE_CONFIG_KEYS) {
                if (payload[key] !== undefined) {
                    nextConfig[key] = payload[key];
                }
            }

            validateConfig(nextConfig);
            config = nextConfig;
            GROUPS = nextConfig.groups || {};
            FASTEST_EXCLUDE_GROUPS = Array.isArray(nextConfig.fastest_exclude_groups) ? nextConfig.fastest_exclude_groups : [];
            const persistResult = persistConfigIfPossible(nextConfig, requestId);

            logger.info('admin_groups_updated', {
                request_id: requestId,
                groups_count: Object.keys(GROUPS).length,
                fastest_group: config.fastest_group !== false,
                fastest_group_name: (config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME),
                fastest_exclude_groups_count: FASTEST_EXCLUDE_GROUPS.length,
                persisted: persistResult.persisted,
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                groups: GROUPS,
                fastest_group: config.fastest_group !== false,
                fastest_group_name: (config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME),
                fastest_exclude_groups: FASTEST_EXCLUDE_GROUPS,
                quarantine_nodes: QUARANTINE_NODES,
                auto_quarantine_enabled: config.auto_quarantine_enabled === true,
                auto_quarantine_failures: config.auto_quarantine_failures,
                auto_quarantine_release_successes: config.auto_quarantine_release_successes,
                auto_quarantine_max_nodes: config.auto_quarantine_max_nodes,
                auto_drain_enabled: config.auto_drain_enabled === true,
                auto_drain_failures: config.auto_drain_failures,
                auto_drain_release_successes: config.auto_drain_release_successes,
                auto_drain_load_threshold: config.auto_drain_load_threshold,
                auto_drain_score_penalty: config.auto_drain_score_penalty,
                sticky_enabled: config.sticky_enabled === true,
                sticky_ttl_sec: config.sticky_ttl_sec,
                sticky_max_entries: config.sticky_max_entries,
                balancer_load_weight: config.balancer_load_weight,
                balancer_latency_weight: config.balancer_latency_weight,
                balancer_max_latency_ms: config.balancer_max_latency_ms,
                balancer_smoothing_alpha: config.balancer_smoothing_alpha,
                balancer_hysteresis_delta: config.balancer_hysteresis_delta,
                persisted: persistResult.persisted,
                persist_error: persistResult.error,
            }));
            return;
        } catch (err) {
            logger.error('admin_groups_update_failed', { request_id: requestId, error: err.message });
            const code = err.message === 'Invalid JSON body' ? 400 : 422;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', request_id: requestId, message: err.message }));
            return;
        }
    }

    if (pathname === '/ready') {
        const healthyWindowMs = READY_SUCCESS_WINDOW_SEC * 1000;
        const hasRecentUpstream = lastUpstreamSuccessAt > 0 && (Date.now() - lastUpstreamSuccessAt) <= healthyWindowMs;
        const hasCache = subscriptionCache.hasFreshAny();
        const ready = hasRecentUpstream || hasCache;
        const cb = circuitBreaker.status();
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: ready ? 'ready' : 'not_ready',
            request_id: requestId,
            has_recent_upstream: hasRecentUpstream,
            has_cache: hasCache,
            cache_ttl_sec: CACHE_TTL_SEC,
            circuit_open: cb.open,
            last_upstream_success_at: toIsoTimestamp(lastUpstreamSuccessAt),
            last_upstream_error: lastUpstreamError,
            last_node_stats_refresh_at: toIsoTimestamp(lastNodeStatsRefreshAt),
            last_node_stats_error: lastNodeStatsError,
            token_limiter_size: tokenRateLimiter.size(),
        }));
        return;
    }

    const adminDebugTokenMatch = pathname.match(/^\/admin\/debug\/token\/([a-zA-Z0-9_-]+)$/);
    const debugTokenValue = adminDebugTokenMatch?.[1] || null;

    if (pathname === '/admin/node-stats') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        const quarantineSet = buildQuarantineSet();
        const enriched = Object.fromEntries(
            Object.entries(nodeStatsCache).map(([name, stats]) => [
                name,
                {
                    ...stats,
                    quarantined: isNodeQuarantined(name, quarantineSet),
                },
            ]),
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(enriched, null, 2));
        return;
    }

    if (pathname === '/admin/quarantine') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }

        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                quarantine_nodes: QUARANTINE_NODES,
                quarantine_count: QUARANTINE_NODES.length,
            }));
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'METHOD_NOT_ALLOWED', request_id: requestId }));
            return;
        }

        try {
            const payload = await readJsonBody(req);
            const nodeRaw = (payload.node || '').toString().trim();
            if (!nodeRaw) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', code: 'NODE_REQUIRED', request_id: requestId }));
                return;
            }
            const normalized = normalizeNodeName(nodeRaw);
            const existing = new Set(QUARANTINE_NODES.map(normalizeNodeName));
            if (!existing.has(normalized)) {
                QUARANTINE_NODES = [...QUARANTINE_NODES, nodeRaw];
                const nextConfig = { ...config, quarantine_nodes: QUARANTINE_NODES };
                validateConfig(nextConfig);
                config = nextConfig;
                const persistResult = persistConfigIfPossible(nextConfig, requestId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    request_id: requestId,
                    quarantine_nodes: QUARANTINE_NODES,
                    quarantine_count: QUARANTINE_NODES.length,
                    persisted: persistResult.persisted,
                    persist_error: persistResult.error,
                }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                quarantine_nodes: QUARANTINE_NODES,
                quarantine_count: QUARANTINE_NODES.length,
                persisted: true,
                persist_error: null,
            }));
            return;
        } catch (err) {
            const code = err.message === 'Invalid JSON body' ? 400 : 422;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', request_id: requestId, message: err.message }));
            return;
        }
    }

    const adminQuarantineDeleteMatch = pathname.match(/^\/admin\/quarantine\/(.+)$/);
    if (adminQuarantineDeleteMatch) {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (req.method !== 'DELETE') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'METHOD_NOT_ALLOWED', request_id: requestId }));
            return;
        }

        let nodeRaw = '';
        try {
            nodeRaw = decodeURIComponent(adminQuarantineDeleteMatch[1] || '').trim();
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'INVALID_PATH_ENCODING', request_id: requestId }));
            return;
        }
        const normalized = normalizeNodeName(nodeRaw);
        if (!normalized) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'NODE_REQUIRED', request_id: requestId }));
            return;
        }

        QUARANTINE_NODES = QUARANTINE_NODES.filter((name) => normalizeNodeName(name) !== normalized);
        const nextConfig = { ...config, quarantine_nodes: QUARANTINE_NODES };
        validateConfig(nextConfig);
        config = nextConfig;
        const persistResult = persistConfigIfPossible(nextConfig, requestId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            request_id: requestId,
            quarantine_nodes: QUARANTINE_NODES,
            quarantine_count: QUARANTINE_NODES.length,
            persisted: persistResult.persisted,
            persist_error: persistResult.error,
        }));
        return;
    }

    if (pathname === '/admin/refresh-groups') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (!API_TOKEN) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'REFRESH_GROUPS_FAILED', request_id: requestId, message: 'API token is missing' }));
            return;
        }
        const refreshed = await refreshGroups();
        if (!refreshed.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'REFRESH_GROUPS_FAILED', request_id: requestId, message: refreshed.error }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', groups: GROUPS }));
        return;
    }

    if (pathname === '/admin/refresh-stats') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (!API_TOKEN) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'REFRESH_STATS_FAILED', request_id: requestId, message: 'API token is missing' }));
            return;
        }
        const refreshed = await fetchNodeStats();
        if (!refreshed.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'REFRESH_STATS_FAILED', request_id: requestId, message: refreshed.error }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', nodes: nodeStatsCache }));
        return;
    }

    if (pathname === '/admin/debug/stats') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        const cb = circuitBreaker.status();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            request_id: requestId,
            profile_mode: PROFILE.name,
            runtime_stats: runtimeStats,
            circuit_breaker: cb,
            quarantine_nodes: QUARANTINE_NODES,
            quarantine_count: QUARANTINE_NODES.length,
            sticky_enabled: STICKY_ENABLED,
            sticky: stickyStore.summary(),
        }));
        return;
    }

    if (debugTokenValue) {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        const debugToken = debugTokenValue;
        const debugTarget = SUB_PAGE_URL
            ? `${SUB_PAGE_URL}/${debugToken}`
            : `${REMNAWAVE_URL}${REMNAWAVE_SUB_PATH}/${debugToken}`;
        const fallback = getCachedFallback(debugToken);
        let upstreamType = 'unavailable';
        let upstreamBytes = 0;
        let upstreamStatus = null;
        let upstreamError = null;

        try {
            const upstream = await fetchUrl(debugTarget, {});
            upstreamStatus = upstream.status;
            upstreamBytes = upstream.body.length;
            const classified = classifyUpstreamPayload(upstream.body);
            upstreamType = classified.type;
        } catch (err) {
            upstreamError = err.message;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            request_id: requestId,
            token: redactTokenPath(`/${debugToken}`).slice(1),
            profile_mode: PROFILE.name,
            upstream: {
                status: upstreamStatus,
                bytes: upstreamBytes,
                type: upstreamType,
                error: upstreamError,
            },
            cache: {
                has_fallback: Boolean(fallback),
                fallback_kind: fallback ? fallback.kind : null,
            },
            settings: {
                cache_ttl_sec: CACHE_TTL_SEC,
                cache_stale_if_error_sec: CACHE_STALE_IF_ERROR_SEC,
                cache_max_entries: CACHE_MAX_ENTRIES,
                rate_limit_per_minute: RATE_LIMIT_PER_MINUTE,
                rate_limit_burst_10s: RATE_LIMIT_BURST_10S,
                token_rate_limit_per_minute: TOKEN_RATE_LIMIT_PER_MINUTE,
                token_rate_limit_burst_10s: TOKEN_RATE_LIMIT_BURST_10S,
            },
            circuit_breaker: circuitBreaker.status(),
            sticky: {
                enabled: STICKY_ENABLED,
                assigned_node: STICKY_ENABLED ? stickyStore.get(debugToken)?.nodeName || null : null,
            },
        }));
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

    const safePath = redactTokenPath(pathname);
    runtimeStats.requests_total += 1;
    const guardDecision = requestGuard.evaluate(clientIp, token);
    if (!guardDecision.ok) {
        if (guardDecision.code === 'RATE_LIMITED') {
            logger.warn('rate_limited', { request_id: requestId, ip: clientIp, path: safePath });
        } else if (guardDecision.code === 'TOKEN_RATE_LIMITED') {
            logger.warn('token_rate_limited', { request_id: requestId, path: safePath });
        }

        if (guardDecision.allowFallback) {
            const fallback = getCachedFallback(token);
            if (fallback) {
                runtimeStats.cache_fallback_total += 1;
                if (fallback.kind === 'stale') runtimeStats.cache_fallback_stale_total += 1;
                logger.warn('cache_fallback_circuit_open', { request_id: requestId, cache_kind: fallback.kind });
                res.writeHead(200, forwardResponseHeaders(fallback.item.headers, 'application/json; charset=utf-8'));
                res.end(fallback.item.body);
                return;
            }
        }

        res.writeHead(guardDecision.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', code: guardDecision.code, request_id: requestId }));
        return;
    }
    logger.info('request_start', { request_id: requestId, method: req.method, path: safePath, ip: clientIp });

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
            forwardHeaders['X-Forwarded-Proto'] = 'https';
            forwardHeaders['X-Forwarded-For'] = clientIp;
            forwardHeaders['X-Real-IP'] = clientIp;
            forwardHeaders['Host'] = SUB_DOMAIN || req.headers['host'] || 'localhost';
        }

        const clientMeta = sanitizeClientMetadata(req);
        logger.info('request_meta', {
            request_id: requestId,
            hwid: clientMeta.hwid,
            device: clientMeta.device,
            os: clientMeta.os,
        });

        const upstream = await fetchUrl(targetUrl, forwardHeaders);
        logger.info('upstream_response', {
            request_id: requestId,
            status: upstream.status,
            bytes: upstream.body.length,
        });

        if (upstream.status !== 200) {
            lastUpstreamError = `upstream_status_${upstream.status}`;
            circuitBreaker.recordFailure();
            const fallback = getCachedFallback(token);
            if (fallback) {
                runtimeStats.cache_fallback_total += 1;
                if (fallback.kind === 'stale') runtimeStats.cache_fallback_stale_total += 1;
                logger.warn('cache_fallback_by_status', { request_id: requestId, status: upstream.status, cache_kind: fallback.kind });
                res.writeHead(200, forwardResponseHeaders(fallback.item.headers, 'application/json; charset=utf-8'));
                res.end(fallback.item.body);
                return;
            }
            res.writeHead(upstream.status, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        const classified = classifyUpstreamPayload(upstream.body);
        if (classified.type === 'non_json') {
            runtimeStats.upstream_non_json_total += 1;
            circuitBreaker.recordSuccess();
            lastUpstreamSuccessAt = Date.now();
            lastUpstreamError = null;
            logger.info('upstream_non_json_passthrough', { request_id: requestId });
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        let configArray = classified.parsed;

        if (configArray.length === 0) {
            lastUpstreamSuccessAt = Date.now();
            lastUpstreamError = null;
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        const baseConfig = configArray[0];

        // Детектируем фейковые конфиги — когда Remnawave возвращает сообщение об ошибке
        // (лимит устройств, истекла подписка и т.д.) вместо реальных серверов.
        // Признак: все прокси-outbound'ы имеют адрес 0.0.0.0 и порт 1.
        if (classified.type === 'fake_config') {
            runtimeStats.fake_config_passthrough_total += 1;
            circuitBreaker.recordSuccess();
            lastUpstreamSuccessAt = Date.now();
            lastUpstreamError = null;
            logger.info('fake_config_passthrough', { request_id: requestId });
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        let allOutbounds = collectAllProxyOutbounds(configArray);
        logger.info('outbounds_collected', { request_id: requestId, count: allOutbounds.length });

        if (allOutbounds.length === 0) {
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        // ─── Фильтрация и сортировка по нагрузке ───
        if (NODE_STATS_ENABLED && Object.keys(nodeStatsCache).length > 0) {
            const before = allOutbounds.length;
            allOutbounds = filterAndSortByLoad(allOutbounds, nodeStatsCache, {
                drainSet: autoDrainNodes,
                rankState: balancerRankState,
                keepOverloadedWhenDrained: true,
                drainPenalty: AUTO_DRAIN_SCORE_PENALTY,
                loadWeight: BALANCER_LOAD_WEIGHT,
                latencyWeight: BALANCER_LATENCY_WEIGHT,
                maxLatencyMs: BALANCER_MAX_LATENCY_MS,
                smoothingAlpha: BALANCER_SMOOTHING_ALPHA,
                hysteresisDelta: BALANCER_HYSTERESIS_DELTA,
            });
            const after = allOutbounds.length;
            if (before !== after) {
                logger.info('outbounds_filtered_by_load', { request_id: requestId, before, after });
            }
        }

        const quarantineSet = buildQuarantineSet();
        if (quarantineSet.size > 0) {
            const before = allOutbounds.length;
            allOutbounds = allOutbounds.filter((ob) => !isNodeQuarantined(ob.tag, quarantineSet));
            const removed = before - allOutbounds.length;
            if (removed > 0) {
                runtimeStats.quarantine_filtered_total += removed;
                logger.info('outbounds_filtered_by_quarantine', {
                    request_id: requestId,
                    before,
                    after: allOutbounds.length,
                    quarantine_count: QUARANTINE_NODES.length,
                });
            }
        }

        if (allOutbounds.length === 0) {
            logger.warn('all_outbounds_quarantined', { request_id: requestId, quarantine_count: QUARANTINE_NODES.length });
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        // ─── Группируем ───
        const grouped = {};
        const ungrouped = [];
        const configuredGroupOrder = Object.keys(GROUPS);

        // Preserve explicit admin order even if some groups are empty.
        for (const groupName of configuredGroupOrder) {
            grouped[groupName] = [];
        }

        for (const ob of allOutbounds) {
            const group = matchGroup(GROUPS, ob.tag);
            if (group) {
                if (!grouped[group]) grouped[group] = [];
                grouped[group].push(ob);
            } else {
                ungrouped.push(ob);
            }
        }

        if (ungrouped.length > 0) {
            const firstGroup = configuredGroupOrder[0] || Object.keys(grouped)[0];
            if (firstGroup) {
                grouped[firstGroup].push(...ungrouped);
                logger.info('ungrouped_appended', { request_id: requestId, count: ungrouped.length, group: firstGroup });
            } else {
                grouped['🌐 Other'] = ungrouped;
            }
        }

        // Внутригрупповой порядок уже унаследован из allOutbounds после score-based сортировки.

        // ─── Конфиги ───
        const resultConfigs = [];

        // ⚡ Fastest
        const fastestEnabled = config.fastest_group !== false;
        const excludedTags = new Set();
        for (const [groupName, outbounds] of Object.entries(grouped)) {
            if (FASTEST_EXCLUDE_GROUPS.includes(groupName)) {
                for (const outbound of outbounds) excludedTags.add(outbound.tag);
            }
        }
        const fastestOutbounds = excludedTags.size > 0
            ? allOutbounds.filter(outbound => !excludedTags.has(outbound.tag))
            : allOutbounds;

        if (fastestEnabled && fastestOutbounds.length > 1) {
            let selectedFastestOutbounds = fastestOutbounds;
            if (STICKY_ENABLED) {
                const stickyChoice = stickyStore.choose(token, fastestOutbounds);
                if (stickyChoice.selected) {
                    selectedFastestOutbounds = [stickyChoice.selected];
                    if (stickyChoice.changed) {
                        runtimeStats.sticky_assignments_total += 1;
                        logger.info('sticky_assigned', {
                            request_id: requestId,
                            token: redactTokenPath(`/${token}`).slice(1),
                            node: stickyChoice.selected.tag,
                        });
                    } else {
                        runtimeStats.sticky_hits_total += 1;
                    }
                } else {
                    runtimeStats.sticky_misses_total += 1;
                }
            }
            const fastestGroupName = (config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME);
            const fastestConfig = buildGroupConfig(baseConfig, fastestGroupName, selectedFastestOutbounds, {
                probeUrl: PROBE_URL,
                probeInterval: PROBE_INTERVAL,
                strategy: STRATEGY,
            });
            resultConfigs.push(fastestConfig);
            logger.info('group_fastest', {
                request_id: requestId,
                count: selectedFastestOutbounds.length,
                source_count: fastestOutbounds.length,
                sticky_enabled: STICKY_ENABLED,
                excluded_groups: FASTEST_EXCLUDE_GROUPS,
            });
        }

        // Группы по странам
        const responseGroupOrder = [...configuredGroupOrder, ...Object.keys(grouped).filter((name) => !configuredGroupOrder.includes(name))];
        for (const groupName of responseGroupOrder) {
            const outbounds = grouped[groupName] || [];
            if (outbounds.length === 0) continue;
            const groupConfig = buildGroupConfig(baseConfig, groupName, outbounds, {
                probeUrl: PROBE_URL,
                probeInterval: PROBE_INTERVAL,
                strategy: STRATEGY,
            });
            resultConfigs.push(groupConfig);

            // Логируем порядок серверов если есть стата
            if (NODE_STATS_ENABLED && Object.keys(nodeStatsCache).length > 0) {
                const order = outbounds.map(ob => {
                    const s = getNodeStats(nodeStatsCache, ob);
                    return s ? `${ob.tag}(${s.usersOnline}u/${s.totalRamGb}G/${s.cpuCount}C)` : ob.tag;
                }).join(', ');
                logger.info('group_built', { request_id: requestId, group: groupName, count: outbounds.length, order });
            } else {
                logger.info('group_built', { request_id: requestId, group: groupName, count: outbounds.length });
            }
        }

        logger.info('response_built', { request_id: requestId, groups: resultConfigs.length, servers: allOutbounds.length });

        const responseBody = JSON.stringify(resultConfigs, null, 2);
        circuitBreaker.recordSuccess();
        lastUpstreamSuccessAt = Date.now();
        lastUpstreamError = null;
        subscriptionCache.set(token, responseBody, upstream.headers);

        const responseHeaders = forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8');

        res.writeHead(200, responseHeaders);
        res.end(responseBody);

    } catch (err) {
        runtimeStats.request_failures += 1;
        lastUpstreamError = err.message;
        circuitBreaker.recordFailure();
        logger.error('request_failed', { request_id: requestId, message: err.message });
        const fallback = getCachedFallback(token);
        if (fallback) {
            runtimeStats.cache_fallback_total += 1;
            if (fallback.kind === 'stale') runtimeStats.cache_fallback_stale_total += 1;
            logger.warn('cache_fallback_by_error', { request_id: requestId, cache_kind: fallback.kind });
            res.writeHead(200, forwardResponseHeaders(fallback.item.headers, 'application/json; charset=utf-8'));
            res.end(fallback.item.body);
            return;
        }
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

    if (WARMUP_TOKENS.length > 0) {
        let warmed = 0;
        for (const token of WARMUP_TOKENS) {
            if (await warmupToken(token)) warmed += 1;
        }
        console.log(`🔥 Warmup: ${warmed}/${WARMUP_TOKENS.length} токенов`);
    }

    const fastestEnabled = config.fastest_group !== false;

    server.listen(PORT, () => {
        console.log(`\n🚀 Xray Balancer Middleware — порт ${PORT}`);
        console.log(`📋 Группы: ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v.join(',')}]`).join(' | ')}`);
        const fastestLabel = config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME;
        console.log(`🏁 Fastest group (${fastestLabel}): ${fastestEnabled ? '✅' : '❌'}`);
        console.log(`🎯 Стратегия: ${STRATEGY} (expected=1, baselines=1s, tolerance=0.8)`);
        console.log(`🧭 Profile: ${PROFILE.name}`);
        console.log(`📡 Probe: ${PROBE_URL} каждые ${PROBE_INTERVAL}`);
        console.log(`📊 Node stats: ${NODE_STATS_ENABLED ? `✅ (каждые ${NODE_STATS_INTERVAL/1000}с, макс ${MAX_USERS_PER_GB} u/GB, ${MAX_USERS_PER_CPU} u/CPU)` : '❌'}`);
        console.log(`🗃️ Cache: ttl=${CACHE_TTL_SEC}s stale-if-error=${CACHE_STALE_IF_ERROR_SEC}s max_entries=${CACHE_MAX_ENTRIES}`);
        console.log(`🚦 Rate limit: ${RATE_LIMIT_PER_MINUTE}/min, burst=${RATE_LIMIT_BURST_10S}/10s`);
        console.log(`🎟️ Token rate limit: ${TOKEN_RATE_LIMIT_PER_MINUTE}/min, burst=${TOKEN_RATE_LIMIT_BURST_10S}/10s`);
        console.log(`🔐 Admin rate limit: ${ADMIN_RATE_LIMIT_PER_MINUTE}/min, burst=${ADMIN_RATE_LIMIT_BURST_10S}/10s`);
        console.log(`🌐 Trust X-Forwarded-For: ${TRUST_X_FORWARDED_FOR ? '✅' : '❌'}`);
        console.log(
            `🩺 Auto quarantine: ${AUTO_QUARANTINE_ENABLED ? `✅ (fails=${AUTO_QUARANTINE_FAILURES}, release=${AUTO_QUARANTINE_RELEASE_SUCCESSES}, max=${AUTO_QUARANTINE_MAX_NODES})` : '❌'}`
        );
        console.log(
            `💧 Auto drain: ${AUTO_DRAIN_ENABLED ? `✅ (fails=${AUTO_DRAIN_FAILURES}, release=${AUTO_DRAIN_RELEASE_SUCCESSES}, threshold=${AUTO_DRAIN_LOAD_THRESHOLD}, penalty=${AUTO_DRAIN_SCORE_PENALTY})` : '❌'}`
        );
        console.log(
            `📈 Score model: load_weight=${BALANCER_LOAD_WEIGHT} latency_weight=${BALANCER_LATENCY_WEIGHT} max_latency=${BALANCER_MAX_LATENCY_MS}ms alpha=${BALANCER_SMOOTHING_ALPHA} hysteresis=${BALANCER_HYSTERESIS_DELTA}`
        );
        console.log(`⏱️ Upstream: timeout=${REQUEST_TIMEOUT_MS}ms redirects=${MAX_REDIRECTS}`);
        console.log(`🧱 Circuit breaker: fails=${CIRCUIT_BREAKER_FAILURES} open=${CIRCUIT_BREAKER_OPEN_SEC}s`);
        console.log(`🚫 Quarantine: ${QUARANTINE_NODES.length} nodes`);
        console.log(`💾 Runtime config: ${CONFIG_RUNTIME_PATH || CONFIG_PATH}`);
        console.log(`🛡️ Admin routes: ${ADMIN_TOKEN ? '🔒 enabled' : '⚠️ disabled (set ADMIN_TOKEN)'}`);
        console.log(`🔐 Panel cookie: ${PANEL_AUTH_COOKIE ? '✅' : '❌ (не нужен)'}`);
        console.log(`📡 Sub page: ${SUB_PAGE_URL || 'не задан'}`);
        console.log(`🔀 Форвард: все заголовки клиента → upstream, все заголовки upstream → клиент`);
        console.log(`\n   Подписка: http://localhost:${PORT}/{token}`);
        console.log(`   Health:   http://localhost:${PORT}/health`);
        console.log(`   Стата:    http://localhost:${PORT}/admin/node-stats (x-admin-token)\n`);
    });
}

start().catch(err => { console.error('Ошибка:', err); process.exit(1); });
