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
in the owner's vault — is not a family's job. That is the `Opener`, F-027-aw
(`contract.registration.md` "Not here yet").

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
