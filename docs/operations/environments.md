---
id: ops-environments
status: active
updated: 2026-09-05
---

# Environments

## Env files (loaded in order, later wins)

| File | Role | Committed? |
|---|---|---|
| `.env` | shared — identical in every environment | values yes, secrets no |
| `.env.dev` | dev overrides | yes (dev-only secrets) |
| `.env.prod` | prod overrides | no (real secrets) |
| `.env.example` | annotated template for all three blocks | yes |

`scripts/dev.compose.sh` -> `--env-file .env --env-file .env.dev -p devtxnet`.
`scripts/prod.compose.sh` -> `--env-file .env --env-file .env.prod -p prodtxnet`.
Different project name + `STACK_NAME` + network names + host ports, so dev and
prod can run on one host at once. `dev-docker/dev-setup.sh` orchestrates the
main stack + the three independent stacks.

## Dev build/run loop (`txnet-backend/scripts/dev-serve.js`)

`nx serve` (`@nx/js:node`) respawns a fresh `webpack-cli build` per file save
even under `--watch`, so every save paid for a cold webpack start.
`dev-serve.js` instead drives the webpack Node API directly (one persistent
`compiler.watch()`, module graph kept warm) and restarts the built process
from webpack's `done` hook. Usage: `APP_NAME=<app> node scripts/dev-serve.js`
— generic across Nx apps, not specific to any one service. Each app's own
`webpack.config.js` (e.g. `txnet-backend/auth-service/webpack.config.js`)
supplies `externals`/`cache`/`devtool` tuning; not tracked as any unit's
`source:` — see `interfaces/auth-api/open-questions.md`.

## Stacks

| Stack | Compose file | Project | Contents |
|---|---|---|---|
| main | `dev-docker/docker-compose.main.yml` | `txnet-main` / `devtxnet` / `prodtxnet` | Traefik, locale-service, auth-handler, auth-service, bot-service, billing-service, site-pwa, coinsite, Postgres, Redis, RabbitMQ |
| monitoring | `dev-docker/monitoring/docker-compose.sys-monitor.yml` | `txnet-monitor` | Prometheus, Grafana, Loki, Promtail, node-exporter, cAdvisor, Alertmanager |
| bug-tracker | `dev-docker/bug-tracker/docker-compose.bug-tracker.yml` | `txnet-bugtracker` | Glitchtip (+ own Postgres/Redis/worker) |
| registry | `dev-docker/registry/docker-compose.registry.yml` | `txnet-registry` | private Docker registry |
| prod (swarm) | `swarm/docker-stack.yml` (+ compose) | `txnet` | Swarm overlay: `deploy` sections, global `promtail` |

Networks: `public_gateway_network`, `private_backend_network` (shared/external so
Traefik in the main stack can route to the other stacks).

## Routing (Traefik)

| Host | Service |
|---|---|
| `<domain>` / `www.<domain>` | coinsite (marketing-web) |
| `panel.<domain>` | site-pwa (panel-web) |
| `api.<domain>/api/auth` | auth-service |
| `api.<domain>/api/bot` | bot-service (the Telegram/Bale webhook; router priority 100, because auth-service's https router also matches the bare host) |
| `api.<domain>/api/billing` | billing-service (behind `strip-fake-headers` + `my-auth` ForwardAuth) |
| `monitor.<domain>` | Traefik dashboard (basic-auth) |
| `mq.<domain>` | RabbitMQ management |

## Config keys that MUST agree across services

- `JWT_ACCESS_SECRET` == `JWT_SECRET` (auth-service, auth-handler, site-pwa).
- `REDIS_KEY_NAMESPACE` + `REDIS_KEYSPACE_VERSION` (auth-service, auth-handler) —
  see `platform/redis-keyspace`.
- `LOCALE_SERVICE_ADDR` = `locale-service:50051`; `LOCALE_SCOPE` = `backend` for
  services, `frontend` for site-pwa.
- `DEFAULT_LANGUAGE` = `fa`.
- `AUTH_SERVICE_ORIGIN` (site-pwa) = `http://auth-service:${AUTH_PORT}` — the
  in-network address of the same service the browser reaches at
  `NEXT_PUBLIC_API_ORIGIN`. Server-side only: `src/proxy.ts` uses it for the
  auth-screen session check, which runs before first byte and so must not take
  the public DNS + Traefik + TLS path. Unset falls back to the public origin
  (`next dev` outside compose); a wrong value shows the login form to everyone,
  it never lets anyone in.

## OTP delivery + bot config (auth-service + bot-service)

| Var | Effect if unset / wrong |
|---|---|
| `OTP_ALLOWED_CHANNELS` | the switch. Comma-separated subset of `sms,telegram,bale`; default `sms`. A channel left out is invisible: absent from `GET /api/auth/otp/channels`, refused if a client names it. **It must reach the container** — an env var that only exists in `.env` and is not passed through in `dev-docker/docker-compose.main.yml` silently leaves the service on its default |
| `OTP_DELIVERY_MODE` | `console` prints the code and calls no sender, so every allowed channel counts as configured (dev). `live` is the default |
| ~~`{TELEGRAM,BALE}_BOT_TOKEN` / `_BOT_USERNAME` / `_WEBHOOK_SECRET`~~ | **gone with F-066-i.** A bot's token, username, secret and path belong to the tenant that owns the bot, and live on its `automation.BotIntegration` row and in the Credential Vault. Setting a token variable now **refuses the boot** (`CredentialEnvGuard`, F-1216) |
| `SERVICE_AUTH_TOKEN` | **must be identical in `auth-service` and `bot-service`** (>= 32 chars). It is how bot-service's calls skip the slide captcha and get a per-chat rate-limit bucket (ADR-0011). Wrong or unset in either place and *every* auth step inside the bot is refused with `captcha.required` — check this before reading any flow |
| `AUTH_API_BASE_URL` | where bot-service reaches auth-service; in compose it is the in-network `http://auth-service:${AUTH_PORT}`, so bot traffic never leaves the private network |
| `BOT_SESSION_TTL_SEC` / `BOT_NAV_TTL_SEC` | how long a chat stays signed in (30d idle) and how long a half-finished conversation is remembered (30m) |
| `BOT_LINK_TOKEN_TTL_SEC` | how long a deep link stays usable (900s default) |
| `TELEGRAM_API_BASE` / `BALE_API_BASE` | **outgoing**: where both services call the Bot API (auth-service to deliver an OTP, bot-service to answer a chat). Per environment — dev and prod may need different proxies |
| `TELEGRAM_WEBHOOK_PUBLIC_BASE` / `BALE_WEBHOOK_PUBLIC_BASE` | **incoming**: the base that platform calls back on. Empty falls back to `BOT_WEBHOOK_PUBLIC_BASE`, then `https://api.<DOMAIN_NAME>` |
| `BOT_WEBHOOK_AUTO_REGISTER` | `false` stops **bot-service** registering webhooks on boot (leave it `true` unless something else owns them) |

A messenger channel is now available **per tenant**: the operator switches the
platform on with `OTP_ALLOWED_CHANNELS`, and each reseller supplies its own bot.
`OtpChannelRegistry` logs only the resolved `allowed=[…]` line at boot — what is
*available* depends on who is asking, so it cannot be answered without a
request.

**Where each one lives.** The four endpoint vars (`*_API_BASE`,
`*_DEEP_LINK_BASE`) are shared defaults in `.env`; they describe a *platform*
and are the same whoever the bot belongs to. Nothing that belongs to a tenant is
in a file any more.

Two bots still cannot share a token, because a token holds exactly one webhook
URL — so dev and prod need two different `BotIntegration` rows with two
different bots. That is now a data problem rather than a `.env.dev` /
`.env.prod` one.

The webhook URL itself is not configuration — it is derived:
`<public base>/api/bots/<platform>/<that bot's webhookPath>`, where the public
base is `<PLATFORM>_WEBHOOK_PUBLIC_BASE`, else `BOT_WEBHOOK_PUBLIC_BASE`, else
`https://api.<DOMAIN_NAME>`.

**bot-service** registers that URL for every registrable integration on boot
(`BotWebhookRegistrar`, off with `BOT_WEBHOOK_AUTO_REGISTER=false`); it reads
`getWebhookInfo` first and only writes when the URL differs, so a restart is
cheap and a webhook it cannot read is left alone. The outcome is written back to
the row as `status` + `lastErrorAt`, so `select status, last_error_at from
automation.bot_integration` is the first thing to check when a bot goes quiet —
`scripts/set-bot-webhook.sh` is gone, since there is no env token left for a
shell script to read.

Reachability is two separate problems, and dev has both:

- **outgoing** (`sendMessage`, `setWebhook`) — `TELEGRAM_API_BASE` /
  `BALE_API_BASE`, pointed at a proxy where the API host is blocked.
- **incoming** — Telegram only calls a publicly reachable HTTPS URL, and its
  attempts against this server time out (`last_error_message: Connection timed
  out` in `getWebhookInfo`). `TELEGRAM_WEBHOOK_PUBLIC_BASE` sends its updates
  back in through the same proxy; Bale reaches `api.<DOMAIN_NAME>` directly and
  needs no override.

## Secret ownership

See `security/threat-model.md` "Secrets". All secrets currently live in
`.env.*`; there is no secrets manager / Docker secret wired up yet.
