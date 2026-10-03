---
id: fraud
layer: domain
status: draft
updated: 2026-10-03
---

# Invariants — fraud

1–4 are from schema comments and not enforced yet (F-036). 5–7 are built (F-036-a).

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A `fraud_flag` is advisory: only `severity = critical` may carry an automatic hard action; everything else is `require_manual_review` or a soft action (`freeze_config`, `block_transfer`, `hold_coupon`) | planned service layer / schema | see contract | 
| 2 | Flags are never deleted; they are resolved (`resolvedAt`, `resolvedByAdminId`) | planned service layer / schema | see contract | 
| 3 | `subjectType` + `subjectId` together identify the flagged entity — code must switch on `subjectType` | planned service layer / schema | see contract | 
| 4 | Scanners only *create* flags; they never ban a user | planned service layer / schema | see contract | 

| 5 | A fingerprint is D-11's recipe and nothing else: web = IP + UA + `device_id`, bot = platform + platform user id, hashed as a JSON array | `device-fingerprint.ts` | a farm hashes as many places, or two places as one |
| 6 | Distinct accounts per fingerprint are counted in one tenant over the 30 days to now; 5 refuses free grants only | `device-fingerprint.ts`, RLS | honest users refused, or a farm admitted |
| 7 | One row per (tenant, account, fingerprint) | unique index | the count reads one account twice |

## How to test

`billing-service/src/app/fraud/device-fingerprint.spec.ts` (5–7).
