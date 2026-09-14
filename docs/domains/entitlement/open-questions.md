---
id: entitlement
layer: domain
updated: 2026-09-14
---

# Open questions — entitlement

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-14 | `resellerPath` (C-15) needs reseller nodes, which do not exist (F-901) | no | ASSUMED(2026-09-14): nullable, always null until F-901 | -> F-901 row |
| 2026-09-14 | Where a quota's `resetPolicy` lives — per Grant or per metric | no | ASSUMED(2026-09-14): per metric, inside the quotas JSON copied from the variant | -> contract.md at F-026-b |
| 2026-09-14 | Is a Grant issued without payment (`coupon`, `admin_grant`, `trial`) `active` at once, or `pending` first? | no | ASSUMED(2026-09-14): `active` at once; `pending` is for a purchase awaiting settlement | -> contract.md at F-026-e |
