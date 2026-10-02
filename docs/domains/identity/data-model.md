---
id: identity
layer: domain
updated: 2026-09-19
---

# Data model — identity

**Do not copy the schema here.** Source of truth:
`txnet-backend/prisma/domains/identity.prisma` (Postgres schema `identity`),
migrated by `txnet-backend/prisma/domains/migrations/` — which starts at
`20260908000000_init` plus the E.164 rewrite that follows it and
`20260909000300_identity_unique_per_tenant`.

Every phone column (`user.phoneNumber`, `otp_code.phoneNumber`,
`linked_bot_account.phoneNumber`) holds **E.164** and nothing else. That is
what makes `user.phoneNumber` mean one person: a national number is ambiguous
between countries, and two real people would be conflated by it. See ADR-0018.

**One person, within one tenant.** Since F-065-b the uniqueness is
`@@unique([tenantId, username])` and `@@unique([tenantId, phoneNumber])`, not a
column-level `@unique` — two tenants may hold the same phone number as two
unrelated accounts (ADR-0023). Nothing reads those columns without a tenant:
`user` is in `TENANT_SCOPED_MODELS`, so every query is scoped by the ambient
tenant or throws (ADR-0024). NULLs stay distinct, so a tenant may still have
many users with no username.

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| user | core identity, auth secrets, prefs; `timezone` (IANA, nullable) + `timezoneSource` (`user` \| `browser`), set together — a CHECK holds it (TZ-1-b, [contract.time-zone.md](contract.time-zone.md)) | yes (`tenantId`) | soft-delete (`deletedAt`) |
| session | active logins, refresh-token hash, impersonation link | via user | prune on expiry/revoke |
| role | dynamic RBAC role | **yes, or not at all** (`tenantId` nullable — null = a system template every tenant reads, F-018-n) | permanent; `isSystemRole` protected |
| permission | permission key (`wallet.manual_adjust`, ...) | no | permanent |
| role_permission | role<->permission join | no | — |
| otp_code | OTP audit/history + fallback | no (has `phoneNumber`) | expire; Redis is truth (ADR-0007) |
| linked_bot_account | user <-> Telegram/Bale chat id (OTP delivery source), plus the messenger-verified phone (`phoneNumber`) and the moment that proof succeeded (`contactVerifiedAt`) | yes (`tenantId`, F-066-l) | until unlinked |

## A role belongs to a tenant, or to no one (F-018-n, ADR-0062)

`role.tenantId` is nullable and means two things. Non-null: the row is that
tenant's, and only that tenant edits it. Null: a **system template**, read by
every tenant and written by none — which is what the pre-F-018-n rows (`user`,
`Admin`, `SuperAdmin`) already were, so they are left null and nothing that
reads a role by id changed.

`role` is **not** in `TENANT_SCOPED_MODELS`, deliberately: the ambient scope
(ADR-0024) would hide the templates, which belong to no tenant. `RolesService`
is the one place that applies the scope instead — `{OR: [own, template]}` to
read, the caller's own tenant to write.

The column is plain, with no Prisma relation and no FK, like
`LinkedBotAccount.tenantId`: a unique index cannot span a join, and the
structural SQL is collected in F-041 / F-066-m.

**Row-Level Security, shape B (shared-read).** A table with a `tenantId` must
be policied — `rls-coverage.spec.ts` reads that rule off the schema, and it is
the failure that is otherwise silent. `role`'s policy is `USING ("tenantId" IS
NULL OR mine)` with a strict `WITH CHECK`, so a tenant sees its own roles and
the templates, and can never *write* into the shared set. `DELETE` has no
`WITH CHECK`, so a template is kept out of one by `RolesService.ownRole`, not
by the policy (invariants.md #9).

That policy is why `PermissionNotificationsListener` moved to
`CrossTenantPrismaService`: it recomputes every tenant's roles from a `LISTEN`
callback, which has no ambient tenant, and on the app pool would now see the
templates alone.

**Two indexes, not one.** `@@unique([tenantId, name])` gives each tenant its own
namespace, but NULLs are distinct in Postgres, so it would let two templates
share a name. `20260919000200_identity_role_tenant` adds the second by hand —
`role_system_name_key ON role(name) WHERE "tenantId" IS NULL` — which is exactly
what the old global `@unique` meant. Prisma cannot express a partial unique
index, so it is in the migration and not in the schema.

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| user.tenantId | -> | tenant.tenant.id | every identity belongs to one tenant (ADR-0001) |
| role.tenantId | -> | tenant.tenant.id | a tenant composes its own roles (F-018-n, ADR-0062); null = a template owned by no tenant |
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

## A session records what was observed, not what was available (F-048)

`session.ipAddress` and `session.userAgent` are nullable, and null is an
answer rather than a gap. A session minted from a bot webhook is created by
`bot-service` on the account's behalf: the HTTP request `auth-service` sees is
that container's, so its address and user agent describe the platform, not the
person, and are identical for every chat. Writing them was worse than writing
nothing — a session list and an audit trail both read the column as a place.

`session.deviceLabel` carries the one true thing instead: `Telegram` / `Bale`
for a messenger-originated session, null for a browser, which already describes
itself. `BotSessionService` is its only writer.

The Mini App is the exception on both counts: a webview *is* a browser, so
`bots/webapp/session` passes the real pair through and gets the label as well.

Both facts are carried forward, never re-derived, by the two operations that
re-mint a session — `refresh` and `switchSession` — for the same reason
`scopeKey` is (ADR-0015): a rotation is the same session continuing on the same
surface. Re-deriving would restore the container address within one
access-token lifetime. A row that observed an IP still has it re-read on
refresh; a browser legitimately moves.

## Register flow — no interim Postgres row

`register` never inserts into `user`. The validated profile + argon2 password
hash are cached in Redis only (`register:pending:<phone>`, 600s TTL, see
`redis-keyspace`); `verify-phone` reads that cache and does the single
`user.create` once the OTP checks out. See invariants.md #11.

## Migration notes

- 2026-09-28, F-601-u (`20260928002300_a_user_chooses_their_notice_messenger`):
  `user.noticeMessenger` (`NoticeMessenger`: telegram, bale, both), nullable
  and never backfilled — null is "not chosen" and reads as both. Rollback drops
  the column and the type.
- 2026-09-19, F-018-n (`20260919000200_identity_role_tenant`): `role.tenantId`
  added nullable and never backfilled; `role_name_key` replaced by
  `(tenantId, name)` plus the partial index above, and the table policied
  shared-read in the same file. Rollback re-creates the
  global unique on `name`, which succeeds only while no two tenants hold the
  same role name.
- The "section 99" manual SQL in the schema (RLS, partial unique indexes,
  `platform_owner` CHECK) is **not yet applied**.
- Migration history lives in `prisma/domains/migrations/` — hand-written SQL,
  one history, applied before the first production data
  (`docs/operations/migrations.md`).
- 2026-09-08, still unmigrated like the rest (F-048): `session.ipAddress` and
  `session.userAgent` relaxed to nullable. Widening only — no existing row
  changes and no reader exists today, so it applies cleanly.
- 2026-09-05 added: `OtpPurpose.account_link`,
  `linked_bot_account.phoneNumber`, `linked_bot_account.contactVerifiedAt`, and
  a unique index on `linked_bot_account`, which F-066-l has since scoped to
  `@@unique([tenantId, platform, platformUserId])`
  (`20260909000400_bot_link_unique_per_tenant`). Migrated: the migration
  backfills `tenantId` from the owning user before adding the index.
