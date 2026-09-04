---
id: fraud
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — fraud

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A `fraud_flag` is advisory: only `severity = critical` may carry an automatic hard action; everything else is `require_manual_review` or a soft action (`freeze_config`, `block_transfer`, `hold_coupon`) | planned service layer / schema | see contract | 
| 2 | Flags are never deleted; they are resolved (`resolvedAt`, `resolvedByAdminId`) | planned service layer / schema | see contract | 
| 3 | `subjectType` + `subjectId` together identify the flagged entity — code must switch on `subjectType` | planned service layer / schema | see contract | 
| 4 | Scanners only *create* flags; they never ban a user | planned service layer / schema | see contract | 

## How to test

To be written when a service exists.
