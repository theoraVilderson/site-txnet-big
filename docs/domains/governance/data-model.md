---
id: governance
layer: domain
status: draft
updated: 2026-09-04
---

# Data model — governance

Source of truth: `txnet-backend/prisma/domains/governance.prisma` (Postgres schema
`governance`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| user_setting | `(userId, key)` unique KV, JSON value, category-tagged | via user | latest |
| temporal_access_grant | extra permission/resource access for a window; `one_time` or `recurring_daily` | via grantee user | expires |
| user_restriction | per-user cap keyed by `restrictionKey`, JSON limit, soft-warning or hard-block | via user | until inactive/expired |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| temporal_access_grant.granteeUserId, user_setting.userId, user_restriction.userId | -> | identity.user.id | all three are per identity |

## Access rules

Draft. No service yet; when built, no unit outside `governance` writes these
tables and reads go through a `governance` service API.

## Migration notes

No migration history is committed. Any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
