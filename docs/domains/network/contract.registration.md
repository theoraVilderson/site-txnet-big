---
id: network
layer: domain
status: draft
version: 15
updated: 2026-09-24
---

# Registration: the connection test and its verdict

A topic file of `contract.md` (§10). What governs
`network-service/internal/register` and the collection loop's review guard
(F-027-aq). The *why* is **ADR-0080**; the questionnaire itself, its sixteen
rows and `Verdict`, is `contract.md` "The acceptance questionnaire".

## Registration is desired state

Nothing asks `network-service` to test a panel — it has no route anyone could
call (ADR-0071). `billing-service`'s register route (F-027-ar) writes the
`panel` row with `reviewState = pending` and its login into the owner's vault
(`billing/contract.systems.md`). `panelApiCredentials` holds only where the
vault keeps it — `vault:<tenantId>:panel_credentials:panel:<panelId>`
(`panelCredentialRef`, `shared-core`) — never the login; `register.Registrar` finds pending panels on its own tick (30 s by
default), opens a driver for each, runs `Driver.Capabilities` under a 30 s
deadline, and writes the result. A verdict therefore arrives on the next tick,
not in the response to the click, and the systems page shows `pending` until
then (F-027-ad).

One test runs at a time. Registrations are rare, and testing them in parallel
would only spend the connections a collection pass needs.

## A verdict, or no verdict — never a guess

| outcome | written | `reviewState` |
|---|---|---|
| answers validate | `capabilities`, `connectionTestedAt`; fault cleared | `Verdict`'s: `accepted`, `accepted_low_trust` or `refused` |
| unreachable, stalled, refused our credentials, `5xx` | `connectionTestedAt`, `connectionTestFault`, `connectionTestDetail` | stays `pending` |
| driver could not be built (unknown family, credentials do not decrypt) | same, fault `unopenable` | stays `pending` |
| the driver answered a document `Validate` refuses | same, fault `invalid_answers`; the document is **not** stored | stays `pending` |

The rules:

1. **`refused` is a finding about what a panel can do.** It is written only
   from answers that validated. A wrong password, a `503` or a timeout means
   the panel did not answer, and it is never refused for that.
2. **An invalid document is never stored and no verdict is read off it.**
   `Verdict` reads a missing row as "no", so a driver that forgot a row would
   get a panel refused (or accepted under a row nobody tested).
3. **The verdict is written only over `pending`.** A panel withdrawn or
   re-submitted while its test ran keeps what it was given; the late answer
   is counted `Stale` in the pass report and dropped.
4. **The retry is a wait, and a refusal waits longer.** A failed test is
   retried after 5 minutes. After `blocked` or `rate_limited` it waits
   `panelstate.DefaultCooloff` (15 minutes), the same wait every other loop
   honours, because retrying through a ban is what makes it permanent
   (`contract.budget.md`). A re-submitted login (billing's `PUT /systems/panels/:id/credentials`,
   F-027-au) clears `connectionTestedAt` and the fault, so a corrected
   credential is tested on the next tick — except after `rate_limited`, whose
   cool-off a new login does not lift.
5. **A fault lives only on a pending panel.** CHECK
   `panel_connection_fault_is_pending_only`: set only while `pending` and
   always with its time.

`connectionTestFault` is `network.ConnectionTestFault`: the driver's six fault
kinds (`contract.md` "The driver contract") plus `unopenable` and
`invalid_answers`. `register.FaultKind` mirrors it, and
`network-panel-declaration.spec.ts` pins the eight values.

## Only an accepted panel is collected

`collect.Panel.ReviewState` carries `panel.reviewState`, and `collect.Loop.Pass`
skips every panel that `ReviewState.Collectable()` does not open — neither
read nor converged, counted as `Unreviewed` rather than failed. Only
`accepted` and `accepted_low_trust` open it, and the empty state does not:
the guard **fails closed**, so a panel source that forgets the column
collects nothing instead of everything. A refused panel converged would be a
panel provisioned, which is exactly what refusing it was for (invariant 44).

## Not here yet

The Postgres-backed `register.Store` lands with the panel source, beside
`collect.MemoryCursors` (F-027-ax); until it does, `cmd/server` does not start
the pass — the staging every other loop in this service is in.

## The Opener (F-027-aw)

`internal/opener` builds a driver from a pending panel. The vault is Node,
with a data key per tenant, and this service never holds the KEK (user,
2026-09-24): the login is read through `tenant-service`'s service-only
`POST /api/internal/vault/panel-credential/use` (`tenant/contract.vault.md`),
which re-derives the owner's vault from the row and logs the read. One crypto
implementation, every `use` audited where the others are.

1. **The family is checked before the login is read.** A family with no
   driver yet (`ErrNoDriver`) is `unopenable` and costs no vault read; it is
   ours to ship, so it is never `refused`.
2. **A login is typed `username:password`**, split at the first colon. A
   login not in that form is `unopenable`, and no error quotes it — the
   error is what `connectionTestDetail` stores.
3. **A vault refusal names its reason** (`not_owner`,
   `credential_unavailable`, …) and never a value; the panel stays `pending`.
4. The Opener paces nothing: a connection test is one call. Pacing a
   collected panel by its `maxRequestsPerMinute` is the panel source's.
