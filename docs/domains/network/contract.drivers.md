---
id: network
layer: domain
status: draft
version: 16
updated: 2026-09-24
---

# Real drivers: one family per package

A topic file of `contract.md` (§10). What governs
`network-service/internal/driver/<family>/`. The interface, the questionnaire
and the conformance suite a family is held to are `contract.md` "The driver
contract", "The acceptance questionnaire" and "The fake panel and the
conformance suite"; this file says what each real family does inside them.

## What every family is

A package that implements `driver.Driver` and a `_test.go` that does two
things: script the family's far end as an HTTP server (`httptest`) in the
family's own wire shapes, and call `conformance.Run` over it. Nothing else is
added to the pipeline for a family — no case in the normaliser, the
convergence loop or the registrar. A scenario the family cannot be put into is
refused by the test's `Setup` and reported as skipped **by name**.

A family whose bulk read is paged calls `driver.NextPage` before each page
after the first, uses pages of at least `driver.MinPageSize`, and serves
`GetUsageFor` from a subset endpoint, never from the pages (ADR-0081).

A family that reports one byte total, not an up/down split, puts it in
`DownBytes` (`driver.ClientUsage`). The suite accepts either shape as the far
end's figure (`readsAs`); it accepts no third one.

Building a driver from a `panel` row — `driverType`, `apiBaseUrl` and the login
in the owner's vault — is not a family's job. That is `internal/opener`
(`contract.registration.md` "The Opener"); a new family adds one `case` there.

## Marzban (F-027-ae)

`internal/driver/marzban`. Pull, `cumulative`, and the panel enforces its own
per-user `data_limit`: the first family that carries ADR-0072 end to end.

| Marzban | ours |
|---|---|
| `POST /api/admin/token` (form login), bearer token | made on the first call; a `401` is an expired token, so **one** login and one retry. A login refused is `blocked` and is not retried |
| `GET /api/users` | `GetUsage` and `ListClients`: every user, one request |
| `GET /api/users?username=…` | `GetUsageFor`: the named subset, one request; an empty set sends none |
| `username` | `RemoteID`. Created as the uuid without hyphens (32 characters, inside Marzban's rule) and never changed, since Marzban cannot rename |
| `note` | `Label` — the claim tag |
| `proxies.<type>.id` (or `.password` for trojan/shadowsocks) | `UUID` |
| `used_traffic` | `DownBytes`; `UpBytes` is 0. There is no split to report |
| `data_limit` | `DataLimitBytes`, as the panel holds it (null reads 0 = no limit) |
| `status` `disabled` | `Enabled = false`; every other status is enabled by us |
| `expire` (unix seconds, 0 = none) | `ExpiresAt` |

The rules:

1. **A zero ceiling is written as one byte.** Marzban reads `data_limit: 0` as
   unlimited, and a zero ceiling here is a cut-off (`driver.go`
   `SetClientDataLimit`). Written through, an exhausted allowance would become
   free traffic. The convergence loop already rewrites an exhausted allowance
   every pass (`contract.ceiling.md`), so reading back 1 where it asked for 0
   changes nothing there.
2. **Every write sets `data_limit_reset_strategy: no_reset`.** Any other
   strategy zeroes the counter on Marzban's schedule, a second writer of the
   quota (`internal_credit_disablable`).
3. **A client wanted disabled is created, then disabled.** Marzban creates
   only `active` or `on_hold` users. The window is one request, and the client
   is already under its first block (`driver.CreateClientRequest`).
4. **`UpdateClient` reads the user first.** The request carries no protocol,
   and the user keeps the proxy type it has. Updates are rare (regenerate,
   rebuild), so the extra request is not on a pass's path.
5. **No per-user rate limit.** `SetClientRateLimit(0)` is already true and
   succeeds; any other rate is `unsupported`, never believed.
6. **Links are Marzban's.** `SubscriptionURL` resolves `subscription_url`
   against the panel (it is a path unless the panel sets a prefix);
   `BuildLink` returns the link Marzban built for the inbound's protocol,
   because one assembled here would disagree with the one Marzban serves.

Its questionnaire answers: every row yes except `per_client_rate_limit`.
Verdict `accepted`, metered sale allowed.

Conformance: the eleven pull scenarios pass. The four push scenarios and
`ceiling_refused` are skipped by name (no sessions, and the ceiling always
exists). `marzban_test.go` also pins rules 1-3 and the one-login retry.

## Sanaee — MHSanaei 3x-ui (F-027-ah)

`internal/driver/sanaee`. Pull, `cumulative`, and the panel enforces its own
per-client total, so it carries ADR-0072 as Marzban does. It speaks **v2.x**:
3x-ui v3.x is `three_x_ui` below; the two x-ui forks are `contract.xui.md`,
Hiddify Manager is `contract.hiddify.md`, and Marzneshin
`contract.marzneshin.md`.

A client lives inside its inbound: its settings are one element of the
inbound's `settings` JSON string, and its counters are one row of the
inbound's `clientStats`.

| 3x-ui | ours |
|---|---|
| `POST /login` (form), session cookie | made on the first call. Every reply is `{success, msg, obj}`, and `success=false` on a 200 is a failure. A `404` (v2 hides its API) or `401` (older versions) is an expired session: **one** login, one retry |
| `GET /panel/api/inbounds/list` | `GetUsage`, `ListClients`, `ListInbounds`, and `GetUsageFor` (a subset is filtered out of it, since `getClientTraffics` reads one email per request) |
| `addClient`, `updateClient/{uuid}`, `{id}/delClient/{uuid}` | the lifecycle. A trojan client is keyed by its password |
| `email` | `RemoteID`: the uuid without hyphens. It is unique on the panel and keys the counters, so it is never changed |
| `comment` | `Label`, the claim tag |
| `id` (or `password` for trojan) | `UUID` |
| `clientStats.up` / `.down` | `UpBytes` / `DownBytes` |
| `totalGB` (bytes, despite the name) | `DataLimitBytes` |
| `enable` | `Enabled` |
| `expiryTime` (unix ms, 0 = none) | `ExpiresAt` |

The rules:

1. **A zero ceiling is written as one byte.** `totalGB: 0` is unlimited on
   3x-ui, as `data_limit: 0` is on Marzban.
2. **Every write sets `reset: 0`.** Any other value zeroes the counter every
   that many days, a second writer of the quota (`internal_credit_disablable`).
3. **Every write reads the panel first.** 3x-ui writes a whole client, never a
   field, so the fields we do not own (`limitIp`, `tgId`, `flow`, `subId`) are
   carried through unchanged. A client cannot move inbound or protocol.
4. **An inbound's last client is disabled, not deleted.** 3x-ui refuses that
   delete. `DeleteClient` disables the client and returns `unsupported`, never
   done, because the client is still there. A client already gone is done.
5. **No per-client rate limit.** `limitIp` counts addresses, not bandwidth.
   `SetClientRateLimit(0)` succeeds and any other rate is `unsupported`.
6. **The subscription is the link.** 3x-ui builds share links in its browser
   page, so `BuildLink` is `unsupported`. `SubscriptionURL` is the address
   that page shows: the panel's `subURI` if set, otherwise the sub server's
   scheme, domain (or the panel's host), port and path, then the client's
   `subId`, all read from `POST /panel/setting/all`. With the sub server off it
   returns false.

`apiBaseUrl` includes the panel's secret web path, and every route above is
relative to it.

Its questionnaire answers: every row yes except `per_client_rate_limit` and
`usage_for_named_subset`. Verdict `accepted`, metered sale allowed.

Conformance: the eleven pull scenarios pass. The four push scenarios and
`ceiling_refused` are skipped by name. `sanaee_test.go` also pins rules 1, 2
and 4, the create round trip and the one-login retry. **Opened by
`internal/opener`** with the panel's login, typed `username:password`.

## 3x-ui v3 — `three_x_ui` (F-027-bb)

`internal/driver/threexui`. The same product as Sanaee, v3.x: v3 removed the
`inbounds/addClient|updateClient|delClient` routes v2 writes through, so it is
a family of its own (user, 2026-09-24). Pull, `cumulative`, ADR-0072 as above.

| 3x-ui v3 | ours |
|---|---|
| `GET /csrf-token`, then `POST /login` (form) with `X-CSRF-Token` | the session; every later POST carries the token too, or is a `403`. A `401` is an expired session: **one** fresh token and login, one retry. A `404` is real (v3 answers the panel's ajax with `401`) |
| `GET /panel/api/clients/list` | `GetUsage`, `GetUsageFor` (filtered), `ListClients`: every client with `inboundIds` and its `traffic` row, unpaged |
| `clients/add` (`{client, inboundIds}`), `clients/update/{email}`, `clients/del/{email}`, `clients/resetTraffic/{email}` | the lifecycle, keyed by email |
| `uuid` (or `password` for trojan) | `UUID`; `id` on the list is the panel's row number |
| `traffic.total` / `totalGB` | `DataLimitBytes` (the traffic row is the one enforced) |
| `POST /panel/api/setting/all` | `SubscriptionURL`, built as Sanaee's rule 6 |

Its own rules, beside Sanaee's rules 1, 5 and 6, which hold unchanged:

1. **An update writes the whole client.** A field left out is zeroed, except
   the credentials and `subId`. Every write reads the client first and carries
   `limitIp`, `limitHwid`, `tgId`, `flow`, `security`, `group` and the rest.
2. **No renewal of its own.** `reset`, `resetDay`, `resetMax` are written 0
   and `trafficReset` `never` on every write: each is a second quota writer.
3. **A delete is a delete.** v3 has no last-client rule; the counters go too.
4. **A client is not moved.** One on several inbounds reports its lowest id;
   an update naming another inbound is `unsupported`.

A v3 panel registered as `sanaee` fails its connection test at the login
(`403`, no token); a v2 panel as `three_x_ui` fails at `/csrf-token` (`404`).
Questionnaire and conformance as Sanaee's (11 pass, 5 skipped by name);
`threexui_test.go` also pins the token, rules 1-3 and the one-login retry.
Opened by `internal/opener` with the `username:password` login; v3's API token
is not used (user, 2026-09-24).

## Mikrotik User Manager (F-027-ag)

`internal/driver/usermanager`. Push, `session`: the NAS sends accounting to
`internal/radius`, and this driver is the router's REST API (RouterOS v7,
`/rest/user-manager/…`, basic auth on every request). IBSng is F-027-ay.

User Manager has no per-user ceiling. A ceiling is a limitation on a profile on
the user, so **every client is its own chain of five rows**: user, limitation
`txnet-<user>`, profile `txnet-<user>`, and the two links. The chain is found by
name, so no router id is kept.

| User Manager | ours |
|---|---|
| `user.name` | `RemoteID`: the uuid without hyphens, which is the `User-Name` the receiver places bytes by. Never renamed |
| `user.password` | `UUID`. Regenerating a config gives it a new password |
| `user.comment` | `Label`, the claim tag |
| `user.disabled` | `Enabled` |
| limitation `transfer-limit` | `DataLimitBytes`, counted against upload plus download |
| limitation `rate-limit-rx` / `-tx` | `RateLimitBps`, the same figure both ways |
| `session` where `active=true` | `GetUsage`: one request. `upload`→`UpBytes`, `download`→`DownBytes`, `acct-session-id`→`SessionID` |
| `router` | `ListInbounds`: one per NAS, with `Protocol` left empty because a NAS serves several |

The rules:

1. **We are the only writer of the quota** (`internal_credit_disablable`).
   Every profile is written `price=0`, `validity=unlimited`,
   `starts-when=assigned`. Every limitation is written
   `reset-counters-interval=disabled`. A price waits for a payment, a validity
   ends the user on the router's clock, and a reset zeroes usage on its
   schedule. So no tenant-side `metering_only` mode is needed for this family.
2. **A zero ceiling is written as one byte.** RouterOS reads 0 as no limit, as
   Marzban does.
3. **Every write is resumable.** A named row is patched if it exists and made
   if not, and a link is made only if it is missing. The router refuses a
   second row with the same name, so a create that died halfway would
   otherwise fail on every retry. The user's profile link is written last,
   because User Manager refuses a login that has no profile. `DeleteClient`
   removes the chain in reverse and treats "already gone" as done.
4. **`ListClients` reports the most permissive ceiling the user holds.** It is
   four requests, whatever the number of users. Suppose a second profile with
   no limit was attached by hand. The user can use it, so the row reads 0, no
   limit: the money-hole finding of ADR-0072 rule 2. It is not our ceiling
   hiding the extra profile. A profile in state `used` grants nothing and is
   ignored.
5. **`GetUsage` reads open sessions only.** A closed session's last figure came
   in its `Stop` to the receiver, so reading it again here would count the same
   bytes twice. `GetUsageFor` is served from the same single request.
6. **Disabling refuses the next login.** User Manager does not cut a session
   that is already open. The ceiling is what ends that session's traffic.
7. **Some calls have nothing to do.** `ResetUsage` and `BuildLink` return
   `unsupported`, and `SubscriptionURL` returns false. `CreateClient` accepts
   `pppoe` and `openvpn` and refuses any Xray protocol.

The connection test fails, rather than answering, on a router whose User
Manager is disabled. Its answers are yes on every push-scope row except
`usage_reset_supported`, `stable_remote_id` (we key on the name),
`native_subscription_link` and `server_side_expiry` (validity is a duration
from assignment, not a date). Verdict: `accepted`, metered sale allowed.

Conformance: the three push scenarios pass. `missing_gigawords` is skipped by
name, because a RouterOS NAS sends Gigawords, and the receiver holds any session
that arrives without them anyway. The eleven pull scenarios and
`ceiling_refused` are skipped too. `usermanager_test.go` also pins rules 1-5 and
the connection test.

**Opened by `internal/opener`** (F-027-az) with the panel's login, typed
`username:password` as Marzban's is, against `apiBaseUrl`, the router's REST
root. The NAS's RADIUS secret is a separate vault reference, which only the
allowlist reads (`contract.collection.md`).
