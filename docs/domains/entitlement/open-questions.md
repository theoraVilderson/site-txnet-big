---
id: entitlement
layer: domain
updated: 2026-09-29
---

# Open questions — entitlement

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-14 | `resellerPath` (C-15) needs reseller nodes, which do not exist (F-901) | no | ASSUMED(2026-09-14): nullable, always null until F-901 | -> F-901 row |
| 2026-09-14 | Where a quota's `resetPolicy` lives — per Grant or per metric | no | ASSUMED(2026-09-14): per metric, inside the quotas JSON copied from the variant | -> contract.md at F-026-b |
| 2026-09-14 | Is a Grant issued without payment (`coupon`, `admin_grant`, `trial`) `active` at once, or `pending` first? | no | ASSUMED(2026-09-14): `active` at once; `pending` is for a purchase awaiting settlement | -> contract.md at F-026-e |
| 2026-09-23 | ~~`reviveOnTopUp` (F-027-y) has no caller.~~ **Answered 2026-09-23 (user): the wallet credit, in the same transaction — ADR-0079, built as F-027-ap.** The hot loop's channel stays open on its own (`network/open-questions.md`); it was not the blocker this looked like. | no | ANSWERED(2026-09-23): revive at the credit, guarded by `walletCanBuy` | -> ADR-0079, F-027-ap |
| 2026-09-29 | An unlimited package plan (`trafficUnlimited`) a reseller sells on a group holding a platform panel has no bag, so F-118-p charges it nothing wholesale. Refuse it, price it per GiB served, or price it flat? | resolved | **Answered 2026-09-29 by the user (D-59 (c))**: a flat wholesale amount per period, priced on the package — F-118-z, F-118-aa | -> [contract.package-wholesale.md](contract.package-wholesale.md) (F-118-z) |
