---
id: tenant
layer: domain
status: active
updated: 2026-09-17
---

# Business rules — tenant status

What a tenant's status allows (F-018-f, D-42 (1), ADR-0057). The executable
copy is `TenantStatusPolicy` in `shared-core/src/lib/tenant/status-policy.ts`;
the two must say the same thing.

## State machine

`trial` -> `active` | `suspended` | `terminated`;
`active` -> `suspended` | `terminated`; `suspended` -> `active` | `terminated`.
`terminated` is final. Only the platform owner moves a reseller by hand
(`PUT /api/auth/tenants/:id/status`, `contract.admin.md`); F-019-c's renewal
will call the same service. The platform owner's own tenant is never moved.

## The matrix

A route declares one capability (`@TenantCapability`); one that declares none
is `read` for `GET`/`HEAD`/`OPTIONS` and **`staffWrite` for anything else**.

| Capability | trial / active | suspended | terminated |
|---|---|---|---|
| `signIn` — sign in, refresh, captcha, OTP, recovery, bot sign-in | yes | yes | no |
| `signOut` | yes | yes | yes |
| `read` — any `GET`; the bot serving a user | yes | yes | no |
| `account` — a user's own email, switching accounts | yes | yes | no |
| `staffWrite` — the reseller panel changing anything (the default) | yes | **no** | no |
| `tenantBilling` — the reseller topping up its billing wallet | yes | yes | no |
| `register` | yes | **no** | no |
| `sell` — an end user buying a service (no route yet) | yes | **no** | no |
| `endUserDeposit` — deposit quote/start, in-chat pre-checkout, gift redeem | yes | **no** | no |
| `system` — gateway webhook and callback, in-chat `paid`, expiry, reconcile, notifications, vault maintenance | yes | yes | yes |
| `subscriptionLink` — `/sub` | yes | until `graceEndsAt` | no |

## Rules
| # | Rule | Trigger | Exception |
|---|---|---|---|
| 1 | Suspending stamps `suspendedAt` = now, `graceEndsAt` = now + `suspensionHoldDays` (default 7, 0..90, `tenant_subscription_setting`) | status -> `suspended` | — |
| 2 | Reactivating clears `suspendedAt`, `graceEndsAt`, `suspendedReason` | `suspended`/`trial` -> `active` | — |
| 3 | Every change appends one `tenant_status_history` row and one `tenant_status_change` audit row, in the change's transaction under the tenant row's lock | any change | an unchanged status is refused, writing nothing |
| 4 | **Nothing is deleted** by any status: users, wallets, configs and history stay | any change | — |
| 5 | Enforcement is in the services (`TenantStatusGuard`, `APP_GUARD` in auth-service and billing-service), from `tenant:status:<id>` in Redis — forward-auth has no tenant (ADR-0024) | every request with a tenant in scope | a request with no tenant is not judged |
| 6 | Redis follows Postgres at once: a trigger on `tenant.status`/`graceEndsAt` notifies `tenant_status_changed`, `TenantStatusListener` rewrites the key, and recomputes every tenant on each connect | commit | **a missing key refuses nobody** (F-101-b's trade) |
| 7 | `system` is never closed | — | a payment already taken still settles, or the record of money that moved is lost |
| 8 | A refusal is `403` `{i18nKey: tenant.suspended \| tenant.terminated, reason: tenantSuspended \| tenantTerminated}` | — | — |

## Edge cases decided
| Case | Decision | Date |
|---|---|---|
| `/sub` has no server yet | the matrix column and `graceEndsAt` ship now; `network`'s service calls `tenantAllows(state, 'subscriptionLink')` when it serves the link (user, F-018-f) | 2026-09-17 |
| A mutating route nobody labelled | closed for a suspended tenant (`staffWrite`) — fail closed (user, F-018-f) | 2026-09-17 |
| One row, one session | the user chose not to split enforcement per service | 2026-09-17 |
| A terminated tenant's in-flight payment | settles (`system`); a card-to-card confirmation by staff does not (`staffWrite`) | 2026-09-17 |
| `gateway-service`, `bot-service`, `worker-service` | not guarded here: the first holds sockets, the others call auth-/billing-service, which refuse | 2026-09-17 |
