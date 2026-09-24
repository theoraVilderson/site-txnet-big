---
id: network
layer: domain
status: draft
version: 15
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

**Not opened yet.** `internal/opener` has no case for this family. A push
panel's single vault login is also its RADIUS secret (`contract.collection.md`),
so one value cannot be both the REST login and the secret. F-027-az keeps the
two apart and adds the case.
