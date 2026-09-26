---
id: network
layer: domain
status: draft
version: 14
updated: 2026-09-26
---

# Drift — which remote client is which config, and what the panel did to it

What governs matching a panel's clients to our configs and the verdict written
to `config.driftState` (F-027-aa). Read it before changing how a client is
found, before writing `remoteId` or `driftState` from anywhere, and before
adding a panel family — the second key only works where the family stores it.
Containment — the anti-flap stop, the ceiling exception and the panel-wide
event — is F-027-ab's, and is the second half of this file.

## The three keys (`converge.MatchClients`, `internal/converge/drift.go`)

A config is matched to a client over the one `ListClients` the pass read, by
three keys in order. Each key reaches only the clients the keys before it left
unclaimed, so **no client is ever two configs'** (invariant 41).

| key | what it is | what changes it |
|---|---|---|
| `remoteId` | the panel's own id | a rename |
| `claimTag` | ours: `txn-` + 32 hex, written by `ConfigActionsService.provision`, stored in the client's label (`RowClientLabelStorable`) | nothing we do; a client made again by hand loses it |
| `uuid` | the credential the user carries | a regenerate — ours, and the pass carries it |

`claimTag` is **required on every config** (NOT NULL + `@unique`, invariant
17): a key some rows lack is a key the match cannot rely on. It is random, not
derived from the `uuid`, because a regenerate rotates the credential and the
tag has to survive it; a move is a new row and a new tag.

Every row is matched, present and absent alike — a deleted config's client
renamed away from us still holds a seat, and the delete follows it.

## The verdicts

| verdict | found how | the pass |
|---|---|---|
| `synced` | by `remoteId`, or a row with no `remoteId` adopting its lost create | carries desired state as `contract.provisioning.md` says |
| `renamed` | by tag, under another id | re-keys `remoteId` to it; nothing written to the panel |
| `rebuilt` | by `uuid` only, under another id | re-keys, and writes the tag and a create's first block back (`restored`) |
| `missing` | by no key, row present with a `remoteId` | recreated under the same tag and credential, ceiling first — a **repair** |
| `reset` | the ceiling pass saw the counter go backward this pass | the ceiling is already rewritten (`contract.ceiling.md`) |
| `limit_overridden` | the panel's ceiling is neither ours nor the one it last confirmed | the ceiling is already rewritten |
| `orphan` | a client no config claims by any key | nothing: reported in `ProvisionReport.Orphans` |
| `contested` | a repair was due and the anti-flap stop held it | nothing but the exception, below |

An identity verdict outranks the ceiling's: a client just re-keyed has its
ceiling written under its new name for the first time, and that is not
somebody else's number. **A verdict is what the last read found, never a
history** — a re-keyed row reads `synced` on the next pass; the finding
(`rekeyed`, `restored`) and the log line record that it happened. Only a
verdict that differs from the row's is written (`Desired.RecordDrift`).

**Why `rebuilt` gets its ceiling in the same pass.** A client made again by
hand has no limit, and the ceiling pass reads the allocation's `remoteId`,
which moves only with this write. Leaving it for the next pass is an interval
of unmetered traffic. The block is sized as a create's — the allocation less
what the config already served — which is too tight, never too loose, if the
counter in fact survived.

**`limit_overridden` against a top-up.** A top-up raises the allocation, and
the panel still holds the figure it last confirmed: ours, and stale. So the
ceiling pass blames somebody else only when the panel's figure differs from
`appliedCeilingBytes` too (`Allocation.AppliedBytes`, `Finding.Overridden`).
No confirmed figure, no blame. An unlimited config holds no ceiling at all
(F-111-r), so its client's no limit is never judged: only identity drift is.

**`orphan` is a client's verdict, not a config's.** No row carries it. The
client is left alone whatever the panel's `orphanPolicy` says: `report_only`
is the only policy this pass executes, and its bytes are already
`unattributed_usage` (collection). `adopt` and `delete_remote` are
`open-questions.md`.

## What the collector sees

`collect.Panel.Configs` is read off `config.remoteId`. A renamed client's
reading is unattributed in the pass that finds it, re-keyed by convergence at
the end of that pass, and claimed from the next one — where the collector
adopts its counter as a new baseline. The bytes between the last read under
the old name and that baseline are `unattributed_usage`, never dropped and
never billed twice. Carrying the old cursor across a rename is not built.

## Containment (F-027-ab)

### The anti-flap stop

A **repair** is undoing somebody else's change on the panel: recreating a
`missing` client (`recreated`), writing a `rebuilt` client's tag back
(`restored`), or raising a ceiling somebody else lowered (`below_allocation`
with `Finding.Overridden`). A re-key writes nothing and is not one; neither is
our own write — a regenerate, an enable, a top-up.

Only repairs **within 24 hours of the one before** count
(`converge.RepairWindow`, `config.driftRepairedAt`; user, 2026-09-23). Two
of them (`MaxRepairs`) and the next is held: nothing written, the row reads
`contested`, and `ActionContested` / `ReasonContested` is the finding. A
repair once the window has run starts the count at one — a repair six months
on is a new dispute, and a count for ever would turn every config `contested`
given enough years. The budget is read once per pass off the row, so a pass
counts one repair per config at most, and both passes hold together
(`ProvisionReport.Stopped`).

### The one exception

A ceiling that allows **more** than ours — higher, or none at all — is a money
hole, not a dispute (ADR-0072 rule 2). It is rewritten whatever the count
says, and **not counted**. The stop therefore only ever holds a *raise* of a
finite ceiling: every reset rewrite and every exhausted allowance is a
lowering and goes out. A contested `rebuilt` client is still re-keyed and
still gets a ceiling if it has none, but not its tag; its next rename reads
`rebuilt` again. A raise is held only when it is somebody else's — overridden
now, or the row already `contested` — so our own top-up over our own stale
figure is never held.

### The panel-wide event

One counter going backward is a reset, and its post-reset figure is billed. A
backup restore is every counter doing it at once, each individually
plausible, and billing them charges the restored figures a second time. So
`collect.Containment` judges each normalised pass **before it publishes**:
more than 20% of the cumulative counters read (`DefaultMassResetPercent`)
and at least five (`DefaultMassResetFloor`) going backward is `mass_reset`.
Then:

- the event is raised first (`panel_drift_event`, both counts, halting); if
  that write fails nothing is published and the next pass judges again;
- every post-reset delta of the pass is quarantined as `panel_drift_event`
  and taken out of the lifetime the cursor holds — the cursors still move, so
  the restored figures are the new baseline and not judged again;
- the pass converges as usual, so every ceiling is restated over the restored
  counter in the same pass.

While an unacknowledged event halts the panel, both loops skip its read and
report it `OpHalted` (it is never stamped, so the watchdog ages it into an
alert). The bulk pass **still converges it**: a suspension or a delete must
reach the panel whatever its counters say — except under a `foreign_claim`,
below (`DriftEventType.Converges`; `Halted` answers that type first). Acknowledging is `billing-service`'s
`POST /systems/drift-events/:id/acknowledge` (F-027-as,
`billing/contract.systems.md`), which sets `acknowledgedAt` once. `mass_missing`, `mass_rename` and `mass_limit_override` are schema
only; nothing raises them.

### Another panel's clients — the collector guard (F-027-cf, ADR-0090 decision 1)

The connection test proves a panel is not one already registered
(`contract.registration.md` rules 6–9), but only when it runs: an address
re-pointed in DNS after acceptance is never tested again. Such a panel answers
with another server's clients, and a pass over it would bill their bytes as
unattributed and recreate our own configs there as `missing`.

- **Found how.** The convergence pass's orphans — and only they: a client this
  panel's configs claim is ours — are looked up by `claimTag` and `uuid` among
  every other panel's configs, retired ones too (`Claims.Holder`,
  `converge/foreign.go`). Tags and uuids are global and a move takes fresh
  ones (invariant 17), so a match is proof. No orphans, no query.
- **Then, before any write.** A halting `foreign_claim` event is raised:
  `panelId` the panel read, `foreignPanelId` the one holding most of the
  matched configs, `affected` the clients matched (never above the orphans),
  `observed` every client listed; an ERROR line names both. The pass writes
  no client, ceiling or verdict (`ErrForeignClaim`). An event that could not
  be written leaves nothing written either, and the next pass looks again.
- **While open, the panel is neither read nor converged**, by either loop:
  converging would recreate our configs on a server that is not theirs.
  The bytes the detecting pass read are already published, as unattributed
  (no config matches another server's clients).
- **Acknowledging resumes it**, the same route as a restore. An address left
  pointing at the other server raises it again on the next pass — which is
  the point; the admin puts the address right first.

## Proof

`internal/converge/drift_test.go`, through the collection loop so the re-key
feeds the next pass's attribution: rename, rebuild, missing, orphan, a
deleted config following its renamed client, reset, an override, and a top-up
that is not one. `config-actions.spec.ts` asserts the tag's shape, that a
regenerate keeps it and that a move gets a new one.
`internal/converge/containment_test.go`, through the loop: a recreate is a
repair; the third inside the window is held `contested` and the window
running out starts the count again; a higher ceiling is rewritten on a
contested config; a restore halts, charges nothing, restates the ceiling and
resumes on acknowledgement; 20% exactly, and four of four, do not fire.
`internal/converge/foreign_test.go`, through the loop: another panel's client
by tag, and by uuid alone, stops the panel before the missing config is
recreated, names both, and neither reads nor converges it until acknowledged;
a stranger no config anywhere claims is only an orphan.
