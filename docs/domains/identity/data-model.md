---
id: identity
layer: domain
updated: 2026-09-04
---

# Data model — identity

**Do not copy the schema here.** Source of truth:
`txnet-backend/prisma/domains/identity.prisma` (Postgres schema `identity`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| user | core identity, auth secrets, prefs | yes (`tenantId`) | soft-delete (`deletedAt`) |
| session | active logins, refresh-token hash, impersonation link | via user | prune on expiry/revoke |
| role | dynamic RBAC role | no (global) | permanent; `isSystemRole` protected |
| permission | permission key (`wallet.manual_adjust`, ...) | no | permanent |
| role_permission | role<->permission join | no | — |
| otp_code | OTP audit/history + fallback | no (has `phoneNumber`) | expire; Redis is truth (ADR-0007) |
| linked_bot_account | user <-> Telegram/Bale chat id (OTP delivery source) | via user | until unlinked |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| user.tenantId | -> | tenant.tenant.id | every identity belongs to one tenant (ADR-0001) |
| session.impersonationSessionId | -> | audit.impersonation_session.id | audit owns the impersonation record |
| user.referredByUserId | -> | user.id (self) | referral chain; affiliate payouts live in `billing` |

## Access rules

Other units never read these tables. Identity facts reach them only as
`X-User-Id` / `X-Tenant-Id` / `X-Role-Id` / `X-User-Permissions` headers set by
`forward-auth` after JWT + session validation.

## Migration notes

- The "section 99" manual SQL in the schema (RLS, partial unique indexes,
  `platform_owner` CHECK) is **not yet applied**.
- No migration history is committed yet (`prisma/migrations/` absent); schema is
  currently applied via `prisma migrate dev` / `db push` in dev.
