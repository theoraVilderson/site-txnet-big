---
id: network
layer: domain
status: draft
version: 8
updated: 2026-09-22
---

# The ceiling — one bag, split across the configs that draw on it

What governs `CeilingAllocatorService` (ADR-0072 rule 1, F-027-s): the only
code that decides how much of a Grant's purchased bytes each of its configs may
carry. Read it before changing how a share is sized, before adding a second
writer of `config.allocatedCeilingBytes`, or before giving a config a ceiling
from anywhere else.

**`Σ ceilings ≤ purchasedBytes`, across every config of a Grant, always**
(entitlement invariant 8). One bag spread over five panels needs one ceiling
split five ways; five full ceilings would serve five times what was bought, and
each one would look correct on the panel it sits on. That is why the split is
proved by a property test over generated Grants and not by three cases.

## The call

In-process only, inside `billing-service`. `rebalance(tx, input)` runs in the
caller's transaction — the hot loop's, which buys the next block and rebalances
in one (F-027-u) — and `rebalanceForGrant(input)` opens one for a caller with
nothing else to commit. Either way the transaction comes from
`tenantTransaction`, because the purchase it commits beside writes a registered
model (`tenant-context/contract.md` rule 5).

| in | |
|---|---|
| `grantId` | the Grant whose bag is being split |
| `hotConfigId` | the config the hot loop says is consuming. First in line for everything left; null on a bulk pass |
| `floorBytes` | headroom every other config keeps. Defaults to `DEFAULT_CONFIG_FLOOR_BYTES` (100 MiB) |

| out | |
|---|---|
| `ceilings` | one row per config in the split — `ceilingBytes` and whether a sub-account was the smaller authority — in the order they were decided, hot first |
| `unallocatedBytes` | bought, and no config can carry it: every one is capped. F-027-u's signal to stop buying |
| `written` | how many shares actually moved — the convergence loop's remaining work |

## It decides; it never buys

`BlockPurchaseService` advances `purchasedBytes` and this hands out what that
bought. The bound and the split move in one direction only, so a bug here can
strand bytes but cannot invent them. Nothing here reads the catalog, and the
wallet and the Grant's rate are read for one figure only, below.

**It also writes the shutdown figure** (F-027-w, ADR-0078):
`walletBackedCeilingBytes` is the same split, same order, over a bag of
`purchasedBytes + bytesAffordable(rate, balance)` — zero added for a prepaid
Grant. It is taken as the larger of it and the allocation, so the CHECK
`config_wallet_backed_ceiling_extends` never refuses a rebalance, and a row is
written when **either** column moved: a top-up moves the wallet while
`purchasedBytes` stands still. Out: `walletBacked` and `walletBackedBytes`,
beside `ceilings`. What the collector does with it is
[contract.resilience.md](contract.resilience.md).

It never writes to a panel. These two columns are where it stops;
`SetClientDataLimit`, `appliedCeilingBytes`, and the rewrite in the pass that
detects a counter reset are the convergence loop's, below.

## Three passes, in one order

The configs are ordered once — the hot config, then the heaviest, then by id,
so the same input gives the same allocation whatever order the rows arrived —
and raised towards three targets in turn, each pass handing out only what is
left:

1. **what it has already served.** A ceiling under that is a byte already
   carried with no ceiling covering it — the guarantee failing after the fact
   rather than a byte saved.
2. **the floor above it**, so no config is starved to zero headroom while
   another one runs. A user's phone still connects while their desktop pulls.
3. **everything left**, hot config first. That is the concentration: the config
   actually consuming gets the bag, and the others keep their floor.

`Σ ceilings ≤ purchasedBytes` therefore holds **by construction** and not by a
check at the end — no pass can hand out what no pass has left.

A bag too small for pass 1 is an overrun, not a bug: a panel whose limit was
overridden reports past its ceiling (ADR-0074), and the holds queue settles the
gap. The ceilings stop at the bag, in the order above, and the panels cut the
rest off by themselves.

## Lifetime bytes, not the panel's counter

A share is counted in **lifetime bytes for that config** — what it has carried
since it existed, across resets (`ConfigCounterState.lifetimeUpBytes +
lifetimeDownBytes`), which is the basis `purchasedBytes` is counted on. A
config with no counter row has served nothing.

The panel's own counter is a different number: it starts at zero after a backup
restore, and turning a lifetime allowance into the figure that counter needs
today is the convergence loop's, in the same pass that sees the reset. ADR-0072
names that rewrite as the thing without which a reset button is a way around
the decision.

## The smaller cap wins

A config carrying an **active** `billing.SubAccount` is capped by its
`dataCapBytes` (F-608), and where the two disagree the sub-account is the
smaller authority: the share is cut to the cap. That is applied inside every
pass rather than over the result, so the bytes a cap refuses stay in the bag for
the next config instead of being stranded on one that cannot carry them.

A **deactivated** sub-account is not a cap of zero — it is no cap at all, and
the config draws on the bag like any other.

## Who is in the split

Only configs that can carry traffic: `status = active` with
`desiredEnabled = true`. A disabled or purged config holding a share would be
bytes the bag has spent that no panel can serve, and the user would read it as
a bag emptying while they are offline.

## The convergence loop — carrying the number to the panel (F-027-t)

`network-service/internal/converge` is the other half: the allocator's number
is ours until a panel is enforcing it, and the panel is the enforcement point
that keeps working while this service is down. It runs at the end of each
panel's turn in the collection pass (`collect.PassConverger`), costs **one**
`ListClients` for the whole population, and writes `SetClientDataLimit` only to
the configs that disagree.

**`applied` is what the panel confirmed, never what we sent.** Families take a
ceiling late, so a write that returned `nil` is not a ceiling being enforced,
and a believed ceiling is worse than a missing one — the traffic past it is
served with nothing red anywhere. `appliedCeilingBytes` is therefore read back
off `ListClients` and set with `ceilingAppliedAt` in the same write
(invariant 14). A panel reporting **zero** confirms nothing: zero read means
*no limit* there, so it is never recorded as an applied ceiling.

### From a lifetime allowance to the figure that counter needs today

An allocation is counted in lifetime bytes; a panel enforces against its own
counter, which a restore or an operator can zero. So the panel figure is

```
offset  = max(0, lifetime bytes served - what the counter reads now)
ceiling = max(0, allocatedCeilingBytes - offset)
```

and "what the counter reads now" is the raw figure under `cumulative`, and zero
under `reset_on_read` (the read spent it) and `session` (the panel counts per
session, so there is nothing to subtract) — the conservative reading in both.

**The translation only ever lowers** — that is what the two `max`es are for,
and it is why `Σ ceilings ≤ purchasedBytes` survives it. Bytes the far end's
counter holds that we never billed — a baseline adopted when we started
watching, a figure the plausibility cap quarantined — get **no** headroom.
Covering them would serve traffic against nobody's purchase; refusing to is a
user who stalls, which is ADR-0072's accepted worst failure in every direction.

### What a write says about itself

Every write is a `Finding` with a reason, because each is a different thing to
do about it: `counter_reset` (this pass saw the counter go backward, which is
the reason the loop exists), `above_allocation` (ADR-0072 rule 2 — a money
hole, overwritten immediately and past the anti-flap stop when F-027-ab lands),
`below_allocation` (their number only shortens the user's service: rewritten,
and reported rather than treated as an emergency), `no_limit_on_panel`,
`allowance_exhausted` and `write_refused`.

The reset is read off the cursor's own reset mark and not off the delta stream:
a counter zeroed between two reads publishes **no delta at all** — the
post-reset figure can be zero — and that is exactly the case the rewrite exists
for.

`allowance_exhausted` is a ceiling of zero, and it is rewritten every pass
rather than converged, because a panel cannot confirm zero back. Cutting the
user off for real is the Grant suspension (F-027-x) and `desiredEnabled`
(F-027-z), not this number.

### What it will not do

It writes one number and reads it back. Sizing a share is the allocator's,
creating or enabling a client is F-027-z's, deciding which config a remote
client belongs to is F-027-aa's, and the anti-flap stop that bounds repair
attempts is F-027-ab's. A config whose `remoteId` names no client on the panel
is skipped here and gets its verdict there.
