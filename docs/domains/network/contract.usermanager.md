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

`internal/driver/usermanager`. Pull, `cumulative` (ADR-0161, F-027-ag-b):
the NAS sends its accounting only to User Manager (rule 11), so each user's
lifetime total is read off the router's REST API (RouterOS v7,
`/rest/user-manager/…`, basic auth on every request). IBSng is F-027-ay.

User Manager has no per-user ceiling. A ceiling is a limitation on a profile on
the user, so **every client is its own chain of five rows**: user, limitation
`txnet-<user>`, profile `txnet-<user>`, and the two links. The chain is found by
name, so no router id is kept.

| User Manager | ours |
|---|---|
| `user.name` | `RemoteID`: the uuid without hyphens, the `User-Name` the NAS logs in with. Never renamed |
| `user.password` | `UUID`. Regenerating a config gives it a new password |
| `user.comment` | `Label`, the claim tag |
| `user.disabled` | `Enabled` |
| limitation `transfer-limit` | `DataLimitBytes`, counted against upload plus download |
| limitation `rate-limit-rx` / `-tx` | `RateLimitBps`, the same figure both ways |
| `user/monitor` `total-upload` / `total-download` | `GetUsage`: each user's lifetime total, `UpBytes` / `DownBytes` |
| `router` | `ListInbounds`: one per NAS, protocol `router_login` — one login every dial-in service of the router takes, so a purchase or a move places on it (F-1601-d3) |

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
5. **`GetUsage` is each user's lifetime total**, in three requests whatever
   the number of users: their `.id`s, one `monitor` over them (rule 10),
   and the profile links. Each request past the first pays the budget as a
   page does (ADR-0081), and the conformance suite holds the family to three
   (`conformance.ReadCost`). `GetUsageFor` asks the monitor for the named
   users alone (`driver.BulkUsage`). The total starts again only with the
   user, which the normaliser reads as a reset. Each reading names our link
   (profile `txnet-<user>`) as its `LimitOrigin`, none for a user without
   one (rule 9, `contract.ceiling.md`).
6. **Disabling refuses the next login.** User Manager does not cut a session
   that is already open. The ceiling is what ends that session's traffic.
7. **Some calls have nothing to do.** `ResetUsage` and `BuildLink` return
   `unsupported`, `SubscriptionURL` returns false and `ClientLinks` none.
   `CreateClient` accepts `router_login`, `openvpn` and none (the anchor),
   and refuses any other — Xray's, and `pppoe`, a push panel's session.

The connection test fails, rather than answering, on a router whose User
Manager is disabled or ignores profiles (rule 8). Its answers are yes on every pull-scope row except
`usage_reset_supported`, `per_client_ip_limit`, `stable_remote_id` (we key
on the name), `native_subscription_link` and `server_side_expiry` (validity
is a duration from assignment, not a date). They do not fit a push panel.
Verdict: `accepted`, metered sale allowed.

Conformance: the eleven pull scenarios pass; the four push ones and
`ceiling_refused` are skipped. `usermanager_test.go` also pins rules 1-5 and
the connection test; its far end answers as the router of rules 8-12 does.

**Opened by `internal/opener`** (F-027-az) with the panel's login, typed
`username:password` as Marzban's is, against `apiBaseUrl`, the router's REST
root. A pulled panel keeps no RADIUS secret: the NAS's is User Manager's.

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
   - a link made again would hand the user its ceiling again; the cursor
     keeps our link's `.id` and the total it was first read at, and the
     ceiling counts from there (F-027-du-b, `contract.ceiling.md`);
   - the import's "used" is rebuilt from sessions: those open or ended
     after the user's previous `used` link ended, capped at the lifetime
     total; any doubt keeps the lifetime total (F-1601-f,
     `contract.source.md` rule 10). A session open across a renewal counts
     whole under the new link, which overstates: the safe direction.
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
    total as a `cumulative` counter, on a panel declared `pull` (rule 5,
    ADR-0161).
12. **An unlimited validity's end is `unlimited`**, not a date: the import
    reads it as no end (`source.go`).
13. **A link's dates are fixed when it is made** (F-1601-f). Its `end-time`
    does not move when the profile's `validity` is edited later, so no link
    start can be derived from it. An ended link turns `used` and keeps its
    date; a link made again gets a new `.id` (`*1` becomes `*2`). A `session`
    row names its user, never its link, and `user-profile` carries only
    `.id,end-time,profile,state,user`. `monitor numbers=` also takes row
    positions (`0,1,2`), but its answer names no user, so ids stay the key.

## Adoption in place (F-1601-b2)

A user an import keeps on its router (ADR-0160) is a config with
`adoptedProfile` set: its name is the `remoteId` from the start, its `uuid`
is ours and never the router's password. The driver's `driver.Adopter`
(`adopt.go`) writes no password, ever:

13. **`AdoptClient`**: our chain made and linked, then every other profile
    link of the user removed, then our claim tag into its comment, last. The
    tag is the mark the adoption is done; a call that died half way is
    repeated by the next pass. Its first ceiling is the remaining allocation
    (rule 9: the new link counts from zero).
14. **`ReleaseClient`** (a hand back, ADR-0160 decision 7): the user's own
    profile linked again first, then our link and chain removed, then its
    own comment back. The user is never deleted. A profile the reseller
    deleted since is refused before anything comes off: a user with no
    profile logs nobody in. The profile's validity and limit start again.

The pass (`converge/adopt.go`) for an adopted row: its `uuid` is never
compared or written; a user not under our tag is adopted (once an
allocation exists); a login gone under every key is `login_gone` and never
made again; an absent row with `handBack` is handed back until a read shows
the user without our tag, then its `remoteId` is cleared. Without `handBack`
an absent row is deleted, as any config of ours (decision 8).
