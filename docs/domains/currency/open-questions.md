---
id: currency
layer: domain
updated: 2026-09-04
---

# Open questions — currency

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | No service, no seed. Which currency is base (IRR? IRT?) and what are its `decimalPlaces`? | yes (money) | ASSUMED(2026-09-04): IRT, 0 decimals | -> ADR + seed |
| 2026-09-04 | `external_api` rate source — which provider, how often, who owns the fetch worker? | no | ASSUMED(2026-09-04): an `automation` worker, manual until then | -> automation unit |
| 2026-09-04 | Rounding rule on display conversion (banker's? floor? per-currency `decimalPlaces`)? | no | ASSUMED(2026-09-04): round half-up to `decimalPlaces` | -> rules.md |
