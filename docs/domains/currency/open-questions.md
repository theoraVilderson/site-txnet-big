---
id: currency
layer: domain
updated: 2026-09-04
---

# Open questions — currency

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | No service, no seed. Which currency is base (IRR? IRT?) and what are its `decimalPlaces`? | resolved | **Answered 2026-09-09 by ADR-0019: USD with two decimal places.** The IRT/0-decimals assumption is withdrawn — a seed written against it would have been wrong in the money column, which is the one place this repo cannot correct quietly (C-02) | -> ADR-0019 |
| 2026-09-04 | `external_api` rate source — which provider, how often, who owns the fetch worker? | no | ASSUMED(2026-09-04): an `automation` worker, manual until then | -> automation unit |
| 2026-09-04 | Rounding rule on display conversion (banker's? floor? per-currency `decimalPlaces`)? | no | ASSUMED(2026-09-04): round half-up to `decimalPlaces` | -> rules.md |
