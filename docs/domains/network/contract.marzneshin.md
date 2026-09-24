---
id: network
layer: domain
status: draft
version: 17
updated: 2026-09-24
---

# Marzneshin (F-027-ba)

A topic file of `contract.md` (§10), beside `contract.drivers.md`, whose "What
every family is" holds here unchanged. What governs
`network-service/internal/driver/marzneshin/`.

Marzban's successor, not Marzban: its routes, user model and paging differ,
so it is its own family (user, 2026-09-24). Pull, `cumulative`, and it
enforces its own per-user `data_limit`, so it carries ADR-0072. It is the
first family whose bulk read is paged, the case ADR-0081 was written for.
`apiBaseUrl` is the panel's root; `clientBaseUrl` (optional, F-027-bg) is
where its subscriptions are served, when that is another domain.

| Marzneshin | ours |
|---|---|
| `POST /api/admins/token` (form login), bearer token | made on the first call; a `401` is an expired token, so **one** login and one retry. A login refused is `blocked` and is not retried |
| `GET /api/admins/current` | `HealthCheck` |
| `GET /api/users?order_by=created_at&page=N&size=100` | `GetUsage`, `ListClients`: every page, each after the first paid for through `driver.NextPage` |
| `GET /api/users?username=a&username=b…` | `GetUsageFor`: one request per hundred names, exact match |
| `GET /api/inbounds` (paged) | `ListInbounds`: one `Inbound` per service and protocol (rule 5) |
| `username` | `RemoteID`: the uuid without hyphens, never changed |
| `key` | `UUID`: written as the uuid's 32 hex digits, read back with its hyphens |
| `note` | `Label`, the claim tag |
| `service_ids` (lowest) | `InboundRemoteID` |
| `used_traffic` | `DownBytes`; `UpBytes` is 0. There is no split to report |
| `data_limit` | `DataLimitBytes` (null reads 0 = no limit) |
| `enabled`, `POST …/enable` / `…/disable` | `Enabled`; a `409` (already so) is done |
| `expire_strategy` `fixed_date` + `expire_date` (naive UTC) | `ExpiresAt`; a zero expiry is written `never` |

The rules:

1. **A zero ceiling is written as one byte.** Marzneshin stores
   `data_limit: 0` as no limit, on create and on modify.
2. **Every write sets `data_limit_reset_strategy: no_reset`.** Any other
   strategy zeroes the counter on Marzneshin's schedule, a second writer of the
   quota (`internal_credit_disablable`).
3. **One name is sent twice.** One `username` is a substring search
   (`ilike %x%`) and two or more are `IN`. Every answer is filtered to the
   names asked for as well. A hot pass is still one request.
4. **A regenerate deletes and recreates.** No route writes a new `key`, so
   `UpdateClient` with a new uuid deletes the user and creates it again under
   the **same username**, carrying its services, tag, ceiling, expiry and
   state (user, 2026-09-24). Marzneshin's delete is soft and frees the name.
   The counter starts at zero, which the normaliser reads as a reset; bytes
   served between the last read and the delete are not counted.
5. **A service is an inbound.** A user is attached to services, and each
   inbound lists its services. Provisioning finds an inbound by protocol, so
   each service is answered once per protocol we sell (`vless`, `vmess`,
   `trojan`, `shadowsocks`, `hysteria2`, `tuic`, `wireguard`) and a config is
   created under that service. `shadowsocks2022` and the rest are left out.
6. **A modify is partial.** PUT changes only the fields it is sent (the
   username is required), so `SetClientDataLimit` is one request.
7. **A client wanted disabled is created, then disabled.** Create has no
   `enabled` field. The window is one request, under the first block.
8. **No per-user rate limit.** `SetClientRateLimit(0)` succeeds, and any
   other rate is `unsupported`.
9. **Links are Marzneshin's.** `SubscriptionURL` resolves `subscription_url`
   (`/sub/{username}/{key}`, unless an admin prefix makes it absolute) against
   `clientBaseUrl`, or `apiBaseUrl` without one. `BuildLink` reads the line
   for the inbound's protocol from `<subscription>/links`, **without** the
   admin token: the subscription is public and may be on another domain.

Its questionnaire answers: every row yes except `per_client_rate_limit`.
Verdict `accepted`, metered sale allowed.

Conformance: the eleven pull scenarios pass, `bulk_pass_is_bounded` in fifty
pages of a hundred. The four push scenarios and `ceiling_refused` are skipped
by name. `marzneshin_test.go` also pins rules 1, 3, 4, 5 and 9 and the
one-login retry. **Opened by `internal/opener`** with the `username:password`
login and the panel's `clientBaseUrl`.
