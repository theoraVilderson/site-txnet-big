---
id: engagement
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — engagement

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | No service. Is the wheel per-tenant configurable, or platform-only for v1? | no | ASSUMED(2026-09-04): platform-only (`tenantId = null`) for v1 | -> rules.md |
| 2026-09-04 | Nightly reset of `currentDayAwardedCount` / daily cap — which `automation` worker, what timezone boundary? | no | ASSUMED(2026-09-04): a midnight `Asia/Tehran` job in `automation` | -> automation unit |
| 2026-09-04 | `requiresActiveServiceAtSpinTime` needs a `network`/`billing` lookup. Sync call at spin time? | no | ASSUMED(2026-09-04): yes, synchronous eligibility gather | -> rules.md |
