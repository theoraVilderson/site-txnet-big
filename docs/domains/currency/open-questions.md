---
id: currency
layer: domain
updated: 2026-09-12
---

# Open questions — currency

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | No service, no seed. Which currency is base (IRR? IRT?) and what are its `decimalPlaces`? | resolved | **Answered 2026-09-09 by ADR-0019: USD with two decimal places.** The IRT/0-decimals assumption is withdrawn — a seed written against it would have been wrong in the money column, which is the one place this repo cannot correct quietly (C-02) | -> ADR-0019 |
| 2026-09-04 | `external_api` rate source — which provider, how often, who owns the fetch worker? | resolved | **Answered 2026-09-12 by D-22 and F-0603.** Four domestic public USDT/IRT order books, every five minutes, the `fx_rate_refresh` job in `worker-service`. The poll step and the median are built (F-0603, F-0604); the rate is not published until F-0606 | -> contract.fx-worker.md |
| 2026-09-12 | **Which node does the FX worker run on?** D-22: the four sources are only reachable during a national-internet shutdown if the process is inside Iran — a node abroad loses every one of them at exactly the moment the rate matters most | no | ASSUMED(2026-09-12): wherever `worker-service` is deployed today, which is not chosen for this. It is `automation`'s decision, not this unit's. F-0603 records a per-source latency in every run so the choice has evidence rather than an argument | -> `automation`, before F-0606 caches a rate anything is priced from |
| 2026-09-12 | **What are the edges of F-0604's hard sanity band, and is `minSources` 2 enough?** The band has to reject a value that cannot be a price without ever rejecting a real move, and the catalog gives no numbers for it | no | ASSUMED(2026-09-12): `FX_SANITY_MIN_RIAL=100000` / `FX_SANITY_MAX_RIAL=10000000` — a factor of ten either side of where this market has been — and `minSources=2`, the catalog's default. Two is the minimum that produces a rate at all, not enough to outvote an outlier; three is. Every reading and every discard is in the run log, so both are tightened against evidence rather than argued | -> the change that turns on a third source, and F-0605 |
| 2026-09-12 | The `wallex` and `bitpin` endpoints are this repo's guess; D-22 names the exchanges but only states Nobitex's and Tabdeal's URLs in full | no | ASSUMED(2026-09-12): both are implemented and left out of the `FX_SOURCES` default. A source that can only fail is a permanently red line in the run log. Turn each on in the change that watches it answer | -> the change that verifies them |
| 2026-09-04 | Rounding rule on display conversion (banker's? floor? per-currency `decimalPlaces`)? | no | ASSUMED(2026-09-04): round half-up to `decimalPlaces` | -> rules.md |
