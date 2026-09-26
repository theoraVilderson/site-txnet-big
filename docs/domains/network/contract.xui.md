---
id: network
layer: domain
status: draft
version: 17
updated: 2026-09-24
---

# The x-ui forks: two families, not one value opened two ways

A topic file of `contract.md` (§10), beside `contract.drivers.md`, whose "What
every family is" holds here unchanged. What governs
`network-service/internal/driver/xuialireza/`; the original x-ui has no driver.

## Two values (user, 2026-09-24)

x-ui is two products: the **alireza0** fork, which publishes an API under
`/xui/API/inbounds`, and the **original** by vaxilu, which has none. They are
`x_ui_alireza` and `x_ui_vaxilu` in `DriverType`; there is no `x_ui`.

- **Why not one value.** The questionnaire's verdict is held per panel row
  under its `driverType`, and the two forks answer it differently. One value
  opened by probing the panel would switch drivers silently when a panel was
  replaced, and would cost a request on every open.
- **A wrong choice fails at the connection test**, as a 3x-ui v3 panel
  registered as `sanaee` does: the original has no `/xui/API/inbounds`.
- `x_ui` was renamed to `x_ui_alireza`
  (`20260924000300_the_two_x_ui_forks_are_two_families`), since no driver
  opened it and the published API is the alireza0 fork's. The form names each
  by its author (`systems.ts` `DRIVER_LABELS`).

## x-ui, alireza0 fork — `x_ui_alireza` (F-027-bc)

`internal/driver/xuialireza`. 3x-ui was forked from this panel, so the wire is
Sanaee's (`contract.drivers.md` "Sanaee") under other routes. Pull,
`cumulative`, and the panel enforces its own per-client total: ADR-0072 as
Marzban.

| x-ui (alireza0) | ours |
|---|---|
| `POST /login` (form), session cookie | made on the first call. `{success, msg, obj}` replies, and `success=false` on a 200 is a failure |
| `GET /xui/API/inbounds/` | `GetUsage`, `ListClients`, `ListInbounds`, and `GetUsageFor` (filtered out of it) |
| `addClient`, `updateClient/{uuid}`, `{id}/delClient/{uuid}`, `{id}/resetClientTraffic/{email}` | the lifecycle, under `/xui/API/inbounds/`. A trojan client is keyed by its password |
| `email` | `RemoteID`: the name provisioning chose (`<key>-<n>`, F-114-n), else the uuid without hyphens; never changed (it keys the counters) |
| `subId` | the purchase's subscription key, shared by its clients on the panel (F-114-n, `contract.provisioning.md`); random for a client of no purchase |
| `comment` — not x-ui's | `Label`, the claim tag (rule 2) |
| `id` (or `password` for trojan) | `UUID` |
| `clientStats.up` / `.down` / `.total` | `UpBytes` / `DownBytes` / `DataLimitBytes` |
| `enable`, `expiryTime` (unix ms, 0 = none) | `Enabled`, `ExpiresAt` |
| `POST /xui/setting/all` | `SubscriptionURL`, built as Sanaee's rule 6 |
| `listen`, `port`, `remark`, `settings`, `streamSettings` of the client's inbound | `ClientLinks`: the line built as x-ui's page builds it, never read from the sub server (`contract.links.md` rule 1, ADR-0088) |

The rules:

1. **An expired session is a redirect, and it is not followed.** The API's
   `checkLogin` sends a `307` to the login page. The panel's own ajax gets a
   `success=false` instead, which reads like any refusal, so requests are not
   marked as ajax. A redirect, `401` or `404` gets **one** login and one retry;
   a login refused is `blocked` and is not retried.
2. **The claim tag rides in a key x-ui does not know.** x-ui stores the client
   map as sent and builds Xray's config from a whitelist of keys, so `comment`
   is kept and never reaches Xray. Saving the client in the panel's page drops
   it, and the client then matches by `remoteId` and `uuid`
   (`contract.drift.md`).
3. **No `reset` is written.** The fork has no auto-renewal, so no second writer
   of the quota exists to switch off.

Sanaee's rules 1 (a zero ceiling is one byte), 3 (every write reads the panel
first), 4 (an inbound's last client is disabled, reported `unsupported`),
5 (no rate limit) and 6 (the subscription is the link) hold unchanged.
`apiBaseUrl` includes the panel's base path.

Questionnaire as Sanaee's: every row yes except `per_client_rate_limit` and
`usage_for_named_subset`; verdict `accepted`, metered sale allowed. Conformance:
11 pull scenarios pass, 5 skipped by name. `xuialireza_test.go` also pins the
redirect retry, the absent `reset`, rule 4 and the round trip. Opened by
`internal/opener` with the `username:password` login.

## x-ui, original — `x_ui_vaxilu` (F-027-bd)

**No driver, by decision** (user, 2026-09-24; F-027-bd dropped). vaxilu's
x-ui counts traffic, limit, expiry and enable per **inbound** — its model has
no per-client counters and its routes are only `/xui/inbound/{list,add,del,update}`
— so per-client metering would need one inbound (and one port) per config,
which was declined. The opener answers `ErrNoDriver`, so such a panel stays
`pending`, `unopenable`. The enum value is kept: dropping it takes a migration.
