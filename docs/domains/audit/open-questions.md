---
id: audit
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — audit

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `impersonation_session` + `admin_audit_log` are *written* today by `auth-service` (identity's impersonation module) while this unit is `draft`. Should `source`/`status` reflect that partial implementation? | no | ASSUMED(2026-09-04): keep `draft`; the write path is identity's, the records are audit's | -> AUDIT mode review |
| 2026-09-04 | Append-only enforcement is a comment, not a DB privilege/trigger. Add `REVOKE UPDATE, DELETE`? | no | ASSUMED(2026-09-04): add a migration that revokes UPDATE/DELETE on `admin_audit_log` | -> operations/migrations.md |
| 2026-09-04 | Account switching (`linked_account_group`) has no endpoint. Which unit exposes it — `identity`? | no | ASSUMED(2026-09-04): `identity` / `auth-api`, same OTP infra | -> interfaces/auth-api |
