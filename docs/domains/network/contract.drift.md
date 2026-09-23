---
id: network
layer: domain
status: draft
version: 13
updated: 2026-09-23
---

# Drift — which remote client is which config, and what the panel did to it

What governs matching a panel's clients to our configs and the verdict written
to `config.driftState` (F-027-aa). Read it before changing how a client is
found, before writing `remoteId` or `driftState` from anywhere, and before
adding a panel family — the second key only works where the family stores it.
Containment — the anti-flap stop, the panel-wide event, recreating a
`missing` client — is F-027-ab's, and lands here.

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
| `missing` | by no key, row present with a `remoteId` | nothing: **never recreated blind** — a recreate is a repair (F-027-ab) |
| `reset` | the ceiling pass saw the counter go backward this pass | the ceiling is already rewritten (`contract.ceiling.md`) |
| `limit_overridden` | the panel's ceiling is neither ours nor the one it last confirmed | the ceiling is already rewritten |
| `orphan` | a client no config claims by any key | nothing: reported in `ProvisionReport.Orphans` |

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
No confirmed figure, no blame.

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

## Proof

`internal/converge/drift_test.go`, through the collection loop so the re-key
feeds the next pass's attribution: rename, rebuild, missing, orphan, a
deleted config following its renamed client, reset, an override, and a top-up
that is not one. `config-actions.spec.ts` asserts the tag's shape, that a
regenerate keeps it and that a move gets a new one.
