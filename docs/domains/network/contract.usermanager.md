---
id: network
layer: domain
status: active
version: 1
updated: 2026-10-23
---

# Mikrotik User Manager (F-027-ag)

A topic file of `contract.md` (§10), beside `contract.drivers.md`, whose "What
every family is" holds here unchanged. What governs
`network-service/internal/driver/usermanager/`. Split out of
`contract.drivers.md` on 2026-10-23, when a real router (F-1601-e) added
rules 8-12.

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
   because User Manager refuses a login that has no profile (with
   `use-profiles=yes`, rule 8). `DeleteClient`
   removes the chain in reverse and treats "already gone" as done.
4. **`ListClients` reports the most permissive ceiling the user holds.** It is
   four requests, whatever the number of users. Suppose a second profile with
   no limit was attached by hand. The user can use it, so the row reads 0, no
   limit: the money-hole finding of ADR-0072 rule 2. It is not our ceiling
   hiding the extra profile. A profile in state `used` grants nothing and is
   ignored.
5. **`GetUsage` reads open sessions only**, assuming a closed one's `Stop`
   reached the receiver — which a real router does not send (rule 11;
   F-027-ag-b replaces this read). `GetUsageFor` shares that request.
   `ClientTotals` is each user's lifetime total, in two requests: the users'
   `.id`s, then one `monitor` over them (rule 10; `contract.ceiling.md`,
   F-027-du).
6. **Disabling refuses the next login.** User Manager does not cut a session
   that is already open. The ceiling is what ends that session's traffic.
7. **Some calls have nothing to do.** `ResetUsage` and `BuildLink` return
   `unsupported`, `SubscriptionURL` returns false and `ClientLinks` none.
   `CreateClient` accepts `pppoe` and `openvpn` and refuses any Xray protocol.

The connection test fails, rather than answering, on a router whose User
Manager is disabled or ignores profiles (rule 8). Its answers are yes on every push-scope row except
`usage_reset_supported`, `stable_remote_id` (we key on the name),
`native_subscription_link` and `server_side_expiry` (validity is a duration
from assignment, not a date). Verdict: `accepted`, metered sale allowed.

Conformance: the three push scenarios pass. `missing_gigawords` is skipped by
name, because a RouterOS NAS sends Gigawords, and the receiver holds any session
that arrives without them anyway. The eleven pull scenarios and
`ceiling_refused` are skipped too. `usermanager_test.go` also pins rules 1-5 and
the connection test; its far end answers as the router of rules 8-12 does.

**Opened by `internal/opener`** (F-027-az) with the panel's login, typed
`username:password` as Marzban's is, against `apiBaseUrl`, the router's REST
root. The NAS's RADIUS secret is a separate vault reference, which only the
allowlist reads (`contract.collection.md`).

## Proved on a real router (F-1601-e)

A RouterOS 7.24.5 CHR with User Manager runs in dev-docker
(`dev-docker/routeros/`, profile `routeros`). `probe.sh` there re-proves
rules 8-11 in eight checks; `live_test.go` runs this driver against it
(`USERMANAGER_LIVE_URL`). Each rule below is what the router did, not what
its documentation says.

8. **`use-profiles=yes` or nothing holds.** A fresh install has it off, and
   then a user logs in on name and password alone: every profile and
   limitation is ignored, a 1 GB limit included. The connection test refuses
   such a router and names the setting.
9. **`transfer-limit` counts from the profile link, not the user's life.** A
   user with 600 MB used, given a fresh link at 500 MB, logs in; the limit
   refuses only after 600 MB more under that link ("Transfer limit
   reached", at the next login). Removing a link and making it again, or a
   renewal after the old one ended, starts at zero. The router flags the
   sessions of a removed or ended link `expired` — lazily, at a later
   accounting packet, so the flag cannot be read as the count. Nothing on
   REST reports the count itself. So:
   - an adoption's first ceiling is the remaining allocation, with no
     pre-import usage added (ADR-0160 decision 9, F-1601-b2);
   - a link we make again hands the user its ceiling again — closed by
     tracking the link's `.id` (F-027-du-b, user 2026-10-23);
   - the import's "used" is the lifetime total, more than a renewed user's
     current profile counts — the safe direction (F-1601-f).
   The limit is not sent to the NAS: an Access-Accept carries
   `Mikrotik-Rate-Limit` but no total-limit attribute. Whether User Manager
   ends a session that crosses the limit mid-way was not tested.
10. **`user/monitor numbers=` takes row `.id`s.** A user's name is a 404, so
    is one unknown id among many; the answer is in the order asked, totals in
    plain bytes, and a lifetime figure (it keeps the sessions of ended links).
11. **A session's accounting goes only to the server that logged it in.** With
    User Manager as the NAS's first `/radius` entry and an answering second
    entry, the second hears `Accounting-On` and nothing of any session: no
    Start, Interim or Stop. So `RADIUS_ACCT_ADDR` never hears a User Manager
    deployment, and its usage is read from the router: each user's lifetime
    total as a `cumulative` counter (F-027-ag-b, user 2026-10-23).
12. **An unlimited validity's end is `unlimited`**, not a date: the import
    reads it as no end (`source.go`).
