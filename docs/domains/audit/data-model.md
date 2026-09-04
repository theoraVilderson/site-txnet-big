---
id: audit
layer: domain
status: draft
updated: 2026-09-04
---

# Data model — audit

Source of truth: `txnet-backend/prisma/domains/audit.prisma` (Postgres schema
`audit`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| admin_audit_log | every `AdminAction` with before/after JSON, target ref, admin IP | denormalized `tenantId` | permanent, immutable |
| impersonation_session | admin -> target user, reason note, optional linked ticket, start/end | denormalized via admin/target | permanent |
| linked_account_group / linked_account_member | a set of a user's own accounts they can switch between; `verifiedViaOtp` | via member users | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| admin_audit_log.adminId, impersonation_session.adminId/targetUserId, linked_account_member.userId | -> | identity.user.id | actors and subjects are identities |
| impersonation_session (referenced) | -> | identity.session.impersonationSessionId | the login session created for the impersonation |
| impersonation_session.linkedTicketId | -> | support.ticket.id | the support ticket that justified access |

## Access rules

Draft. No service yet; when built, no unit outside `audit` writes these
tables and reads go through a `audit` service API.

## Migration notes

No migration history is committed. Any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
