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
(`PUT /api/auth/tenants/:id/status`, `contract.admin.md`); the subscription
renewal moves one too (#10-#13), through the same transition. The platform
owner's own tenant is never moved.

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
| 5 | Enforcement is in the services (`TenantStatusGuard`, `APP_GUARD` in auth-, billing- and notification-service — C-11 fails an app that opens a tenant scope without it), from `tenant:status:<id>` in Redis — forward-auth has no tenant (ADR-0024) | every request with a tenant in scope | a request with no tenant is not judged |
| 9 | A background tick that names a tenant runs only if the status allows its job's `tenantCapability` (unset = `staffWrite`); a refused tick is acked, is no run and takes no slot (`worker-service` `TenantStatusGate`, F-018-p) | every tick with `tenantId` | a platform tick is not judged; a missing key refuses nobody |
| 6 | Redis follows Postgres at once: a trigger on `tenant.status`/`graceEndsAt` notifies `tenant_status_changed`, `TenantStatusListener` rewrites the key, and recomputes every tenant on each connect | commit | **a missing key refuses nobody** (F-101-b's trade) |
| 7 | `system` is never closed | — | a payment already taken still settles, or the record of money that moved is lost |
| 8 | A refusal is `403` `{i18nKey: tenant.suspended \| tenant.terminated, reason: tenantSuspended \| tenantTerminated}` | — | — |
| 10 | A due renewal the billing wallet covers is charged, and takes `trial` -> `active` (history `subscription_renewed`, actor null) | `currentPeriodEnd` passed (`contract.billing.md` "Subscription renewal") | a manual suspension stays |
| 11 | A short renewal warns the owner at most once a day until `currentPeriodEnd` + `renewalGraceDays` (default 3) | the renewal finds the wallet short | an already suspended tenant is not warned |
| 12 | Grace over and still short: `suspended`, `suspensionCause = non_payment`, reason `subscription_unpaid`, #1's stamps, the owner told; nothing deleted (#4) | renewal after the grace | a tenant already suspended is left as it is |
| 13 | A payment lifts **only** a `non_payment` suspension: the charge is taken at once and the tenant is `active`, its new period starting now | a credit to the billing wallet, or the next sweep | a `manual` suspension is charged and renewed and stays suspended (user, 2026-09-17) |
| 14 | The platform owner suspending a `non_payment`-suspended reseller makes the cause `manual`; the suspension's stamps are kept (F-018-s) | `PUT .../status` `suspended` | already `manual` is `status_unchanged` |

## Edge cases decided
| Case | Decision | Date |
|---|---|---|
| `/sub` has no server yet | the matrix column and `graceEndsAt` ship now; `network`'s service calls `tenantAllows(state, 'subscriptionLink')` when it serves the link (user, F-018-f) | 2026-09-17 |
| A mutating route nobody labelled | closed for a suspended tenant (`staffWrite`) — fail closed (user, F-018-f) | 2026-09-17 |
| One row, one session | the user chose not to split enforcement per service | 2026-09-17 |
| A terminated tenant's in-flight payment | settles (`system`); a card-to-card confirmation by staff does not (`staffWrite`) | 2026-09-17 |
| Services other than auth-/billing-service | `notification-service` registers the guard; ticks are judged by `TenantStatusGate` (F-018-p). `bot-service` calls auth-/billing-service, which refuse. `gateway-service` sockets stay out (row note): a client frame only subscribes to a channel, a `read`, so suspension closes nothing there — but a **terminated** tenant's open socket still receives pushes, an unenforced `read: no` | 2026-09-17 |
| The platform owner reactivates a `non_payment`-suspended reseller without a payment | allowed; the period is still unpaid and past grace, so the next sweep suspends it again. Until F-019-g (a grace extension) the only way to give time is a manual credit | 2026-09-17 |
| A campaign already `sending` when its reseller is suspended or terminated | it finishes — `system`, like a payment already taken; only starting one is `staffWrite`. A heads-up and a "suspend and stop sending" option are F-018-q (user, F-018-p) | 2026-09-17 |
