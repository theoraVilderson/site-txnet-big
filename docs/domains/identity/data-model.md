---
id: identity
layer: domain
updated: 2026-09-05
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
| linked_bot_account | user <-> Telegram/Bale chat id (OTP delivery source), plus the messenger-verified phone (`phoneNumber`) and the moment that proof succeeded (`contactVerifiedAt`) | via user | until unlinked |

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

## Bot link — Redis until it is proven

A link the user has not completed is not a row. The deep-link token, the phone
it was issued for, and what to do once it succeeds live only in Redis
(`botlink:token:<token>`, `botlink:phone:*`, `botlink:chat:*` — see
`redis-keyspace`). `linked_bot_account` is written once, at the moment the
shared contact passes the ownership check, with `contactVerifiedAt` set in the
same write. A row without `contactVerifiedAt` (a link made before this existed)
is inert: senders will not deliver to it. See invariants.md #12.

`@@unique([platform, platformUserId])` is what stops one messenger account from
being attached to two platform accounts — without it, a chat id could be made
to receive a second account's codes.

## Register flow — no interim Postgres row

`register` never inserts into `user`. The validated profile + argon2 password
hash are cached in Redis only (`register:pending:<phone>`, 600s TTL, see
`redis-keyspace`); `verify-phone` reads that cache and does the single
`user.create` once the OTP checks out. See invariants.md #11.

## Migration notes

- The "section 99" manual SQL in the schema (RLS, partial unique indexes,
  `platform_owner` CHECK) is **not yet applied**.
- No migration history is committed yet (`prisma/migrations/` absent); schema is
  currently applied via `prisma migrate dev` / `db push` in dev.
- 2026-09-05 added, still unmigrated like the rest: `OtpPurpose.account_link`,
  `linked_bot_account.phoneNumber`, `linked_bot_account.contactVerifiedAt`, and
  `@@unique([platform, platformUserId])` on `linked_bot_account`. The unique
  index can fail to create on an existing database that already has one chat id
  on two users — check before applying (F-041).
