# 🚀 Xray Balancer Middleware

Middleware для [Remnawave](https://github.com/remnawave/panel), который автоматически группирует VPN-серверы по странам и добавляет интеллектуальную балансировку нагрузки в XRAY-JSON подписки.

## Что получает пользователь

Вместо списка из 14 отдельных серверов:
```
Finland (WIFI), Finland 2 (WIFI), Finland 3 (WIFI), Finland 4 (WIFI),
German (WIFI), German 2 (WIFI), German 3 (WIFI), German 4 (WIFI), ...
```

Пользователь видит в приложении:
```
🏁 Самые быстрые    — автовыбор лучшего из ВСЕХ серверов
🇫🇮 Finland         — 4 сервера, автобалансировка внутри
🇩🇪 Germany         — 4 сервера, автобалансировка внутри
🇳🇱 Netherlands     — 2 сервера, автобалансировка внутри
🇪🇺 Europe LTE      — 4 сервера, автобалансировка внутри
```

Каждая группа автоматически:
- **Пингует** все серверы каждые 3 минуты
- **Выбирает** самый быстрый и стабильный по `leastLoad`
- **Переключает** на другой, если текущий значительно просел
- **Исключает** мёртвые серверы (пинг >1с)
- **Исключает** перегруженные ноды по данным из API панели
- **Сортирует** менее загруженные серверы первыми

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                    Reverse Proxy (Caddy/Nginx)              │
│                                                             │
│  User-Agent: Happ / Streisand / V2RayTUN / V2rayN?          │
│       ├── ДА  → Xray Balancer Middleware (:4100)            │
│       └── НЕТ → Subscription Page (:3010) напрямую          │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              Xray Balancer Middleware                        │
│                                                             │
│  1. Форвардит ВСЕ заголовки клиента на upstream             │
│  2. Получает XRAY-JSON массив из subscription page          │
│  3. Запрашивает нагрузку нод из API панели                  │
│  4. Собирает все outbound'ы                                 │
│  5. Исключает перегруженные/офлайн ноды                     │
│  6. Сортирует по нагрузке — свободные первыми               │
│  7. Группирует по странам (config.json → groups)            │
│  8. Создаёт 🏁 Самые быстрые (все серверы)                  │
│  9. Добавляет burstObservatory + leastLoad в каждую группу  │
│ 10. Пробрасывает ВСЕ заголовки upstream → клиенту           │
│     (Happ: announce, support-url, profile-title и т.д.)     │
│ 11. Возвращает массив конфигов клиенту                      │
└─────────────────────────────────────────────────────────────┘
```

## Установка

### 1. Клонируй репозиторий

```bash
cd /opt
git clone https://github.com/Haxonate/xray-balancer-mw.git
cd xray-balancer-mw
```

### 2. Создай .env (секреты)

```bash
cp .env.example .env
nano .env
```

Заполни свои данные:

```env
# URL панели Remnawave
REMNAWAVE_URL=https://panel.example.com

# Внутренний Docker-адрес subscription page (НЕ публичный!)
SUB_PAGE_URL=http://subscription-page:3010

# Публичный домен подписки
SUB_DOMAIN=sub.example.com

# API токен панели (для auto_groups и node_stats)
API_TOKEN=eyJhbGciOi...

# Cookie для панели за nginx (egam.es). Пусто если не нужно
PANEL_AUTH_COOKIE=
```

> ⚠️ `.env` содержит секреты и **не попадает в git** (добавлен в `.gitignore`)

### 3. Настрой config.json (группы и стратегия)

```bash
cp config.json.example config.json
nano config.json
```

```json
{
    "port": 4100,

    "strategy": "leastLoad",
    "probe_interval": "3m",
    "probe_url": "https://www.gstatic.com/generate_204",

    "fastest_group": true,
    "auto_groups": false,

    "node_stats": false,
    "node_stats_interval_sec": 120,
    "max_users_per_gb": 20,
    "max_users_per_cpu": 40,

    "groups": {
        "🇫🇮 Finland": ["Finland"],
        "🇩🇪 Germany": ["German"],
        "🇳🇱 Netherlands": ["Netherlands"],
        "🇪🇺 Europe LTE": ["ЕВРОПА", "LTE"]
    }
}
```

> Группы, стратегия и параметры балансировки — безопасны, их можно коммитить.

### 4. Запусти

```bash
docker compose up -d --build
```

### 5. Настрой reverse proxy

Middleware работает за reverse proxy, который направляет xray-клиентов на middleware, а остальных — напрямую на subscription page.

<details>
<summary><b>Caddy (рекомендуется)</b></summary>

Добавь в свой Caddyfile:

```caddyfile
https://sub.example.com {
    # Xray-клиенты → middleware
    @xray_client {
        header_regexp User-Agent (?i)(happ|streisand|v2ray|v2raytun|neko|foxray|v2box|xray|invisibleman)
    }
    handle @xray_client {
        reverse_proxy xray-balancer-mw:4100 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }

    # Все остальные (браузеры и т.д.) → subscription page
    handle /* {
        reverse_proxy subscription-page:3010 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }
}
```

Полный пример: [`examples/Caddyfile`](examples/Caddyfile)

</details>

<details>
<summary><b>Nginx</b></summary>

```nginx
upstream subscription_page {
    server subscription-page:3010;
}

upstream xray_balancer_mw {
    server xray-balancer-mw:4100;
}

map $http_user_agent $backend {
    default                          subscription_page;
    ~*(?:happ|streisand|v2raytun)    xray_balancer_mw;
    ~*(?:v2ray|neko|foxray)          xray_balancer_mw;
    ~*(?:v2box|xray|invisibleman)    xray_balancer_mw;
}

server {
    listen 443 ssl;
    http2 on;
    server_name sub.example.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    location / {
        proxy_http_version 1.1;
        proxy_pass http://$backend;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Port  $server_port;
        proxy_pass_request_headers on;
    }
}
```

Полный пример: [`examples/nginx.conf`](examples/nginx.conf)

</details>

### 6. Настрой Response Rules в Remnawave

В панели Remnawave → **Subscription** → **Response Rules** → правило **"Happ / Xray JSON Clients"**.

Замени regex на:

```
^(?:Happ|Streisand|FoXray|V2Box|V2rayN|V2RayTUN|InvisibleMan|Xray)
```

Полный пример правил: [`examples/response-rules.json`](examples/response-rules.json)

### 7. Проверь

```bash
# Health check
curl http://localhost:4100/health

# Статистика нод (если node_stats включён)
curl http://localhost:4100/node-stats

# Тест подписки (замени YOUR_TOKEN)
curl -s -H "User-Agent: Happ/3.10.0" https://sub.example.com/YOUR_TOKEN | python3 -c "
import sys, json
arr = json.load(sys.stdin)
for cfg in arr:
    r = cfg.get('remarks', '?')
    obs = [o for o in cfg.get('outbounds', []) if o.get('protocol') not in ('freedom', 'blackhole')]
    print(f'{r}: {len(obs)} серверов')
"
```

---

## Что где хранится

```
.env                  ← Секреты (URL панели, токены, cookie)  🔒 НЕ в git
config.json           ← Настройки (группы, стратегия)         ✅ Можно коммитить
docker-compose.yml    ← Читает .env автоматически
```

| Переменная | .env | config.json | Описание |
|------------|------|-------------|----------|
| `REMNAWAVE_URL` | ✅ | ~~fallback~~ | URL панели |
| `SUB_PAGE_URL` | ✅ | ~~fallback~~ | Docker-адрес subscription page |
| `SUB_DOMAIN` | ✅ | ~~fallback~~ | Публичный домен подписки |
| `API_TOKEN` | ✅ | ~~fallback~~ | Токен API панели |
| `PANEL_AUTH_COOKIE` | ✅ | ~~fallback~~ | Cookie для egam.es |
| `groups` | — | ✅ | Группировка серверов |
| `strategy` | — | ✅ | Стратегия балансировки |
| `node_stats` | — | ✅ | Включить опрос нод |
| `fastest_group` | — | ✅ | Группа 🏁 Самые быстрые |

> **Приоритет:** `.env` > `config.json`. Если переменная задана в обоих — берётся из `.env`.

---

## 📊 Балансировка по нагрузке нод

Middleware опрашивает API панели Remnawave и использует реальные данные о нагрузке серверов:

- **usersOnline** — сколько юзеров сейчас на ноде
- **totalRam** — объём RAM сервера
- **cpuCount** — количество ядер CPU
- **isConnected** — жива ли нода

### Включение

В `config.json`:
```json
{
    "node_stats": true,
    "node_stats_interval_sec": 120,
    "max_users_per_gb": 20,
    "max_users_per_cpu": 40
}
```

В `.env` убедись что `API_TOKEN` заполнен.

### Что делает

Каждые 2 минуты (настраивается) middleware:

1. Запрашивает `/api/nodes/` у панели
2. Считает нагрузку каждой ноды по двум метрикам:
   - `ramLoad = usersOnline / totalRamGb`
   - `cpuLoad = usersOnline / cpuCount`
3. При запросе подписки:
   - **Исключает** офлайн ноды (`isConnected: false`)
   - **Исключает** отключённые ноды (`isDisabled: true`)
   - **Исключает** перегруженные по RAM (ramLoad > `max_users_per_gb`)
   - **Исключает** перегруженные по CPU (cpuLoad > `max_users_per_cpu`)
   - **Сортирует** оставшиеся по худшей из двух метрик (bottleneck)

### Зачем это нужно

До первого замера observatory (~3 мин после обновления подписки) xray-core берёт **первый сервер из списка**. Благодаря сортировке по нагрузке — это будет самый свободный сервер.

### Параметр max_users_per_gb

| Значение | Значит |
|----------|--------|
| `20` | 1GB RAM → перегружен при 20+ юзерах, 2GB → при 40+ |
| `15` | Агрессивнее — раньше исключает |
| `50` | Мягче — почти не фильтрует |

### Параметр max_users_per_cpu

| Значение | Значит |
|----------|--------|
| `40` | 1 ядро → перегружен при 40+ юзерах, 4 ядра → при 160+ |
| `25` | Агрессивнее — раньше исключает |
| `80` | Мягче — почти не фильтрует |

Нода считается перегруженной если **хотя бы один** порог превышен (bottleneck модель).

Если все серверы перегружены — middleware вернёт всех подключённых, отсортированных по нагрузке (fallback).

---

## 🔐 Авторизация панели

### Вариант 1 — Прямой Docker (рекомендуется)

```env
REMNAWAVE_URL=http://remnawave:3000
API_TOKEN=eyJhbGciOi...
PANEL_AUTH_COOKIE=
```

### Вариант 2 — Своя установка

```env
REMNAWAVE_URL=https://panel.example.com
API_TOKEN=eyJhbGciOi...
PANEL_AUTH_COOKIE=
```

### Вариант 3 — Установка через egam.es (с cookie)

```env
REMNAWAVE_URL=https://panel.example.com
API_TOKEN=eyJhbGciOi...
PANEL_AUTH_COOKIE=XfCVRpMC=vmWQidbR
```

Значение cookie берётся из nginx-конфига панели. Ищите строку вида `"~*XfCVRpMC=vmWQidbR"`.

---

## Форвардинг заголовков

Middleware использует **blacklist** подход — пробрасывает **все** заголовки в обе стороны, кроме hop-by-hop и служебных.

**Клиент → upstream** (всё кроме):
`accept-encoding`, `host`, `connection`, `keep-alive`, `transfer-encoding`, `te`, `upgrade`, `proxy-authorization`, `proxy-connection`

**Upstream → клиент** (всё кроме):
`connection`, `keep-alive`, `transfer-encoding`, `te`, `upgrade`, `content-length`, `content-encoding`, `date`, `server`

Это означает что все заголовки Happ (`announce`, `support-url`, `profile-title`, `subscription-userinfo`, `profile-web-page-url`, `color-profile`, `fragmentation-*`, `hide-settings` и т.д.) пробрасываются автоматически, без необходимости добавлять их вручную.

---

## Конфигурация

### Все параметры

**`.env` — секреты:**

| Переменная | Описание |
|------------|----------|
| `REMNAWAVE_URL` | URL панели Remnawave |
| `SUB_PAGE_URL` | Внутренний Docker-адрес subscription page |
| `SUB_DOMAIN` | Публичный домен подписки |
| `API_TOKEN` | API токен панели |
| `PANEL_AUTH_COOKIE` | Cookie для панели за nginx (egam.es) |

**`config.json` — настройки:**

| Параметр | Тип | Описание | По умолчанию |
|----------|-----|----------|-------------|
| `port` | number | Порт middleware | `4100` |
| `sub_path` | string | Путь API подписки | `/api/sub` |
| `strategy` | string | Стратегия балансировки | `leastLoad` |
| `probe_interval` | string | Интервал пинга серверов | `3m` |
| `probe_url` | string | URL для проверки доступности | gstatic |
| `fastest_group` | boolean | Включить группу 🏁 Самые быстрые | `true` |
| `auto_groups` | boolean | Автогруппировка по хостам из API | `false` |
| `auto_groups_interval_sec` | number | Интервал обновления автогрупп | `300` |
| `node_stats` | boolean | Балансировка по нагрузке нод | `false` |
| `node_stats_interval_sec` | number | Интервал опроса API панели | `120` |
| `max_users_per_gb` | number | Порог перегрузки по RAM (юзеров/GB) | `20` |
| `max_users_per_cpu` | number | Порог перегрузки по CPU (юзеров/ядро) | `40` |
| `groups` | object | Группы: `"имя": ["паттерн1", "паттерн2"]` | `{}` |

### Настройка групп

Серверы группируются по **тегам outbound'ов** (remarks из subscription page). Паттерны ищутся в теге (case-insensitive).

Двухбуквенные паттерны (FI, DE, NL, ...) матчатся только как отдельные слова — не дают ложных совпадений внутри слов.

```json
{
    "groups": {
        "🇫🇮 Finland": ["Finland"],
        "🇩🇪 Germany": ["German", "Deutschland"],
        "🇳🇱 Netherlands": ["Netherlands", "NL", "Holland"],
        "🇪🇺 Europe LTE": ["ЕВРОПА", "LTE", "4G"],
        "🇺🇸 USA": ["USA", "United States"]
    }
}
```

Серверы без совпадений добавляются в первую найденную группу. Если групп нет — создаётся **🌐 Other**.

---

## Как работает балансировка

### Два уровня

**Уровень 1 — Middleware (серверная сторона):**
- Опрашивает API панели каждые 2 минуты
- Исключает мёртвые/офлайн/перегруженные серверы
- Сортирует по реальной нагрузке (users/GB)
- Отдаёт клиенту уже отфильтрованный и отсортированный список

**Уровень 2 — xray-core (клиентская сторона):**
- Получает список от middleware
- Пингует каждый сервер через burstObservatory
- Выбирает лучший по пингу через leastLoad
- Переключает при деградации

### burstObservatory

Каждая группа получает свой `burstObservatory`:
- HTTP GET к `probe_url` через каждый сервер группы
- 3 замера с таймаутом 2 секунды
- Повтор каждые 3 минуты

### leastLoad

Стратегия `leastLoad`:
- Выбирает **1 лучший** сервер (`expected: 1`)
- **Исключает** серверы с пингом > 1с (`baselines`)
- **Переключает** только при деградации > 80% (`tolerance: 0.8`)

---

## API

| Endpoint | Описание |
|----------|----------|
| `GET /health` | Health check |
| `GET /node-stats` | Текущая статистика нод |
| `GET /refresh-stats` | Принудительно обновить статистику |
| `GET /refresh-groups` | Обновить auto-groups |
| `GET /{token}` | Подписка с балансировкой |
| `GET /sub/{token}` | Подписка (альтернативный путь) |

---

## Troubleshooting

### Клиент показывает "App not supported" или один сервер

Subscription page отдаёт base64 вместо XRAY-JSON. Добавьте клиент в **Response Rules** в панели Remnawave.

### Клиент получает пустой ответ

Subscription page сжимает ответ. Убедитесь что используете актуальную версию middleware.

### Подключает к мёртвому серверу

Обновите подписку в приложении. Если включён `node_stats` — офлайн серверы не попадут в подписку.

### V2RayTUN показывает отдельные серверы

1. Добавьте `V2RayTUN` в regex Response Rules в панели
2. Добавьте `v2raytun` в matcher Caddy/Nginx
3. Обновите подписку

### "🌐 Other" вместо групп

Теги не совпадают с паттернами. Проверьте: `docker logs xray-balancer-mw --tail 20`

### node_stats не работает

1. Убедитесь что `API_TOKEN` указан в `.env`
2. Проверьте: `curl http://localhost:4100/node-stats`
3. Для панели за nginx (egam.es) — укажите `PANEL_AUTH_COOKIE` в `.env`

---

## Совместимость

| Компонент | Поддержка |
|-----------|----------|
| **Клиенты** | Happ, V2RayTUN, Streisand, V2rayN, NekoBox, FoXray, V2Box, InvisibleMan |
| **Панели** | Remnawave 2.x+ |
| **Установка** | Своя, egam.es скрипт, Docker |
| **Reverse Proxy** | Caddy, Nginx, Traefik |
| **Node.js** | 18+ |
| **xray-core** | 1.8+ |

## Структура проекта

```
xray-balancer-mw/
├── server.js              # Middleware (Node.js, без зависимостей)
├── package.json           # Метаданные проекта
├── .env.example           # 🔒 Пример секретов (скопируй в .env)
├── config.json.example    # Пример настроек
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .gitignore
├── LICENSE
├── README.md
└── examples/
    ├── Caddyfile
    ├── nginx.conf
    ├── docker-compose.nginx.yml
    └── response-rules.json
```

## Лицензия

See [LICENSE](LICENSE)
