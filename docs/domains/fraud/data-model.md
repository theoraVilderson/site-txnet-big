---
id: fraud
layer: domain
status: draft
updated: 2026-09-04
---

# Data model — fraud

Source of truth: `txnet-backend/prisma/domains/fraud.prisma` (Postgres schema
`fraud`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| device_fingerprint | user <-> device hash, first/last seen | via user | long |
| fraud_flag | polymorphic subject + flag type + severity + `autoActionTaken` + resolution | no (polymorphic `subjectId`) | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| device_fingerprint.userId | -> | identity.user.id | fingerprints belong to users |
| fraud_flag.subjectId | -> | identity.user / network.config / billing.wallet_transfer_request / billing.coupon_redemption / engagement.spin_wheel_attempt / billing.affiliate_referral | polymorphic by `subjectType` |
| device_fingerprint (referenced) | -> | engagement.spin_wheel_attempt.deviceFingerprintId | spin abuse detection |

## Access rules

Draft. No service yet; when built, no unit outside `fraud` writes these
tables and reads go through a `fraud` service API.

## Migration notes

No migration history is committed. Any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
