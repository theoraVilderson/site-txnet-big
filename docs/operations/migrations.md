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
| `20260909000400_bot_link_unique_per_tenant` | `@@unique([tenantId, platform, platformUserId])` on `identity.linked_bot_account`, plus the denormalized `tenantId` it needs (catalog 10.5, F-066-l) |
| `20260909000500_row_level_security` | **hand-written, section 99.** `public.current_tenant_id()`, the group roles `txnet_app` / `txnet_cross_tenant`, their grants, and RLS (`ENABLE` + `FORCE`) with a `tenant_isolation` policy on `identity.user` and `identity.linked_bot_account` (catalog 20.2 layer 1, F-1202, F-066-m-a). Additive; the rollback is `DROP POLICY` + `DISABLE ROW LEVEL SECURITY` on the two tables. **Needs the manual step below** — it creates the group roles, not the login roles |

## Policy

- No migration is both destructive and irreversible in one deploy. A table that
  has demonstrably never been written is the exception, and the migration says
  so in its own header — `20260909000200_bot_integration` is the worked
  example.
- Expand -> backfill -> contract, as three separate deploys.
- Every destructive migration writes its rollback plan first.
- One base currency, one `platform_owner` tenant — seed data, not migrations.

## The "section 99" SQL (owned; RLS and two indexes applied, the rest not)

The schema header documents controls Prisma cannot express, to be delivered as
hand-written SQL migrations. Row-Level Security is now applied in full, plus two
partial unique indexes, each inside the migration that created the table it
guards. The rest are not:

| Control | Tables | Why it matters |
|---|---|---|
| Row-Level Security — **done**, in `20260909000500_row_level_security` (2 tables) and `20260909001500_row_level_security_all_tables` (the other 23) | all 25 `tenantId` tables carry `ENABLE`/`FORCE ROW LEVEL SECURITY`, a `tenant_isolation` policy and a `cross_tenant` one. Three policy shapes, because `tenantId` does not mean the same thing everywhere — the second migration's header lists which table has which and why. `tenant.tenant` itself is **not** covered: it has no `tenantId` column, so its rule would be `id = current_tenant_id()`, a row of its own. Coverage is asserted by `rls-coverage.spec.ts`, not trusted | structural cross-tenant isolation (ADR-0001) |
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


## The two RLS login roles — a manual step per database

`20260909000500_row_level_security` creates the *group* roles and the policies.
It cannot create the roles the services log in as, because those carry
passwords and a password does not belong in a committed file. That step is:

```bash
./scripts/db-login-roles.sh          # ENV_FILE=.env.prod for production
```

It reads `DB_APP_PASSWORD` and `DB_CROSS_TENANT_PASSWORD` (`.env.example`) and
creates `txnet_app_user` and `txnet_cross_tenant_user` — idempotent, and
re-running it with a new password is how one is rotated.

**Why the services do not connect as `MAIN_DB_USERNAME`.** RLS is not enforced
against a superuser, and not against a table's own owner. `MAIN_DB_USERNAME` is
both — it is what `prisma migrate` runs as — so a service connecting with it
would leave every policy in place and completely inert. `auth-service` therefore
reads `DATABASE_APP_URL` and **refuses to boot without it**: a fallback to
`DATABASE_URL` would silently restore exactly the state the policies exist to
end, and nothing would look wrong. `DATABASE_URL` stays in the environment only
because the Prisma CLI reads it by name.

Since F-066-m-b there is a second one, `DATABASE_CROSS_TENANT_URL`
(`txnet_cross_tenant_user`), required on the same terms. It is what the reads
that *produce* a tenant go through — host -> tenant, webhook path -> bot,
credential -> DEK — because those tables are policied now and the app pool is
shown nothing on them. Pointing it at `DATABASE_APP_URL` makes domain
resolution and the vault answer no rows; pointing it at `DATABASE_URL` un-does
the layer. Its role's `USING (true)` is a **policy**, not `BYPASSRLS`: neither
login role can turn the rules off, only be granted different ones.

**A migration role that is not a superuser needs `txnet_cross_tenant`.**
`FORCE ROW LEVEL SECURITY` binds a table's owner; only superuser status exempts
it. The stock compose stack is fine — `MAIN_DB_USERNAME` is the image's
superuser — but a hardened install that demotes it must grant it membership of
`txnet_cross_tenant`, or `prisma db seed` will insert nothing and say so
nowhere.

The cost, stated plainly: **an existing database does not come up until this
script has been run once.** That is deliberate, and it is the same shape as
ADR-0018's keyspace bump — a visible, one-time operator action in exchange for
a boundary that cannot be half-applied.

Not covered by either: the e2e tier, which builds its schema with
`prisma db push` and therefore skips the migration history — every section 99
statement with it. `DATABASE_APP_URL` and `DATABASE_CROSS_TENANT_URL` there are
both the same connection as `DATABASE_URL`, and proving isolation against real
policies is F-066-n.

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
