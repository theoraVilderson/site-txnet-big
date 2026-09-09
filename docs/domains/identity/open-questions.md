---
id: identity
layer: domain
updated: 2026-09-09
---

# Open questions — identity

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `isSystemRole` deletion protection is only a comment, not a DB/service check. Add it? | no | ASSUMED(2026-09-04): enforced in the (unwritten) role-admin service | -> rules.md + constraint |
| 2026-09-04 | `twoFactorEnabled` login path exists but there is no endpoint to enable/manage 2FA or `preferredOtpChannel`. Which unit owns profile settings? | no | ASSUMED(2026-09-04): future `governance` UserSetting or an identity profile endpoint | -> ADR or rules.md |
| 2026-09-04 | No Prisma migration history is committed. Is dev `db push` the intended flow until launch? | resolved | **Answered 2026-09-09 (D-5).** Hand-written `.sql` in `prisma/domains/migrations/`, one history, applied before the first production data — five migrations exist today | -> `docs/operations/migrations.md` |
| 2026-09-04 | Role rank for impersonation is a hard-coded map (`SuperAdmin/Admin/Support/User`) in `impersonation.service.ts`, disconnected from the `role` table. Reconcile? | no | ASSUMED(2026-09-04): seed roles use exactly those names | -> rules.md |
| 2026-09-09 | A surface that is not an HTTP request has no tenant. `bot-service` calls `auth-api` on an internal host, so the resolver sees a container name no `tenant_domain` row matches. Until 2026-09-09 that fell into `DEFAULT_TENANT_SLUG`; **F-066-d removed the fallback (ADR-0025) and bot-service now states its tenant** — `BOT_TENANT_ID` as `X-Tenant-Id`, honoured because its service token verified. One process, one tenant: the collision is *declared* rather than guessed, and F-066-i makes it per-`BotIntegration`. Until a bot request names its tenant, identity cannot be scoped per tenant (ADR-0023) — scoping the panel alone moves the collision rather than removing it | yes (tenancy) | ASSUMED(2026-09-09): the mapping is `tenant_bot_integration`, whose reader does not exist yet (F-018). No narrower stand-in is assumed — the row is `todo`, not built on a guess | -> F-066-i (F-065-a was dropped into it), then ADR-0023's F-065-b / F-066-l |
