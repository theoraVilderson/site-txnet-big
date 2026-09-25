---
id: network
layer: domain
status: draft
version: 17
updated: 2026-09-24
---

# Link capture: what a panel gives one client (F-027-bi)

A topic file of `contract.md` (§10), beside `contract.drivers.md`. What governs
`driver.Driver.ClientLinks` and `network-service/internal/driver/links.go`: the
lines `/sub` will serve (ADR-0082 rule 2); and, under "Stored lines" below,
when the provisioning pass captures them and where they are kept (F-027-bj,
`internal/converge/links.go`).

## The rules

1. **Every line, as the panel built it.** `ClientLinks(ctx, client)` returns
   every link line the panel gives that client, in the panel's order. None is
   assembled here: a family builds its links from host, domain and transport
   settings the admin API does not fully show, and a line of ours would
   disagree with the one the panel serves.
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
   is. Inside it a family makes at most three requests (x-ui: the client list,
   the settings, the sub server). Capture runs only when a client is created,
   regenerated, moved or re-keyed (rule 6), never for a config that is steady.

## Per family

| Family | Lines come from | None when |
|---|---|---|
| Marzban | `links` on `GET /api/user/{name}` (`contract.drivers.md` rule 6) | the user has no links |
| Marzneshin | `<subscription_url>/links` (`contract.marzneshin.md` rule 9) | no `subscription_url` |
| Hiddify | `<clientBaseUrl>/<uuid>/sub/` (`contract.hiddify.md` rule 8) | no `clientBaseUrl` |
| Sanaee, 3x-ui v3, x-ui (alireza0) | the sub server, at the address `SubscriptionURL` builds (Sanaee rule 6) | no `subId`, or the sub server off |
| User Manager | nothing: a PPP login is a name and a password | always |
| fake | one `vless://` line per client | `native_subscription_link` declared no |

A name or uuid the panel does not hold is a fault, not "none": it is a client
that should exist and does not, which is drift (`contract.drift.md`).

## Stored lines (F-027-bj)

6. **Captured on the read that confirms, keyed by the client read.** The
   provisioning pass calls `ClientLinks` on a client the pass confirmed
   (`complete`: matched, present, holding the desired state), and only when the
   row's lines were read from another client, another `remoteId` or `uuid`.
   That one test is every trigger: a create, a move (a new row) and a recreate
   confirm a client the row has no lines from; a regenerate confirms a new
   `uuid`; a rename or a rebuild re-keys `remoteId`. Our own write confirms
   nothing, so a capture lands one pass after it, like `complete` does.
7. **Stored on `network.config`.** `linkLines` (in the panel's order),
   `linksRemoteId` and `linksUuid` (the key), `linksCapturedAt`. CHECK
   `config_links_captured_from_a_client`: key and time together, and lines only
   with both. Empty lines with a time is a panel that gives none (rule 2); no
   time is a client never captured. `/sub` can tell a stale capture from a
   fresh one by `linksUuid = uuid`.
8. **A failed read keeps what is stored.** It is a `links_unread` finding with
   the driver's fault, not a refused write; the re-key or state change the
   pass made is still recorded, and the capture is retried on the next pass
   because its key still differs. A panel whose sub server is down is asked
   once a pass per unconfirmed config, inside its budget.

Stored by `converge.PostgresDesired`, as the rest of the desired state is
(`contract.provisioning.md` "Staging", F-027-bo): a capture writes lines, key
and time in one statement, and an outcome with none leaves them untouched. The
columns are in `db.RequiredColumns`.

## Revisit

ADR-0082's trigger: a family whose lines change on the panel with no change we
make (rotating keys, per-request tokens) needs a capture schedule, not only a
capture at convergence.
