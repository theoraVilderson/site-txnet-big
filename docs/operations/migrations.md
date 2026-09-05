---
id: ops-migrations
status: active
updated: 2026-09-05
---

# Migrations

## Current state

- **No `prisma/migrations/` directory is committed.** The schema
  (`txnet-backend/prisma/domains/*.prisma`, Postgres `multiSchema`) is applied in
  dev via `prisma migrate dev` / `db push`. A real migration history must exist
  before the first production deploy — tracked as a blocking open question in
  `domains/identity/open-questions.md`.
- Prisma commands run from `txnet-backend/` (`npm run prisma:generate`,
  `npm run prisma:migrate`); `package.json` sets `prisma.schema = "prisma/domains"`.

## Policy

- No migration is both destructive and irreversible in one deploy.
- Expand -> backfill -> contract, as three separate deploys.
- Every destructive migration writes its rollback plan first.
- One base currency, one `platform_owner` tenant — seed data, not migrations.

## The "section 99" SQL (NOT applied)

The schema header documents controls Prisma cannot express, to be delivered as
hand-written SQL migrations. None are applied yet:

| Control | Tables | Why it matters |
|---|---|---|
| Row-Level Security | every `tenantId` table | structural cross-tenant isolation (ADR-0001) |
| Partial unique indexes | `currency_policy`, `user_restriction`, active coupons, `tenant` (`platform_owner`), `currency` (`isBaseCurrency`) | uniqueness that only applies to active/one row |
| Multi-column CHECK | `tenant`, `currency`, schedule tables | "exactly one" / mutually-exclusive-fields rules |
| Native range partitioning | `network.traffic_raw_log`, `support.chat_message`, `ai.user_behavior_event` | high-volume append + `DROP PARTITION` instead of `DELETE` |
| BRIN indexes | `traffic_raw_log(recordedAt)` | cheap time-range scans |
| `REVOKE UPDATE, DELETE` | `audit.admin_audit_log` | enforce append-only in the DB, not just convention |

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
