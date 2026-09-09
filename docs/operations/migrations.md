---
id: ops-migrations
status: active
updated: 2026-09-05
---

# Migrations

## Current state

- **The migration history starts at `20260908000000_init`.** It lives in
  `txnet-backend/prisma/domains/migrations/` — *inside* the schema folder,
  which is where Prisma looks when `prisma.schema` names a directory rather
  than a file. Putting it at `prisma/migrations/` makes every Prisma command
  report "no migration found" while the files sit there in plain sight.
- The history was started by the E.164 change (ADR-0018), which needed a data
  migration and therefore a place to put one. This answers `D-5` for the
  schema as a whole; the hand-written "section 99" SQL below is still
  unowned and unapplied.
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
