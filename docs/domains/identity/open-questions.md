---
id: identity
layer: domain
updated: 2026-09-04
---

# Open questions — identity

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `isSystemRole` deletion protection is only a comment, not a DB/service check. Add it? | no | ASSUMED(2026-09-04): enforced in the (unwritten) role-admin service | -> rules.md + constraint |
| 2026-09-04 | `twoFactorEnabled` login path exists but there is no endpoint to enable/manage 2FA or `preferredOtpChannel`. Which unit owns profile settings? | no | ASSUMED(2026-09-04): future `governance` UserSetting or an identity profile endpoint | -> ADR or rules.md |
| 2026-09-04 | No Prisma migration history is committed. Is dev `db push` the intended flow until launch? | yes (affects data model) | ASSUMED(2026-09-04): yes, migrations start before first prod deploy | -> operations/migrations.md |
| 2026-09-04 | Role rank for impersonation is a hard-coded map (`SuperAdmin/Admin/Support/User`) in `impersonation.service.ts`, disconnected from the `role` table. Reconcile? | no | ASSUMED(2026-09-04): seed roles use exactly those names | -> rules.md |
