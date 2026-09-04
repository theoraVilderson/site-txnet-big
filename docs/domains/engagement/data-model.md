---
id: engagement
layer: domain
status: draft
updated: 2026-09-04
---

# Data model — engagement

Source of truth: `txnet-backend/prisma/domains/engagement.prisma` (Postgres schema
`engagement`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| spin_wheel_config | wheel + eligibility thresholds + daily cap; `tenantId` nullable | `tenantId` nullable | permanent |
| spin_wheel_prize | prize: type, value, probability weight, optional daily stock; `currentDayAwardedCount` reset nightly | via config | permanent |
| spin_wheel_attempt | one spin: eligibility snapshot JSON, awarded prize, resulting wallet tx, status | via user | permanent (audit) |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| spin_wheel_attempt.userId | -> | identity.user.id | spins are per user |
| spin_wheel_attempt.deviceFingerprintId | -> | fraud.device_fingerprint.id | multi-account defence |
| spin_wheel_attempt.resultWalletTransactionId | -> | billing.wallet_transaction.id | a `wallet_credit` prize is a ledger entry |

## Access rules

Draft. No service yet; when built, no unit outside `engagement` writes these
tables and reads go through a `engagement` service API.

## Migration notes

No migration history is committed. Any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
