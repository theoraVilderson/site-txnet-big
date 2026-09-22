---
id: network
layer: domain
status: draft
version: 7
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
strand bytes but cannot invent them. Nothing here reads a wallet, a rate or the
catalog.

It also never writes to a panel. `allocatedCeilingBytes` is where it stops;
`SetClientDataLimit`, `appliedCeilingBytes`, and the rewrite in the pass that
detects a counter reset are the convergence loop's (F-027-t).

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
today is F-027-t's, in the same pass that sees the reset. ADR-0072 names that
rewrite as the thing without which a reset button is a way around the decision.

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
