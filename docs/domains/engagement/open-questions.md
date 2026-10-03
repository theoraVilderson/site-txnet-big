---
id: engagement
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — engagement

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | No service. Is the wheel per-tenant configurable, or platform-only for v1? | no | RESOLVED(2026-10-03, ADR-0111): per tenant; `tenantId` not null | -> contract.md |
| 2026-09-04 | Nightly reset of `currentDayAwardedCount` / daily cap — which `automation` worker, what timezone boundary? | no | RESOLVED(2026-10-03, ADR-0111 point 4): no reset — a counter row per tenant day (TZ-1) | -> data-model.md |
| 2026-09-04 | `requiresActiveServiceAtSpinTime` needs a `network`/`billing` lookup. Sync call at spin time? | no | ASSUMED(2026-09-04): yes, synchronous eligibility gather | -> rules.md |
