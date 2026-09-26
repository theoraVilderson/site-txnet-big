---
id: network
layer: domain
status: draft
version: 16
updated: 2026-09-26
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
(`panelCredentialRef`, `shared-core`) — never the login. A push panel's
RADIUS secret lands beside it under `panelRadiusSecret`
(`…:panel:<panelId>:radius`, F-027-az); the connection test never reads it.
`register.Registrar` finds pending panels on its own tick (30 s by default), opens a driver for each, runs `Driver.Capabilities` under a 30 s
deadline, and writes the result. A verdict therefore arrives on the next tick,
not in the response to the click, and the systems page shows `pending` until
then (F-027-ad) — and then the answer, without a reload (F-027-bs, below).

One test runs at a time. Registrations are rare, and testing them in parallel
would only spend the connections a collection pass needs.

## A verdict, or no verdict — never a guess

| outcome | written | `reviewState` |
|---|---|---|
| answers validate | `capabilities`, `connectionTestedAt`; fault cleared | `Verdict`'s: `accepted`, `accepted_low_trust` or `refused` |
| unreachable, stalled, refused our credentials, `5xx` | `connectionTestedAt`, `connectionTestFault`, `connectionTestDetail` | stays `pending` |
| driver could not be built (unknown family, credentials do not decrypt) | same, fault `unopenable` | stays `pending` |
| the driver answered a document `Validate` refuses | same, fault `invalid_answers`; the document is **not** stored | stays `pending` |
| answers validate, and the panel **is one already registered** (below) | as a verdict, plus `duplicateOfPanelId` | `refused` |
| the duplicate check could not run (a list failed, the canary could not be made) | a fault, the detail naming the suspect | stays `pending` |

The rules:

1. **`refused` is a finding about what a panel can do.** It is written only
   from answers that validated. A wrong password, a `503` or a timeout means
   the panel did not answer, and it is never refused for that.
2. **An invalid document is never stored and no verdict is read off it.**
   `Verdict` reads a missing row as "no", so a driver that forgot a row would
   get a panel refused (or accepted under a row nobody tested).
3. **An answer is written only over `pending`, at the address tested.** A
   panel withdrawn or re-submitted while its test ran keeps what it was
   given; one whose `apiBaseUrl` or `clientBaseUrl` was edited (billing's
   `PATCH`, which sends it back to `pending`) waits for a test of the new
   server (F-027-cc). Either way the late answer — verdict or fault — is
   counted `Stale` in the pass report and dropped.
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

## Registered once — the duplicate check (F-027-ce, ADR-0090 decision 1)

billing refuses a second row at the same normalised address (F-027-cd,
invariant 51); this catches the same panel under another one. It runs after
the answers validate, for a pull panel the questionnaire would take — a
refused one is not taken anyway, and a push panel is never called
(`register/duplicate.go`, `duplicate_test.go`).

6. **Our client on it names the panel.** A client of the new panel carrying a
   `claimTag` or `uuid` of another panel's config — any status, since a client
   left behind is still proof — makes it that panel's duplicate. No canary.
7. **A suspect gets a canary.** Otherwise every panel in service (pull,
   accepted, not archived) whose inbound set equals the new panel's — remote
   id and port, and protocol where `panel_inbound` has one — or whose IP (its
   `ipAddress`, or its host resolved) is one the new host resolves to, is a
   suspect. Through the **registered** panel a disabled client is created
   (random `canary-` tag and uuid, a 1-byte limit, an hour's expiry) and looked
   for on the new one. Seen = the same panel. It is deleted either way, on a
   context the test's own deadline cannot cut; a delete that fails is logged
   with the tag, for removal by hand. It runs whether or not the new panel has
   clients — a panel's own users are not ours and would hide the copy (widens
   ADR-0090's "no clients", at the cost of one disabled client on a suspect).
8. **Found = `refused`, naming the holder.** `duplicateOfPanelId` is written
   with the verdict, in the same guarded, announced statement as an answer
   (rule 3); CHECK `panel_duplicate_is_refused` keeps it on a refused panel
   only, and billing's address edit and restore clear it. Deleting the holder
   leaves the refusal without a name (`ON DELETE SET NULL`).
9. **A check that cannot run is no verdict.** A failed list, an unopenable
   suspect or a family that cannot create the canary leaves the panel
   `pending` with the fault and a detail naming the suspect — never accepted
   past the check, never refused for our failure. A DNS failure only removes
   a reason to suspect.

## Every result is announced, in the statement that writes it (F-027-bs)

Both writes are one statement: a `tested` CTE (the `UPDATE`, `RETURNING` the
row) feeding an `INSERT` into `automation.outbox_event`, type
`network.panel.tested` (`register.PanelTestedEvent`), aggregate
`network.panel`. The event and the state it announces commit or fail together
(ADR-0021) — never a Redis publish or a broker call after it (user,
2026-09-25).

- **A stale write announces nothing.** The `WHERE … 'pending'` that makes it
  `Stale` (rule 3) leaves the CTE empty, so no row is inserted.
- **The payload names whose page it is**: `{panelId, panelName, tenantId,
  ownerUserId, reviewState, fault}`, where `tenantId` is the panel's, or — a
  platform panel's being null (invariant 9) — the `platform_owner` tenant's,
  oldest first if tenant invariant 1 were ever broken, and `ownerUserId` is
  that tenant's owner, told a verdict in their inbox and bot (F-067-o). The
  consumer never resolves either.
- **A fault is announced on every retry**, every 5 minutes while it lasts: the
  page's "tested at" moves each time, so each is a change worth reading.
- The type is pinned to `contracts/realtime/events.json` from Go
  (`postgres_test.go`) and from TypeScript (`routing-keys.contract.spec.ts`).
  `automation/contract.outbox.md` has the consumer; `panel-web/contract.systems.md`
  the page.

## Only an accepted panel is collected

`collect.Panel.ReviewState` carries `panel.reviewState`, and `collect.Loop.Pass`
skips every panel that `ReviewState.Collectable()` does not open — neither
read nor converged, counted as `Unreviewed` rather than failed. Only
`accepted` and `accepted_low_trust` open it, and the empty state does not:
the guard **fails closed**, so a panel source that forgets the column
collects nothing instead of everything. A refused panel converged would be a
panel provisioned, which is exactly what refusing it was for (invariant 44).

**An archived panel is no panel** (F-027-bz, invariant 49). `retiredAt` set
takes it out of `panelsSQL` (collection and convergence), `pendingSQL` (the
connection test), `nasSQL` (the RADIUS allowlist) and the watchdog's count,
whatever its `reviewState`. Billing archives only a panel no group holds and
with no live config (`billing/contract.panel-lifecycle.md`), and the triggers
`config_panel_not_retired` / `panel_group_member_panel_not_retired` refuse a
config or a membership on it. A restore returns it `pending`, so it is tested
before it is collected again.

## The store, and the process that runs it (F-027-ax)

`register.PostgresStore` is `Store` over `network.panel`, through the
cross-tenant pool. Both writes carry `"reviewState" = 'pending'` and the two
addresses the test reached (null read as `""`) in their own `WHERE`, so rule 3
is held by the statement, not by a read before it; a write that touched no row
is `Stale`. `connectionTestDetail` is cut at 1000 bytes on
a rune boundary — a far end's error body is not ours to store whole.

`cmd/server` starts `register.Registrar` at boot and stops it first on
shutdown. It is the first loop this process runs: it needs only the panel row
and the vault route, so `TENANT_API_BASE_URL` and `SERVICE_AUTH_TOKEN` refuse
the boot when missing — without them every panel would be tested
`unopenable`.

## The Opener (F-027-aw)

`internal/opener` builds a driver from a pending panel. The vault is Node,
with a data key per tenant, and this service never holds the KEK (user,
2026-09-24): the login is read through `tenant-service`'s service-only
`POST /api/internal/vault/panel-credential/use` (`tenant/contract.vault.md`),
which re-derives the owner's vault from the row and logs the read. One crypto
implementation, every `use` audited where the others are.

1. **The family is checked before the login is read.** Each family in
   `contract.drivers.md`, `contract.xui.md` and `contract.hiddify.md` with a driver has a case. A family with no driver yet (`ErrNoDriver`) is
   `unopenable` and costs no vault read; it is ours to ship, so it is never
   `refused`. The Opener reads the **login** by name, never a push panel's
   RADIUS secret (F-027-az), which the driver has no use for.
2. **A login is typed `username:password`**, split at the first colon;
   Hiddify's is its API key alone (`contract.hiddify.md`). A
   login not in that form is `unopenable`, and no error quotes it — the
   error is what `connectionTestDetail` stores.
3. **A vault refusal names its reason** (`not_owner`,
   `credential_unavailable`, …) and never a value; the panel stays `pending`.
4. **`clientBaseUrl` rides along** (F-027-bg): `register.Pending` carries it
   and the Opener hands it to the families that serve links apart from their
   API — Hiddify and Marzneshin, today. One that is not an absolute url is `unopenable`.
   Pull only: CHECK `panel_client_base_url_is_pull_only`.
5. The Opener paces nothing: a connection test is one call. Pacing a
   collected panel by its `maxRequestsPerMinute` is `collect.PostgresSource`'s.
