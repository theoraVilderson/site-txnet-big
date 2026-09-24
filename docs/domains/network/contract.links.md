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
lines `/sub` will serve (ADR-0082 rule 2). Where they are stored and when a
capture runs is F-027-bj's, and is not built yet.

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
   regenerated, moved or re-keyed, never on a collection pass.

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

## Revisit

ADR-0082's trigger: a family whose lines change on the panel with no change we
make (rotating keys, per-request tokens) needs a capture schedule, not only a
capture at convergence.
