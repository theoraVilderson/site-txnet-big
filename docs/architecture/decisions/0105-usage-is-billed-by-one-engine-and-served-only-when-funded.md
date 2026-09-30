---
id: adr-0105
status: accepted
updated: 2026-09-29
---

# ADR 0105 — usage is billed by one engine, and served only when it is funded

- **Status:** accepted (design; nothing built yet — series F-118)
- **Date:** 2026-09-29 (user, D-58)
- **Affects units:** billing, entitlement, catalog, network, tenant, panel-web
- **Amends:** ADR-0072 (its rule, for every meter; postpaid is held money),
  ADR-0073 (the rate moves to a rate card and `grant_meter`), ADR-0078 (the
  shutdown figure becomes held money), D-41 (only when F-118-n is built).
  Not ADR-0094 or ADR-0096: the planner keeps reading `purchasedBytes`
- **Spec:** `spec.py --section 8.5`, `--section 5.4`, `--section 14.5`, F-608

## Context

Pay-as-you-go exists for one thing: VPN bytes. A variant carries a per-GiB
rate (`metered_rate`), the Grant locks it (ADR-0073), blocks are bought from
the wallet before they are served (ADR-0072), and the panel's own limit cuts
the user off. All of it is written on the Grant's byte columns
(`consumedBytes`, `purchasedBytes`, `billedBytes`, `meteredRate`), so a second
metered product — SMS, AI tokens, an extra device, any per-use capability —
has nowhere to go.

The user asked (2026-09-29) for consumable products in general: per unit
(per GB) or per use of a capability, each capability set by its seller to
**prepaid or postpaid**, and **the wallet never negative**. Resellers must be
able to sell them too, and it must carry products other than VPN.

Two things in the current design stop that:

1. **The VPN reserve is unlocked money.** `network/contract.reserve.md` sizes
   the headroom past a Grant's bag from what the balance *would* buy, and
   accepts that an overrun inside one reaction window is not charged. That is
   bounded while VPN is the wallet's only consumer. A second meter, or a
   product purchase, spends the same balance the panels were promised, and
   the service is then served unfunded — the loss ADR-0072 exists to prevent.
2. **Postpaid, read literally, is debt.** Charging after the use and cutting
   at zero leaves the collection gap ADR-0072 measured (up to several GB), and
   §5.4 / D-05 forbid a negative balance or any credit.

`billing.sub_account` (a byte pocket on one config) has 0 rows and no writer.

## Decision

0. **A package Grant is untouched** (user, 2026-09-29). A plan paid in full
   at purchase — 50 GB for 30 days, priced by `Price`, its bytes in
   `quotas.traffic_bytes` and `purchasedBytes` — keeps its whole path: no
   meter, no rate card, no hold, no wallet read after the sale, closed by the
   planner at its quota (ADR-0096), renewed as today. Nothing below applies
   to it unless a seller builds a **new** variant with `afterIncluded:
   metered`. A user with no metered service has `heldAmount = 0`, so every
   debit behaves exactly as before. Every F-118 row proves this with the
   package plan's existing suites (issue, purchase, close, renewal) green.
   *Amended 2026-09-29 (user, F-118-p):* the **user's** path stays exactly
   this; the **reseller's** is added. A plan a reseller sells on a group
   holding a platform panel buys its bag at the package's `vpn.traffic` rate
   on the reseller's billing wallet — at the sale and at every raise
   (renewal, an admin's raise or reset) — or is refused
   (`wholesale_unfunded`, `wholesale_rate_missing`); what no platform panel
   served comes back at close. Its own row, `grant_wholesale`, not a
   `grant_meter`: a plan still has no meter. Leaving those bytes free was
   rejected: the platform served them at its cost.
1. **One rule for every meter** (ADR-0072, generalised): no unit is served
   unless its money is already **debited** (prepaid) or **held** (postpaid).
   The wallet never goes negative, and that is a database constraint (§5.4).
2. **A meter is a catalog row**: what is counted — `key` (immutable), `unit`
   (`bytes | count | seconds | tokens`), the service that reports it, a
   translated name. Platform rows only, shaped like `product_capability`
   (ADR-0086): a meter exists only where code reports it. Seeded with
   `vpn.traffic`.
3. **A rate card prices a meter on a variant**, append-only like `Price`, in
   the tenant's operating currency (ADR-0098): `unitSize`, `unitPrice
   Decimal(18,8)`, `mode prepaid | postpaid`, `includedQuantity`,
   `afterIncluded stop | metered`. The seller sets the mode per meter. This
   also sells a hybrid plan: 50 GB with the plan, then per GB. `metered_rate`
   becomes the `vpn.traffic` prepaid card.
4. **The card is locked on the Grant at issue** as a `grant_meter` row (rate,
   mode, included, `consumed`, the `billed` cursor, `funded`) — ADR-0073 for
   every meter. A catalog change never reprices a sold Grant.
   *Amended 2026-09-29 (user, F-118-l):* a tenant's currency change converts
   an open Grant's meters — the price moves with its currency, the one change
   `grant_meter_terms_are_locked` allows, because the same price in another
   money is not a reprice. Refused instead, a converted wallet could not pay
   an unconverted meter; converted at each debit instead, every money path
   would carry the conversion and a refund could price off a different rate
   than the block (ADR-0073).
5. **Usage arrives as idempotent events** (`usage_event`, unique key) that
   advance `consumed`. Rating reads `consumed − billed`, so double billing is
   impossible (§8.5). The ledger gets whole minor units only (C-02), rounded
   in the buyer's favour; the cursor advances only by what the charged amount
   covers.
   *Amended 2026-09-30 (user, F-118-al):* a closed Grant's last postpaid
   capture rounds **up**. Forgiving the dust let a Grant with no start price
   be opened, used to just under a cent, closed and opened again for free.
   At most one cent, once per Grant, from the hold; as a prepaid remainder
   already keeps its dust. A suspension or freeze still rounds down and carries.
6. **A wallet hold is locked money, not a ledger row.** `wallet_hold` rows and
   `wallet.heldAmount`, written only together, with `CHECK (cachedBalance −
   heldAmount >= 0)`: no debit path — a purchase, a transfer, a block — can
   spend held money, whether or not its code knows holds exist. A **capture**
   is one ledger debit and the hold reduced, in one transaction; a
   **release** reduces the hold.
   - **Prepaid** is unchanged: blocks debited before they are served, the
     remainder credited back at close (ADR-0072 rule 3).
   - **Postpaid** keeps a hold on the Grant topped up to a target (a horizon
     of its rate, like a block), captures the measured usage periodically, at
     close and before each re-top, and releases the rest at close. A short
     balance holds less, not nothing; under one minor unit is refused.
7. **Each product family has an enforcer that refuses unfunded work.** VPN:
   the panel ceiling, set from `funded` (the bag, or the held bytes). Any
   other meter: an internal door — `authorize(grant, meter, quantity, key)`
   debits or holds before the work and returns a token; `commit` rates the
   actual; `cancel` or its expiry releases. A meter whose use cannot be
   refused before it happens cannot be sold under this ADR.
8. **The VPN reserve becomes a hold.** The planner's wallet share
   (`contract.reserve.md` rule 5) is money held for the owner's metered
   Grants, so nothing else can spend it and what a config serves up to its
   ceiling is captured. The shutdown figure (ADR-0078) is held money too.
   *Amended 2026-09-29 (user, F-118-b):* the hold is a **fixed size per
   Grant**, `VPN_RESERVE_BYTES` (default 1 GiB) at its rate, clamped to the
   free balance — not the whole balance, which would refuse every purchase
   while a metered Grant runs. One hold per Grant replaces the even split of
   the balance; its own next block spends it. Cost: less headroom for a Grant
   with many inbounds, tuned by the setting.
9. **The sub-account is a spending cap on one product** (user, 2026-09-29).
   The owner sets it on a Grant for someone — family, a friend, a colleague —
   with a label, a cap in the wallet's currency and `period none | monthly`.
   The Grant is funded to `min(what the wallet backs, cap − spent)`, and the
   product is cut at whichever is reached first; the owner's other products
   are untouched. The holder needs no account of their own. The cap bounds
   usage charges; the plan's own price is paid at purchase. It replaces
   `billing.sub_account`, and reaches the planner through Quota, not per
   config (answers `network/open-questions.md` 2026-09-27).
10. **A charge names its payer** (user: resellers sell it, and the design has
    two layers). Today the payer is the Grant owner's wallet: a reseller sells
    metered variants on platform meters with its own cards, mode and
    currency. Later (F-118-n), one usage event on a platform-owned panel is
    rated a second time against the platform's card, held or debited on the
    reseller's `tenant_billing_wallet` — prepaid, per §14.5.
    *Amended 2026-09-29 (user, F-118-n6):* on VPN the reseller pays wholesale
    only for bytes served on **platform-owned** panels; a reseller's group may
    mix its own panels with the platform's, and bytes on its own cost the
    platform nothing. Those bytes are counted apart at metering, so the
    wholesale cursor means the same thing from its first block. Charging
    every byte of a Grant that touches a platform panel was rejected: it bills
    the reseller for its own panels, and correcting it later would migrate
    the cursor on open Grants.
    *Amended 2026-09-29 (user, F-118-n3):* a VPN block buys wholesale for the
    headroom it leaves only while the Grant's group holds a platform panel;
    bytes already served on one are owed on every block. A reseller at zero
    therefore stops its users on groups with a platform panel and no others.
    Prepaying every block was rejected: it cuts users the platform serves nothing.
11. **Ledger reasons** `usage_charge` (a debit and a sale, `IS_SALE`) and
    `usage_refund` (a credit that undoes one). `traffic_consumption` and
    `traffic_refund` stay for the rows already written.
12. **VPN moves in stages** (user): holds (F-118-a) → the reserve on holds
    (F-118-b) → meter, card, `grant_meter` (F-118-c..e) → VPN postpaid
    (F-118-k) → the metered-only columns (`meteredRate`, `billedBytes`)
    retired into `grant_meter` (F-118-l). `purchasedBytes` stays the bag the
    planner reads for every Grant, so a package plan's path never moves.
    Each stage is proven by the suites already covering it before the next
    starts. There is one money engine at the end.

## Consequences

- Positive: a new metered product is a meter row, a reporter and an enforcer.
  Rounding, currency, holds, caps and revenue are written once.
- Positive: postpaid with no debt and no leak; a user pays for measured usage
  only, and the unused hold is released.
- Positive: the reserve's overrun (`contract.reserve.md` "What it costs")
  closes, and several meters on one wallet cannot promise the same money.
- Negative / accepted: every debit path gains a refusal for money that is
  held. The panel and the bot must show available and held separately.
- Negative / accepted: a postpaid user needs free balance to start, and money
  sits held while a service runs.
- Negative / accepted: two vocabularies of ledger reasons (`traffic_*` and
  `usage_*`). The byte columns' half closed with F-118-l: a metered Grant's
  rate and money cursor are its `grant_meter`'s.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Postpaid as "charge after use, cut at zero" | the collection gap is never zero (ADR-0072); the user refused any loss on 2026-09-21 |
| A separate wallet per sub-account | breaks one wallet (§5.4); money strands in pockets, and each needs its own refund, currency and closure rules |
| Leave VPN on its own engine, new meters on a new one | every money rule is then written twice and drifts |
| Keep the reserve computed from the balance | promises the same money to every consumer of the wallet |
| Tenant-created meters now | nothing would report them; revisit when a tenant reports usage through an API |

## Revisit trigger

- A tenant needs a meter the platform does not report.
- A product whose use cannot be refused before it happens.
- Hold sizes that measurably keep users from starting a postpaid service.
