---
id: fraud
layer: domain
status: draft
updated: 2026-10-03
---

# Data model — fraud

Source of truth: `txnet-backend/prisma/domains/fraud.prisma` (Postgres schema
`fraud`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| device_fingerprint | (tenant, account, D-11 hash) unique; `channel` web/bot; first/last seen | **yes** — `tenantId` + RLS (`tenant_isolation`, `cross_tenant`) | long |
| fraud_flag | polymorphic subject + flag type + severity + `autoActionTaken` + resolution | no (polymorphic `subjectId`) | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| device_fingerprint.userId | -> | identity.user.id | fingerprints belong to users |
| fraud_flag.subjectId | -> | identity.user / network.config / billing.wallet_transfer_request / billing.coupon_redemption / engagement.spin_wheel_attempt / billing.affiliate_referral | polymorphic by `subjectType` |
| device_fingerprint (referenced) | -> | engagement.spin_wheel_attempt.deviceFingerprintId | spin abuse detection |

## Access rules

`device_fingerprint` is written and read only by `billing-service/src/app/fraud/`,
on the app pool inside the request's tenant. `fraud_flag` has no writer yet.

## Migration notes

`20261003000100_a_device_fingerprint_is_per_tenant`: `tenantId`, `channel`,
the unique and the (tenantId, fingerprintHash, lastSeenAt) index, RLS.
`fraud_flag` still has no `tenantId` or RLS (F-036).
