---
id: network
layer: domain
status: draft
version: 17
updated: 2026-09-24
---

# Hiddify Manager (F-027-be)

A topic file of `contract.md` (§10), beside `contract.drivers.md`, whose "What
every family is" holds here unchanged. What governs
`network-service/internal/driver/hiddify/`.

Pull, `cumulative`, and Hiddify enforces its own per-user limit, so it carries
ADR-0072. It speaks the **v2 admin API**: `apiBaseUrl` is the scheme, host and
the panel's **admin** proxy path, and every route is `api/v2/admin/…` below it.

| Hiddify | ours |
|---|---|
| `Hiddify-API-Key: <admin uuid>` on every request | the login, stored as the key alone (no `username:password`). An unknown key is Hiddify's logout redirect: `blocked`, redirects not followed, nothing retried |
| `GET me/` | `HealthCheck` |
| `GET user/` | `GetUsage`, `GetUsageFor` (filtered), `ListClients`: every user, one unpaged request. An empty panel answers `404 "You have no user"`, read as no users |
| `POST user/`, `PATCH user/{uuid}/`, `DELETE user/{uuid}/` | the lifecycle; a PATCH writes only the fields present and not null |
| `name` | `RemoteID`: created as the uuid without hyphens, never changed by us |
| `comment` | `Label`, the claim tag |
| `uuid` | `UUID`, the one identity every protocol is served under |
| `current_usage_GB` | `DownBytes`; `UpBytes` is 0 (one total, both directions) |
| `usage_limit_GB` | `DataLimitBytes` |
| `enable` | `Enabled` |
| `start_date` + `package_days` | `ExpiresAt` (rule 4) |

The rules:

1. **GB is 1024³ bytes, and no byte is lost.** Hiddify stores bytes and
   answers `bytes / 1024³` as a float64, which holds every count below 2^53
   exactly; the driver multiplies back and rounds. So the limit is checked
   against the same bytes the usage reports, and
   `data_limit_counts_the_same_bytes_as_usage` is yes. `hiddify_test.go` pins
   an odd byte count both ways; read as 10⁹ bytes, it fails.
2. **The remote id is the name, and the uuid is looked up.** The API addresses
   a user only by uuid, and a regenerate changes it. Each read of the panel
   keeps a name -> uuid map; a write to a name not in it reads the panel once,
   and a `404` on a stale uuid reads it once and retries. A name renamed by
   hand is matched by the claim tag (`stable_remote_id` is no).
3. **A regenerate is one PATCH.** The new uuid goes in the body of
   `PATCH user/{old}/`, and Hiddify changes it on the same row
   (`add_or_update(old_uuid=…)`): name, counter and ceiling stay, so no reset
   is seen and no baseline is lost. No write but `ResetUsage` sends
   `current_usage_GB`.
4. **Expiry is in whole days, never early.** Hiddify serves a user through
   the server's date `start_date + package_days`. That last day is written as
   the day after our expiry's UTC date, so the cut-off is never before ours
   in any timezone and at most about two days after it. It reads back as the
   last second before that day, so carrying it through an update writes the
   same day again. No expiry is `package_days` 10000, Hiddify's cap, read as
   none; so is a user with no `start_date` (counted from first use).
5. **Every write sets `mode: no_reset`**, and a create writes every field:
   another mode zeroes the counter on Hiddify's schedule
   (`internal_credit_disablable`), and a field left out takes Hiddify's
   default (1000 GB, 90 days).
6. **Zero is a real ceiling.** Hiddify serves a user until usage is *above*
   the limit and tests the field `is not None`, so 0 is written as 0.
7. **A name two users hold is neither written nor counted.** Writing either
   could be writing someone else's client, and two counters under one remote
   id would read as resets. Both still appear in `ListClients`.
8. **No rate limit, no link.** `SetClientRateLimit(0)` succeeds, any other
   rate is `unsupported`. Links and the subscription are served under the
   **client** proxy path, which the admin API does not report, so `BuildLink`
   is `unsupported` and `SubscriptionURL` returns false.
9. **One inbound per protocol.** A Hiddify user belongs to no inbound, so
   `ListInbounds` reports `vless`, `vmess` and `trojan` on the panel's host;
   a client carries no `InboundRemoteID`.

The key must be the owner's: `GET user/` lists only the users of the key's
admin and its sub-admins, so another admin's users would never be seen.

Its questionnaire answers: every row yes except `usage_for_named_subset`,
`per_client_rate_limit`, `stable_remote_id` and `native_subscription_link`.
Verdict `accepted`, metered sale allowed.

Conformance: the eleven pull scenarios pass; the four push scenarios and
`ceiling_refused` are skipped by name. `hiddify_test.go` also pins rules 1-7,
the empty panel and the refused key. **Opened by `internal/opener`** with the
key as the whole login.
