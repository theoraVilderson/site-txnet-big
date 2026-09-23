---
id: network
layer: domain
status: draft
version: 15
updated: 2026-09-23
---

# Registration: the connection test and its verdict

A topic file of `contract.md` (§10). What governs
`network-service/internal/register` and the collection loop's review guard
(F-027-aq). The *why* is **ADR-0080**; the questionnaire itself, its sixteen
rows and `Verdict`, is `contract.md` "The acceptance questionnaire".

## Registration is desired state

Nothing asks `network-service` to test a panel — it has no route anyone could
call (ADR-0071). `billing-service`'s register route (F-027-ar) writes the
`panel` row with `reviewState = pending` and its credentials through the
vault; `register.Registrar` finds pending panels on its own tick (30 s by
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
   (`contract.budget.md`). A re-submission clears `connectionTestedAt`, so a
   corrected credential is tested on the next tick.
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
`collect.MemoryCursors`; the `Opener` that builds a real driver from
`driverType`, `apiBaseUrl` and the vault's credentials lands with the first
real family (F-027-ae). Until both do, `cmd/server` does not start the pass —
the staging every other loop in this service is in.
