---
id: network
layer: domain
updated: 2026-10-21
---

# Contract — reading an import's source panel (F-201-b)

A reseller leaving another panel brings its users with it (D-63). This is the
read half: `network-service` reads the old panel and answers what it holds,
normalised. The run, its items and the commit are entitlement's
([../entitlement/data-model.md](../entitlement/data-model.md), F-201-a); this
file says what the read does and what it never does.

Code: `network-service/internal/source` (the read), `internal/httpapi/source.go`
(the routes), `internal/driver/conformance/readonly.go` (the proof),
`internal/driver/sui` (S-UI, read-only).

## Rules

1. **Never a write.** The source is the reseller's live panel, still serving
   its users. Every read takes `source.Reader` — the read half of
   `driver.Driver` (`ListInbounds`, `ListClients`, `GetUsage`,
   `SubscriptionURL`, `ClientLinks`) — so a write does not compile; and
   `conformance.RunReadOnly` runs a snapshot and a link batch against each
   family's scripted panel and fails on any request that is not a read or the
   login, counted at the panel. Every family an import reads calls it beside
   `conformance.Run`.
2. **Adversarial input** (catalog §16). Dialed through `internal/egress` with
   the **bare** guard — a source is always a tenant's choice, never
   `PANEL_EGRESS_ALLOW_CIDRS` (ADR-0095) — no redirect followed
   (`source_redirected`), each request bounded by 30 s, each answer by 32 MiB.
3. **Caps.** A source of more than 20 000 clients is refused whole
   (`source_too_large`), never imported in part. A link batch is at most 200
   clients.
4. **Two reads, decided 2026-10-21 (user).** Most families answer a client's
   subscription URL and lines one request each — tens of thousands for a big
   panel. So the **snapshot** is the bulk calls only (inbounds, clients,
   usage: a few requests) and carries the lines the list already read
   (`linesRead`) and, where the family lists it in bulk
   (`driver.SubscriptionsReader`, every import family), each client's own
   `subscriptionUrl` — the old link an import keeps answering (F-203-a), since
   the commit can no longer read the source; **links** reads the rest in
   batches the dry run (F-206) can retry and report on. A protocol fault on one client is recorded on it
   (`failure`) and the batch goes on; any other fault fails the batch.
5. **Paced** at 300 requests a minute through `driver.Pace`, whose breaker and
   adaptive rate halve it on a 429 or 5xx (F-027-df). A batch of 200 is at
   most 400 requests.
6. **The address and login are read per request** from the vault by the
   run's reference and held for that request only (F-201-d). Neither is in a
   request body: a panel's web path is as secret as its login. Neither is
   logged, returned or stored here. Its shape is the registered panel's (`username:password`;
   Hiddify's API key alone) — `opener.Build` is the one place a driver is
   built from a login.
7. **Families.** Marzban, Marzneshin, both x-ui forks, 3x-ui, S-UI, Hiddify
   (`source.IsFamily`). One without a driver yet answers `no_driver` until it
   ships (legacy x-ui `x_ui_vaxilu`).
8. **S-UI is read-only** (F-201-c, `internal/driver/sui`). A reseller leaves
   it; nobody registers a panel on it, so `opener.HasDriver` leaves it off
   (registration answers `no_driver`) and `opener.HasReader` lets
   `opener.Build` open it for a source only. Every write, `Capabilities` and
   `BuildLink` answer `unsupported`. Its address includes the panel's web path
   (`https://host:2095/app`). `GET api/load` is the bulk read: inbounds,
   clients and `subURI`. A client is keyed by its name, which is unique and
   is its subscription path (`<subURI><name>`, or the `clientBaseUrl` given).
   From v1.1 the list has no config or links, so the snapshot's `uuid` is
   empty and `linesRead` false. A link batch reads `api/clients?id=` per
   client, plus one load for the name → id index. A client on several
   inbounds is listed under its first. A type we do not sell (`naive`,
   `shadowtls`, …) is passed through for the dry run's `unknown_protocol`.
   Tested on a scripted panel only; no live panel yet.

## Routes

Service-only (`x-service-token`), never routed by Traefik. Answers use the
shared envelope: `{data}` or `{error: {reason, detail}}`.

| Route | Body | Answers |
|---|---|---|
| `POST /api/internal/source/snapshot` | `tenantId`, `family`, `credentialRef` (the run id) | `inbounds[]` (`remoteId`, `tag`, `protocol`, `port`, `enabled`), `clients[]` (`remoteId`, `label`, `uuid`, `inboundRemoteId`, `protocol`, `enabled`, `dataLimitBytes`, `upBytes`, `downBytes`, `expiresAt` or null, `lines`, `linesRead`, `subscriptionUrl?`) |
| `POST /api/internal/source/links` | the same, plus `clients[]` (≤ 200: `remoteId`, `uuid`, `label`, `inboundRemoteId`, `linesRead`) | `clients[]`: `remoteId`, `subscriptionUrl?`, `lines`, `linesRead`, `failure?` |
| `POST /api/internal/source/link` | `url` — one old subscription link (F-201-g); billing's test of an old host pointed here (entitlement `contract.legacy-host.md`, F-204-b) | `userinfo` (`uploadBytes`, `downloadBytes`, `totalBytes`, `expiresAt` unix s; 0 = not given) from `Subscription-Userinfo`, `lines` |

The snapshot and links read the address and login through tenant-service's
`POST /api/internal/vault/source-credential/use` (`tenantId`, `credentialRef`
→ `data.credentials`, `data.apiBaseUrl`, `data.clientBaseUrl`;
[../tenant/contract.source-login.md](../tenant/contract.source-login.md)).
A stored address that is not an absolute http(s) url is
`credential_unavailable`. The link route needs no login: the link is the
user's own.

## Refusals

| Reason | Status | Meaning |
|---|---|---|
| `service_only` | 403 | no or wrong service token; an unset token refuses every call |
| `bad_request` | 400 | a field missing, not an import family, not an absolute `http(s)` url, an empty or oversized batch |
| `credential_unavailable` | 422 | the vault would not answer the address and login, or the address is not a url |
| `login_malformed` | 422 | the stored login is not in the family's form |
| `no_driver` | 422 | an import family with no driver yet |
| `address_refused` | 422 | the guard refused the address (inward, metadata, …) |
| `source_redirected` | 422 | the source answered a redirect |
| `source_too_large` | 422 | past 20 000 clients or an answer past 32 MiB |
| `source_login_refused` | 422 | the panel refused the login (401/403) |
| `source_unreadable` | 502 | the panel answered something no driver can read |
| `source_unavailable` | 502 | down, too slow or rate-limiting us; retry later |
