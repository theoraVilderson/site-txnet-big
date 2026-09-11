---
id: dependency-graph
status: active
updated: 2026-09-09
---

# Dependency graph

Read this before any change: it defines **blast radius**.

## Generated (source of truth)

No static graph generator is wired up. For the Node backend, `npx nx graph`
(in `txnet-backend/`) shows project edges. Go modules: `go.work` at repo root +
`replace` directives in each `go.mod`. This section should be replaced with a
generated artifact if/when CI produces one.

## Runtime edges — what `depends_on` cannot see

A queue, a webhook, a cron job and a domain event move control between units
without either one importing the other. `depends_on` is blind to them, so a walk
(§3c) that follows only static edges misses an entire class of bug — confidently.

These are **not** merged into `depends_on`. A runtime edge answers **"what runs
after me"** (a debugging question); `depends_on` answers **"who do I call"** (a
contract question, §8 blast radius).

`tools/where.py --walk` reads this table by heading and by the four column
names, and `from`/`to` must be **unit ids** from `MASTER_INDEX.md` — not service
or container names. Add a row the first time a walk needs it.

| from | to | via | why |
|---|---|---|---|
| auth-api | i18n | gRPC GetSnapshot + Watch (async reload) | translations change under a running auth-service without a redeploy |
| forward-auth | i18n | gRPC GetSnapshot + Watch (async reload) | same snapshot stream; a stale gateway serves stale error text |
| panel-web | i18n | gRPC GetSnapshot at SSR boot | panel renders server-side with a snapshot it fetched, not with live calls |
| auth-api | redis-keyspace | Redis writes: session, OTP, rate-limit keys | the session exists only in Redis; nothing in Postgres records it |
| forward-auth | redis-keyspace | Redis reads: session-active check | revocation is a Redis delete the gateway notices on the next request |
| tenant | redis-keyspace | Redis reads + writes: the `host -> tenant` resolution cache | the cache is shared so a domain change can be retracted across replicas, not waited out (ADR-0025) |
| redis-keyspace | tenant-context | `RedisKeys` reads the ambient tenant to build the `<tenantId>` segment of every phone-derived key (F-065-c) | closes a ring with the row above: a key built outside a request scope throws rather than colliding across tenants (ADR-0023, ADR-0024) |
| forward-auth | auth-api | Traefik ForwardAuth `/validate` -> identity headers | the gateway runs *before* the API and rewrites the request it receives |
| panel-web | auth-api | HTTP proxy `/api/auth/*` (cookies rewritten in the proxy) | a cookie can be correct at the API and lost in the proxy hop |
| messenger | bot-app | inbound webhook -> normalized update handed to the flow | a bot that "doesn't answer" is usually the transport or the token, not the flow — start at `messenger` (ADR-0009) |
| bot-app | auth-api | HTTP, same routes `panel-web` calls, with a session proven by a `LinkedBotAccount` | the bot decides nothing; a wrong answer in the bot is a wrong answer in the panel too |
| identity | messenger | outgoing `sendMessage` for OTP delivery (`F-0202`) | the OTP path and the bot UI share one client registry, so a token or rate-limit problem hits both at once |
| notification | messenger | rate-limited queue for campaigns and bulk sends (`F-313`, §9.8) | a ban earned by a campaign kills OTP delivery on the same token |
| messenger | automation | `BotIntegrationDirectory` — which bot a webhook path names, and its vault credentials (F-320) | a bot that resolves to no row answers 404 at the door; nothing above ever sees why |
| bot-app | auth-api | `POST /internal/bot-integrations/*` over `X-Service-Token` — the same directory, for the process with no database | if `auth-service` is unreachable, *every* inbound update is a 404, not a 5xx: an unresolvable path and an unknown one are the same answer by design |
| bot-app | automation | the webhook publishes the normalised update to `bot.update.<slot>` and answers 200; it no longer runs the flow (F-067-b) | a bot that "doesn't answer" is now three places, not one: the publish, the queue, or the flow. The 200 means *queued*, so the evidence is queue depth and `automation.dead_letter`, not `bot-service`'s log |
| automation | bot-app | `POST /internal/bots/dispatch` over `X-Service-Token` — the worker asking the process that owns the conversation to run one update | the flow runs in `bot-service` either way, so its logs look unchanged; what moved is *who called it*, and a seam that is misconfigured dead-letters every update while the webhook keeps answering 200 |
| automation | *(no consumer yet)* | `OutboxRelayJob` publishes each unpublished `automation.outbox_event` row to `outbox.<type>` on the automation exchange (F-067-c, ADR-0021) | the edge has a producer and no consumer on purpose: every producing domain is `draft`. Every publish is `mandatory`, so an event with nothing bound to its type is returned rather than acked, and the row stays unpublished with `unroutable` in `lastError`. The evidence is `AutomationOutboxStalled`, never a log line in `worker-service` |
| automation | auth-api | `POST /internal/vault/destroy-expired` over `X-Service-Token` — a scheduled job asking the process that owns the Credential Vault to sweep it (F-031-c) | a retention sweep that silently stopped looks exactly like one with nothing to do; the symptom is old `superseded` rows, and the trail is `bot_execution_log` for `vault_credential_retention`, not a log line in `auth-service` |
| panel-web | realtime | the browser holds one `wss://api.<domain>/realtime` socket per page, opened by `site-pwa/src/lib/realtime.ts` and by nothing else (F-070-a) | the socket is authenticated at the upgrade and never after it, so a panel that reconnects is presenting a *new* credential — a live socket that goes quiet and a socket that cannot open are different failures, and only the second one reaches the gate. `4401` is the gateway saying the session is gone, which the panel must route to sign-out and not to a reconnect |
| realtime | forward-auth | Traefik ForwardAuth on the **WebSocket upgrade**, through `my-auth-optional` — the access JWT arrives in `Sec-WebSocket-Protocol`, not `Authorization` (ADR-0030, ADR-0031) | the gateway never validates a token, so a socket refused with 401 is the gate's answer and its cause is in `auth-handler`, never in `gateway-service`. A router that lost the middleware does not fail open: no identity headers **and** no `X-Auth-Anonymous` means no answer from the gate, and the upgrade is refused. A router still carrying plain `my-auth` fails the other way — every anonymous upgrade is a 401 and the pre-login half goes dark |
| realtime | redis-keyspace | Redis reads: `session:<sessionId>`, re-checked every `REALTIME_SESSION_RECHECK_MS` | a socket outlives its access token by hours, so revocation reaches it on a timer rather than on the next request. Up to 60s of lag is normal and bounded; a *keyspace* mismatch instead closes every socket at once, because a miss reads as revoked |
| automation | realtime | Redis pub/sub on `realtime:<channel>` — `RealtimePublisher` in `worker-service` publishes, the gateway replica subscribed to that channel delivers (F-067-i) | not the broker, and that is the point: at-most-once, dropped when nobody is connected, so **an event that did not arrive leaves no trace on either side**. Look for a keyspace-prefix mismatch first — a publish into an unsubscribed channel succeeds. **Still no caller**: work that finishes in the worker will be the first (F-034) |
| identity | realtime | Redis pub/sub on `realtime:otp:<channelId>` — `OtpDeliveryStore.mark` in `auth-service` records the delivery state and publishes it in one operation (F-067-j) | the publish is best-effort and swallowed: the code really was sent, the status says so, and a client that hears nothing polls `otp/delivery/status` instead (D-15). So **a silent socket here is not a failed send** — check the status before looking at the fan-out. The channel is authorized by a token, not by a session, which is why this one works before login |
| identity | redis-keyspace | `otp:channel:<channelId>` — written by `auth-service` when a 202 is answered, read by `gateway-service` at subscribe time | the two build the key from separate files; a mismatch reads as "never minted" and refuses every `otp:` subscription, with no error on either side |

## Manual notes

- `auth-api` and `forward-auth` share one Redis key prefix by env convention
  (`redis-keyspace`). A prefix or version mismatch is invisible to both: the
  gateway simply never finds the session the API wrote. See ADR-0005.
- Both bot units are real code as of 2026-09-06: `messenger`
  (`txnet-backend/messenger/`) and `bot-app` (`txnet-backend/bot-service/`). The
  inbound webhook is `bot-service`'s alone since 2026-09-09 — `auth-service`'s
  deprecated copy of the route is removed. What stayed behind on purpose
  is the *decision* half of `F-0203` (`auth/bot-link/`) and OTP delivery
  (`auth/otp/senders/`), both `identity`'s — so "the bot said no" ends in
  `auth-service`, while "the bot said nothing" ends in `bot-service`.
- `bot-app -> auth-api` carries `X-Service-Token` (ADR-0011). If *every* auth
  step in the bot is refused, that seam — one env var, on two services — is the
  first thing to check, ahead of any flow.
- `locale-service` boot dependency is hard: `auth-api` and `forward-auth` refuse
  to start without a first snapshot. A "service won't boot" symptom starts at
  `i18n`, not at the service that failed.

## Consumer lookup

Consumers of unit X = every unit listing `X` in its front-matter `depends_on`.
Do not maintain a second hand-written list; derive it (or run
`python tools/docs-check.py`, which prints the reverse map).
