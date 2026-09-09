---
id: ops-migrations
status: active
updated: 2026-09-09
---

# Migrations

## Current state

- **The migration history starts at `20260908000000_init`.** It lives in
  `txnet-backend/prisma/domains/migrations/` — *inside* the schema folder,
  which is where Prisma looks when `prisma.schema` names a directory rather
  than a file. Putting it at `prisma/migrations/` makes every Prisma command
  report "no migration found" while the files sit there in plain sight.
- The history was started by the E.164 change (ADR-0018), which needed a data
  migration and therefore a place to put one. `D-5` is fully answered as of
  2026-09-09: the hand-written "section 99" SQL below lives in this same
  history and is applied before the first production data — see that section.
- An existing database is brought into the history with
  `prisma migrate resolve --applied <name>` per migration (the dev database
  was baselined this way on 2026-09-08); a new one gets
  `prisma migrate deploy`.
- Prisma commands run from `txnet-backend/` (`npm run prisma:generate`,
  `npm run prisma:migrate`); `package.json` sets `prisma.schema = "prisma/domains"`.

| migration | what it does |
|---|---|
| `20260908000000_init` | the whole schema as it stood on 2026-09-08, generated with `prisma migrate diff --from-empty` |
| `20260908000100_phone_numbers_are_e164` | rewrites `09…` to `+98…` in the three phone columns. Guarded on the national shape, so it is idempotent and leaves anything already E.164 alone (ADR-0018) |
| `20260909000000_credential_vault` | adds `tenant.tenant_credential` + `tenant.tenant_dek` for the Credential Vault (ADR-0026). Additive — no existing table is touched and nothing is backfilled. Carries its own **section 99** SQL: the partial unique index `tenant_credential_one_active_per_kind_label`, which Prisma cannot express and the vault depends on |
| `20260909000100_credential_access_audit` | adds `tenant.tenant_credential_access` — one row per credential decryption (ADR-0026 rule 5, F-1215). Additive, and deliberately **without foreign keys**: an audit trail outlives what it describes, so a `RESTRICT` to `tenant_credential` would block `destroyExpiredVersions` and a `CASCADE` would erase a credential's usage history at the moment it is removed |
| `20260909000200_bot_integration` | creates `automation.bot_integration` — several bots per tenant, with roles (catalog 10.1 / C-05, F-315 F-316) — and drops `tenant.tenant_bot_integration`. **Destructive**, and the one case the policy below allows without an expand/contract pair: the old table was created empty by init and no service, job or seed ever read or wrote it. Carries its own **section 99** SQL: `bot_integration_one_primary_per_tenant_platform`, the partial unique index that *is* C-05 |
| `20260909000300_identity_unique_per_tenant` | replaces `identity.user`'s two platform-wide unique indexes with `@@unique([tenantId, username])` and `@@unique([tenantId, phoneNumber])` (ADR-0023, F-065-b). The new constraint is strictly weaker than the one it drops, so no row can fail to migrate and there is nothing to backfill. The migration carries its own rollback plan, which expires with the first cross-tenant duplicate |

## Policy

- No migration is both destructive and irreversible in one deploy. A table that
  has demonstrably never been written is the exception, and the migration says
  so in its own header — `20260909000200_bot_integration` is the worked
  example.
- Expand -> backfill -> contract, as three separate deploys.
- Every destructive migration writes its rollback plan first.
- One base currency, one `platform_owner` tenant — seed data, not migrations.

## The "section 99" SQL (owned; two applied, the rest not)

The schema header documents controls Prisma cannot express, to be delivered as
hand-written SQL migrations. Two are applied — both partial unique indexes,
each inside the migration that created the table it guards. The rest are not:

| Control | Tables | Why it matters |
|---|---|---|
| Row-Level Security | every `tenantId` table | structural cross-tenant isolation (ADR-0001) |
| Partial unique indexes | `currency_policy`, `user_restriction`, active coupons, `tenant` (`platform_owner`), `currency` (`isBaseCurrency`) — **`tenant_credential` is done**, in `20260909000000_credential_vault`, and **`bot_integration` is done**, in `20260909000200_bot_integration` | uniqueness that only applies to active/one row |
| Multi-column CHECK | `tenant`, `currency`, schedule tables | "exactly one" / mutually-exclusive-fields rules |
| Native range partitioning | `network.traffic_raw_log`, `support.chat_message`, `ai.user_behavior_event` | high-volume append + `DROP PARTITION` instead of `DELETE` |
| BRIN indexes | `traffic_raw_log(recordedAt)` | cheap time-range scans |
| `REVOKE UPDATE, DELETE` | `audit.admin_audit_log` | enforce append-only in the DB, not just convention |

**Owner and timing (answers `D-5`, decided 2026-09-09).** These live as
hand-written `.sql` migrations **in the same `prisma/domains/migrations/`
history** as the generated ones, and they are applied **before the first
production data**. One history, one `prisma migrate deploy`, so a fresh database
cannot come up without them.

Why now rather than later: partitioning an empty table is free, and partitioning
`network.traffic_raw_log` once it holds real traffic is a long outage. The same
is true in reverse for RLS — adding it to a populated multi-tenant database
means proving no existing row is mis-scoped first.

Writing one: generate the surrounding migration with
`prisma migrate diff`, then hand-edit or add a sibling `.sql` file in the same
migration directory. Prisma applies whatever SQL the directory contains and
records it in `_prisma_migrations` like any other step, which is what keeps the
two kinds in one history. A generated migration must never be edited after it
has been applied anywhere; add a new one instead.


## Seed data (`txnet-backend/prisma/seed.js`)

Bootstraps the state the app assumes always exists but no migration creates:
the four RBAC roles (`user`, `Support`, `Admin`, `SuperAdmin`), the
`platform_owner` Tenant, and one owner User for it. Idempotent — safe on every
`db push` / `migrate dev` / `migrate reset`; skips tenant+owner creation if
`platform_owner` already exists but still upserts the roles.

Plain CommonJS on purpose (see the file's own header comment): ts-node 10.9.1
can't run a `.ts` entry directly on Node 20.

Spans two domains — `identity` (roles, user) and `tenant` (the tenant row) —
which is why it lives here rather than under either domain's `source:`: it is
a one-off bootstrap procedure, not application code either domain runs at
request time.

**Hardcoded couplings a future rename would silently break** (per the file's
own comments — not verified as a documented invariant on either side, ask
before changing either):
- `RegisterService.register` looks up `Role.name = 'user'`
  (`domains/identity/rules.md` #5).
- `ImpersonationService.isRoleHigher` ranks `SuperAdmin > Admin > Support > User`
  (`domains/identity/open-questions.md`).
- `tenant.billingModel` is hardcoded to `subscription_monthly` for
  `platform_owner` — the script's own comment flags this as
  ASSUMED (2026-09-04), not a real decision; see
  `domains/tenant/open-questions.md`.

Not tracked by `tools/drift.py` (operations docs aren't a `source:`-bearing
unit) — it will keep reporting this file as an orphan. That's expected; this
section is its documentation of record.

## Partition maintenance

Once partitioning lands, a scheduled job (`automation`) must pre-create next
month's partitions and archive+drop expired ones (`chat_message` archives to
object storage first). No such job exists yet.
