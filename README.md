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
⚡ Fastest          — автовыбор лучшего из ВСЕХ серверов
🇫🇮 Finland         — 4 сервера, автобалансировка внутри
🇩🇪 Germany         — 4 сервера, автобалансировка внутри
🇳🇱 Netherlands     — 2 сервера, автобалансировка внутри
🇪🇺 Europe LTE      — 4 сервера, автобалансировка внутри
```

Каждая группа автоматически:
- **Пингует** все серверы каждые 3 минуты
- **Выбирает** самый быстрый и стабильный по `leastLoad`
- **Переключает** на другой, если текущий упал
- **Исключает** мёртвые серверы (пинг >1с)

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
│  1. Форвардит ВСЕ заголовки (User-Agent, X-Hwid и т.д.)    │
│  2. Получает XRAY-JSON массив из subscription page          │
│  3. Собирает все outbound'ы                                 │
│  4. Группирует по странам (config.json → groups)            │
│  5. Создаёт ⚡ Fastest (все серверы)                        │
│  6. Добавляет burstObservatory + leastLoad в каждую группу  │
│  7. Возвращает массив конфигов клиенту                      │
└─────────────────────────────────────────────────────────────┘
```

## Установка

### 1. Клонируй репозиторий

```bash
cd /opt
git clone https://github.com/Haxonate/xray-balancer-mw.git
cd xray-balancer-mw
```

### 2. Создай config.json

```bash
cp config.json.example config.json
nano config.json
```

Заполни свои данные:

```json
{
    "port": 4100,

    "remnawave_url": "https://panel.example.com",
    "sub_path": "/api/sub",

    "sub_page_url": "http://subscription-page:3010",
    "sub_domain": "sub.example.com",

    "api_token": "",

    "strategy": "leastLoad",
    "probe_interval": "3m",
    "probe_url": "https://www.gstatic.com/generate_204",

    "fastest_group": true,
    "auto_groups": false,

    "groups": {
        "🇫🇮 Finland": ["Finland"],
        "🇩🇪 Germany": ["German"],
        "🇳🇱 Netherlands": ["Netherlands"],
        "🇪🇺 Europe LTE": ["ЕВРОПА", "LTE"]
    }
}
```

**Обязательные поля:**

| Поле | Что указать |
|------|------------|
| `remnawave_url` | URL вашей панели Remnawave |
| `sub_page_url` | Внутренний Docker-адрес subscription page (не публичный!) |
| `sub_domain` | Публичный домен подписки |
| `groups` | Паттерны группировки серверов (см. [Настройка групп](#настройка-групп)) |

> Узнать имя контейнера subscription page: `docker ps --format '{{.Names}}' | grep -i sub`

### 3. Запусти

```bash
docker compose up -d --build
```

### 4. Настрой reverse proxy

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
            header_up X-Real-IP {remote_host}
            header_up Host {host}
        }
    }

    # Все остальные (браузеры и т.д.) → subscription page
    handle /* {
        reverse_proxy subscription-page:3010 {
            header_up X-Real-IP {remote_host}
            header_up Host {host}
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
    listen 443 ssl http2;
    server_name sub.example.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    location / {
        proxy_pass http://$backend;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass_request_headers on;
    }
}
```

Полный пример: [`examples/nginx.conf`](examples/nginx.conf)

</details>

### 5. Настрой Response Rules в Remnawave

В панели Remnawave → **Subscription** → **Response Rules** → правило **"Happ / Xray JSON Clients"**.

Замени regex на:

```
^(?:Happ|Streisand|FoXray|V2Box|V2rayN|V2RayTUN|InvisibleMan|Xray)
```

Это нужно чтобы subscription page отдавал **XRAY-JSON** всем xray-клиентам, включая V2RayTUN.

Полный пример правил: [`examples/response-rules.json`](examples/response-rules.json)

### 6. Проверь

```bash
# Health check
curl http://localhost:4100/health

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

Ожидаемый вывод:
```
⚡ Fastest: 14 серверов
🇫🇮 Finland: 4 серверов
🇩🇪 Germany: 4 серверов
🇳🇱 Netherlands: 2 серверов
🇪🇺 Europe LTE: 4 серверов
```

Обновите подписку в приложении — готово!

---

## Конфигурация

### Все параметры config.json

| Параметр | Тип | Описание | По умолчанию |
|----------|-----|----------|-------------|
| `port` | number | Порт middleware | `4100` |
| `remnawave_url` | string | URL панели Remnawave | — |
| `sub_path` | string | Путь к API подписки | `/api/sub` |
| `sub_page_url` | string | Внутренний URL subscription page | — |
| `sub_domain` | string | Публичный домен подписки | — |
| `api_token` | string | API токен панели (для auto_groups) | `""` |
| `strategy` | string | Стратегия балансировки | `leastLoad` |
| `probe_interval` | string | Интервал пинга серверов | `3m` |
| `probe_url` | string | URL для проверки доступности | gstatic |
| `fastest_group` | boolean | Включить группу ⚡ Fastest | `true` |
| `auto_groups` | boolean | Автогруппировка по хостам из API | `false` |
| `auto_groups_interval_sec` | number | Интервал обновления автогрупп | `300` |
| `groups` | object | Группы: `"имя": ["паттерн1", "паттерн2"]` | `{}` |

### Настройка групп

Серверы группируются по **тегам outbound'ов** (remarks из subscription page). Паттерны ищутся в теге (case-insensitive):

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

Примеры сопоставления:
- Тег `🇫🇮 Finland 2 (WIFI)` содержит "Finland" → группа **🇫🇮 Finland**
- Тег `🇪🇺 ЕВРОПА LTE 3` содержит "ЕВРОПА" → группа **🇪🇺 Europe LTE**

Серверы без совпадений добавляются в первую найденную группу. Если групп нет — создаётся **🌐 Other**.

### Группа ⚡ Fastest

Специальная группа со **всеми** серверами из всех стран. Автоматически выбирает самый быстрый. Полезно когда не важна конкретная локация.

Отключение:
```json
{
    "fastest_group": false
}
```

### Автогруппировка (опционально)

Middleware может автоматически определять страны по remark хостов из API панели:

```json
{
    "api_token": "eyJhbGciOi...",
    "auto_groups": true,
    "auto_groups_interval_sec": 300
}
```

---

## Как работает балансировка

### burstObservatory

Каждая группа получает свой `burstObservatory`:
- HTTP GET к `probe_url` через каждый сервер группы
- 3 замера с таймаутом 2 секунды
- Повтор каждые 3 минуты
- Запись пинга и стабильности

### leastLoad

Стратегия `leastLoad` анализирует результаты:
- Выбирает лучшие серверы (`expected` = половина группы)
- **Исключает** серверы с пингом > 1с (`baselines`) — мёртвые
- **Исключает** нестабильные (отклонение > 30%, `tolerance`)
- Из оставшихся — с наименьшей нагрузкой

Результат: клиент всегда подключён к самому быстрому серверу. Если сервер падает — мгновенное переключение.

---

## Форвардинг заголовков

Middleware пробрасывает **все заголовки** от клиента в subscription page:

| Заголовок | Назначение |
|-----------|-----------|
| `User-Agent` | Тип клиента |
| `X-Hwid` | Hardware ID (для Device Limit) |
| `X-Device-Os` | Операционная система |
| `X-Device-Model` | Модель устройства |
| `X-Forwarded-For` | Реальный IP клиента |
| `X-Real-IP` | Реальный IP клиента |

> `Accept-Encoding` намеренно не форвардится — чтобы upstream не сжимал ответ.

---

## API

| Endpoint | Описание |
|----------|----------|
| `GET /health` | Health check |
| `GET /refresh-groups` | Обновить auto-groups (требует api_token) |
| `GET /{token}` | Подписка с балансировкой |
| `GET /sub/{token}` | Подписка (альтернативный путь) |

---

## Troubleshooting

### Клиент показывает "App not supported" или один сервер

Subscription page отдаёт base64 вместо XRAY-JSON. Добавьте клиент в **Response Rules** в панели Remnawave.

### Клиент получает пустой ответ

Subscription page сжимает ответ. Убедитесь что используете актуальную версию middleware.

### Подключает к мёртвому серверу

Обновите подписку в приложении — `baselines` исключает серверы с пингом >1с.

### V2RayTUN показывает отдельные серверы

1. Добавьте `V2RayTUN` в regex Response Rules в панели
2. Добавьте `v2raytun` в matcher Caddy/Nginx
3. Обновите подписку

### "🌐 Other" вместо групп

Теги не совпадают с паттернами. Проверьте: `docker logs xray-balancer-mw --tail 20` — добавьте нужные паттерны в `groups`.

---

## Совместимость

| Компонент | Поддержка |
|-----------|----------|
| **Клиенты** | Happ, V2RayTUN, Streisand, V2rayN, NekoBox, FoXray, V2Box, InvisibleMan |
| **Панели** | Remnawave 2.x+ |
| **Reverse Proxy** | Caddy, Nginx, Traefik |
| **xray-core** | 1.8+ |

## Структура проекта

```
xray-balancer-mw/
├── server.js              # Middleware (Node.js, без зависимостей)
├── config.json.example    # Пример конфигурации
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .gitignore
├── README.md
└── examples/
    ├── Caddyfile                  # Конфиг Caddy
    ├── nginx.conf                 # Конфиг Nginx
    ├── docker-compose.nginx.yml   # Docker Compose для Nginx
    └── response-rules.json        # Response Rules для Remnawave
```

## Лицензия

See [LICENSE](LICENSE)
