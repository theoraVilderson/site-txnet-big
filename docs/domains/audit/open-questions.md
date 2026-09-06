---
id: audit
layer: domain
status: draft
updated: 2026-09-06
---

# Open questions — audit

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `impersonation_session` + `admin_audit_log` are *written* today by `auth-service` (identity's impersonation module) while this unit is `draft`. Should `source`/`status` reflect that partial implementation? | no | ASSUMED(2026-09-04): keep `draft`; the write path is identity's, the records are audit's | -> AUDIT mode review |
| 2026-09-04 | Append-only enforcement is a comment, not a DB privilege/trigger. Add `REVOKE UPDATE, DELETE`? | no | ASSUMED(2026-09-04): add a migration that revokes UPDATE/DELETE on `admin_audit_log` | -> operations/migrations.md |
| 2026-09-04 | ~~Account switching (`linked_account_group`) has no endpoint. Which unit exposes it?~~ **CLOSED 2026-09-06** | — | `audit` owns the group and its rules (it is the trail of who acted as whom); `auth-api` exposes the routes; `panel-web` renders the switcher; `identity` supplies the proof and issues the session | -> catalog 2.8 (F-0205…F-0210), backlog rows of the same ids |
| 2026-09-06 | `LinkedAccountMember.verifiedViaOtp` is a Boolean, but F-0205 accepts two proofs (OTP **or** password). The column can say which was used only because invariant #4 forbids an unproved row at all — a three-state column would say it directly. Rename to `proof: otp \| password`? | no | ASSUMED(2026-09-06): keep the Boolean for now; no migrations are committed yet (F-017), so the rename stays cheap until first prod data | -> raise at F-0205 implementation, then a schema change or a rules.md line |
| 2026-09-06 | **Drift, reported not fixed (protocol §0).** The catalog block 2.8's schema sketch still reads `userId: unique — an account belongs to at most one group`. The schema and every service now say `@@unique([scopeKey, userId])` (ADR-0015), so code (authority 1) and spec (authority 4) disagree on this line. The six feature rows in that block were updated to `changed` and cite ADR-0015; the sketch above them was left alone because §0 says report drift rather than silently rewrite either side, and the `spec.py --row` path addresses rows, not prose | no | ASSUMED(2026-09-06): the rows are the part agents read via `spec.py`, so the stale sketch misleads only someone reading the block whole | -> user confirms, then the one line is corrected in place (it is a one-line mechanical edit; the catalog is still never opened whole) |

