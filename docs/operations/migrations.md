---
id: ops-migrations
status: active
updated: 2026-09-04
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

## Partition maintenance

Once partitioning lands, a scheduled job (`automation`) must pre-create next
month's partitions and archive+drop expired ones (`chat_message` archives to
object storage first). No such job exists yet.
