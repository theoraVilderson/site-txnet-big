---
id: identity
layer: domain
updated: 2026-09-04
---

# Business rules — identity

Internal logic. Outside consumers read contract.md.

## Session state machine

`created` -> `active` -> `revoked`. Revoke reasons: `user_logout`,
`password_change`, `admin_ban`, `expired`, `impersonation_ended`. `refresh`
performs `revoke(old, user_logout)` + `create(new)` atomically (token rotation).

## Rules
| # | Rule | Trigger | Exception |
|---|---|---|---|
| 1 | OTP channel resolution: explicit request channel -> user `preferredOtpChannel` -> `sms` | any OTP issue | channel must be in `OTP_ALLOWED_CHANNELS` |
| 2 | `bale` / `telegram` channel needs a pre-existing `linked_bot_account` for chat id | OTP issue on those channels | falls back / errors per sender |
| 3 | Identifier type: matches Iran mobile regex -> phone (normalized `09xxxxxxxxx`), else username | password login | — |
| 4 | Strong password must not contain username / full name / phone fragments | register, reset | `password.containsProfileData` |
| 5 | Default tenant/role on register: `Tenant.slug = 'platform_owner'`, `Role.name = 'user'` | register | `register.defaultRoleMissing` if seed absent |
| 6 | Impersonation session lifetime is 30 min and cannot perform `SensitiveActionGuard` actions | impersonated request | — |
| 7 | Access-token `permissions[]` is a snapshot from `role_permission` at sign time | token issue | stale until token expires |

## Edge cases decided
| Case | Decision | Date |
|---|---|---|
| OTP verify with both `phoneNumber` and `otpToken` | reject (schema `.refine`) | 2026-09-04 (observed) |
| Refresh token missing on logout | return `{success:true}` (idempotent) | 2026-09-04 (observed) |
| Login OTP request for unknown/inactive phone | still return `{accepted:true}`, send nothing | 2026-09-04 (observed) |
