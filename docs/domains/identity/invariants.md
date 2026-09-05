---
id: identity
layer: domain
status: active
updated: 2026-09-04
---

# Invariants — identity

Statements that must be true at all times. **Outrank every feature request.**

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `passwordHash`, `twoFactorSecret`, `otp_code.codeHash` are never returned by a default select and never logged | service-layer `select`/`omit`; `sanitizeError` | credential disclosure |
| 2 | The plain OTP code and plain refresh token are never persisted — only an argon2id hash (OTP) / HMAC hash (refresh) | `OtpService`, `TokenService` | token replay if store leaks |
| 3 | A password change or reset revokes every session of that user (Postgres `updateMany` + Redis `dropAllForUser`) in one transaction | `AuthService.resetPassword` | stolen session survives password change |
| 4 | JWT verification always uses HS256 regardless of the token header `alg` | `TokenService.verify`, Go `jwt.Validate` | `alg:none` / alg-confusion forgery |
| 5 | Every User has exactly one `tenantId` and one `roleId` (both non-null FKs) | schema NOT NULL FKs | orphaned / cross-tenant identity |
| 6 | An account with `phoneVerifiedAt = null` cannot complete password login | `AuthService.loginWithPassword` | unverified accounts act as real users |
| 7 | Impersonation requires a target strictly lower in role rank than the admin, an active target, and a reason note >= 10 chars; it is always written to `admin_audit_log` | `ImpersonationService` | privilege escalation, unaudited access |
| 8 | Sessions in Postgres are the record; the Redis marker is only the liveness cache — a missing marker means "revoked", never "unknown, allow" | `AuthGuard`, `auth-handler` | revoked session accepted |
| 9 | `isSystemRole` roles cannot be deleted | schema intent (`Role.isSystemRole`) — **not yet constraint-enforced** | RBAC lockout |
| 10 | OTP: at most one active code per (phone, purpose); >5 attempts destroys it | `OtpStore` Lua script + `setNx` lock | brute force, code flooding |
| 11 | Register creates no `user` row until phone OTP verification succeeds; the submitted profile + password hash live only in Redis (`register:pending:<phone>`) until then | `RegisterService.register` / `.verifyPhone` | unclaimed/abandoned "semi-active" accounts occupying a username or phone number |

## How to test

1. Repository/service unit tests assert `passwordHash` absent from returned DTOs.
2. `OtpService` test: issue twice within cooldown -> 429; 6th verify -> exhausted.
3. `AuthService.resetPassword` test: pre-existing session `isActive()` -> false after.
4. `TokenService.verify` test: token with `alg:none` header -> `UnauthorizedException`.
5. `ImpersonationService` test: equal/greater role -> `ForbiddenException`; audit row created.
6. Login test: 11th bad password within window -> `auth.temporarilyLocked`.
7. `RegisterService` test: after `register()`, `prisma.user.findFirst` for that
   phone/username returns nothing; only after a correct `verifyPhone()` does
   the row exist, with `phoneVerifiedAt` already set.
