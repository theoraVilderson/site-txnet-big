---
id: network
layer: domain
status: draft
version: 19
updated: 2026-10-06
---

# Link capture: what a panel gives one client (F-027-bi)

A topic file of `contract.md` (§10), beside `contract.drivers.md`. What governs
`driver.Driver.ClientLinks` and `network-service/internal/driver/links.go`: the
lines `/sub` will serve (ADR-0082 rule 2); and, under "Stored lines" below,
when the provisioning pass captures them and where they are kept (F-027-bj,
`internal/converge/links.go`).

## The rules

1. **Every line, as the panel built it, or as its own page builds it.**
   `ClientLinks(ctx, client)` returns every link line the panel gives that
   client, in the panel's order. None is invented here: a family that serves
   its lines is read. The exception is the x-ui families (alireza0, Sanaee),
   whose page builds lines in the browser from the inbound JSON the admin API
   also answers. Their driver builds the same lines with `driver.XrayLines`,
   a port of x-ui's `inbound.js`, and never reads the sub server (ADR-0088).
   What the port does not cover (xhttp, an old h2/quic network, REALITY with
   no public key, a protocol other than vless/vmess/trojan) builds nothing.
2. **None is a fact, not a failure.** A family or a panel with no links to
   give answers no lines and **no error**, and the config contributes nothing
   to `/sub`, visibly. A read that failed is a `*driver.Fault`, never an empty
   answer, so a transient error can never erase lines already stored.
3. **No credential of ours goes to a subscription.** `driver.FetchLinks` reads
   a public subscription with no admin token, key or panel session. It may sit
   on another host, and whoever serves it would hold the panel's admin power.
   A failure is classified like any call's, `Retry-After` included.
4. **A body is plain or base64.** `driver.ParseLinks` accepts both, padded or
   not, standard or URL-safe. A line is kept when it has a scheme; anything
   else is dropped, so a login page read by mistake gives no lines. A body over
   1 MiB is a `protocol` fault.
5. **One budgeted call.** `ClientLinks` is paced as one call, as `BuildLink`
   is. Inside it a family makes at most three requests (3x-ui v3: the client
   list, the settings, the sub server; alireza0 and Sanaee: the client list). Capture runs only when a client is created,
   regenerated, moved or re-keyed (rule 6), and on a capped refresh (rule 6b):
   its inbound edited, or once a day. Sanaee, alireza0 and Marzban are never
   asked after a create: `ListClients` hands their lines over (rule 6b).

## Per family

| Family | Lines come from | None when |
|---|---|---|
| Marzban | `links` on `GET /api/user/{name}`, and on every user of the list `ListClients` reads (`contract.drivers.md` rule 6) | the user has no links |
| Marzneshin | `<subscription_url>/links` (`contract.marzneshin.md` rule 9) | no `subscription_url` |
| Hiddify | `<clientBaseUrl>/<uuid>/sub/` (`contract.hiddify.md` rule 8) | no `clientBaseUrl` |
| Sanaee, x-ui (alireza0) | built from the client's inbound (`driver.XrayLines`, ADR-0088): one line, or one per `externalProxy` entry; the address is the inbound's `listen`, else `clientBaseUrl`'s host, else the panel's | the inbound's stream is one the port does not cover |
| 3x-ui v3 | the sub server, at the address `SubscriptionURL` builds (Sanaee rule 6) | no `subId`, or the sub server off |
| User Manager | nothing: a PPP login is a name and a password; an OpenVPN buyer gets the router's uploaded `.ovpn` instead (below) | always |
| fake | one `vless://` line per client | `native_subscription_link` declared no |

A name or uuid the panel does not hold is a fault, not "none": it is a client
that should exist and does not, which is drift (`contract.drift.md`).

## Stored lines (F-027-bj)

6. **Captured on the read that confirms, keyed by the client read.** The
   provisioning pass calls `ClientLinks` on a client the pass confirmed
   (`complete`: matched, present, holding the desired state), and only when the
   row's lines were read from another client, another `remoteId` or `uuid`.
   That test is every trigger but a refresh (rule 6b): a create, a move (a new row) and a recreate
   confirm a client the row has no lines from; a regenerate confirms a new
   `uuid`; a rename or a rebuild re-keys `remoteId`. A capture that stored
   **no** lines stands for `converge.EmptyRecapture` (one hour) and is then
   asked again (F-111-v, ADR-0088 rule 5), so lines that appear later, or a
   config captured before its family's lines were built, fill in with no key.
6b. **Lines follow the panel: from the pass's own read, else a refresh**
   (ADR-0123). Sanaee and alireza0 build every client's lines from the inbound
   list, and Marzban's user list carries its `links`, so `ListClients` hands
   them over (`RemoteClient.Lines`, `LinesRead`). The pass compares them with
   the stored ones on **every** pass and writes only a change: no request, no
   cap, and an inbound edited on the panel reaches `/sub` in the next pass.
   For the rest (3x-ui v3, Hiddify, Marzneshin), lines
   read from this very client are read again when the row's inbound's
   `panel_inbound.fingerprint` is set and is not the `linksInboundFingerprint`
   they were read under — the inbound was edited on the panel — or when they
   are `converge.LinesRecapture` (24h) old, for a family whose edits move no
   fingerprint of ours; age runs from `linksCheckedAt`. The x-ui family
   fingerprints (`driver.XrayFingerprint`: address, port, protocol, remark,
   stream, `settings` less `clients`), read every `InboundReadEvery` (2 min,
   `contract.inbounds.md` rule 1); the others return none. A pass refreshes at most `InboundRefreshPerPass` (10),
   and for age only while under `AgedRefreshPerPass` (2): one counter, so an
   edited inbound goes first, and the pass's writes are not starved of the
   budget. A row with no inbound of its own (rule 7 of `contract.inbounds.md`)
   has no fingerprint and is refreshed on age alone.
6a. **A create captures in its own pass** (F-111-k). After a create or a
   recreate the pass calls `ClientLinks` on the client the panel answered
   with, keyed by that client, so a buyer's `/sub` is filled in the pass that
   placed them and not a minute later. The row stays `partial` — a link read is
   not the list read that makes it `complete` — and the confirming read finds
   the lines already read from that client and asks nothing. A failed read is
   rule 8. A regenerate still captures on the confirming read: an update
   answers with no client to key the lines by.
7. **Stored on `network.config`.** `linkLines` (in the panel's order),
   `linksRemoteId` and `linksUuid` (the key), `linksCapturedAt`,
   `linksCheckedAt`, `linksInboundFingerprint` (rule 6b, null = none known).
   `linksCapturedAt` is **since when these lines are served**: it moves only
   when the lines or `linksUuid` change, never on a same-lines refresh, because
   billing's drain waits `2 × subscriptionTtlSeconds` from it
   (`group-drain.ts`, `replacementSince`). `linksCheckedAt` is the last read,
   a refresh's too, and the age rule 6b and `EmptyRecapture` count from. CHECK
   `config_links_captured_from_a_client`: key and time together, and lines only
   with both. Empty lines with a time is a panel that gives none (rule 2); no
   time is a client never captured. `/sub` can tell a stale capture from a
   fresh one by `linksUuid = uuid`.
7a. **A capture is announced in the statement that writes it** (F-111-l).
   `recordSQL` returns the row and inserts `network.grant.linksCaptured`
   (`{tenantId, userId, grantId, configId}`) into the outbox only when the
   capture changed the lines or the `linksUuid` they were read for — a
   refresh that read the same is silent (rule 6b) — so the event and the lines commit together
   (ADR-0021) and a dropped outcome announces nothing. One event per captured
   config that changed; a steady one is refreshed silently (rule 6b).
   Automation pushes it to the owner (`automation/contract.notices.md`). The
   payload carries `cause` (F-027-eo): `panel` when lines were already served
   for this very `linksUuid` and the panel built others — an edit on the
   panel, and the buyer is told to update their app — else `ours` (a first
   capture, a move, a regenerate).
8. **A failed read keeps what is stored.** It is a `links_unread` finding with
   the driver's fault, not a refused write; the re-key or state change the
   pass made is still recorded, and the capture is retried on the next pass
   because its key still differs. A panel whose sub server is down is asked
   once a pass per unconfirmed config, inside its budget.

Stored by `converge.PostgresDesired`, as the rest of the desired state is
(`contract.provisioning.md` "Staging", F-027-bo): a capture writes lines, key
and time in one statement, and an outcome with none leaves them untouched. The
columns are in `db.RequiredColumns`.

## A router's `.ovpn` (F-307-d)

9. **One file per router, uploaded, never built.** RouterOS's API returns no
   client file, and a User Manager OpenVPN login is the same file for every
   user plus their own name and password. So `network.panel.ovpnProfile`
   holds the file the router's admin uploaded (billing
   `contract.panel-lifecycle.md` rule 5a): server, CA, `auth-user-pass`, no
   key. CHECKs `panel_ovpn_profile_is_user_manager` and
   `panel_ovpn_profile_is_bounded` (64 KiB). `network-service` never reads it.
10. **The login is the captured key.** The owner is answered
    `{username: linksRemoteId, password: uuid}` only while `linksUuid` =
    `uuid` — the client the pass confirmed (rule 6) — so a regenerate shows
    no login until the router holds the new one (billing `contract.gift.md`).
    A changed server certificate is a new upload; nothing re-reads it.

## Revisit

ADR-0123's: a family whose inbound edits a buyer needs sooner than a day and
that has no fingerprint — give its driver one.
