---
id: tenant
layer: domain
status: active
updated: 2026-09-19
---

# Business rules — tenant status

What a tenant's status allows (F-018-f, D-42 (1), ADR-0057). The executable
copy is `TenantStatusPolicy` in `shared-core/src/lib/tenant/status-policy.ts`;
the two must say the same thing.

## State machine

`trial` -> `active` | `suspended` | `terminated`;
`active` -> `suspended` | `terminated`; `suspended` -> `active` | `terminated`.
`terminated` is final. Only the platform owner moves a reseller by hand
(`PUT /api/tenants/:id/status`, `contract.admin.md`); the subscription
renewal moves one too (#10-#13), through the same transition. The platform
owner's own tenant is never moved.

## The matrix

A route declares one capability (`@TenantCapability`); one that declares none
is `read` for `GET`/`HEAD`/`OPTIONS` and **`staffWrite` for anything else**.

The last column is not a status: **onboarding** is applied on top of whichever
status column is in play, while the reseller has proved no custom domain
(F-018-l, [contract.onboarding.md](contract.onboarding.md)). The stricter of
the two answers wins, and the platform owner is never in it.

| Capability | trial / active | suspended | terminated | + onboarding |
|---|---|---|---|---|
| `signIn` — sign in, refresh, captcha, OTP, recovery, bot sign-in | yes | yes | no | yes |
| `signOut` | yes | yes | yes | yes |
| `read` — any `GET`; the bot serving a user | yes | yes | no | yes |
| `account` — a user's own email, switching accounts | yes | yes | no | yes |
| `staffWrite` — the reseller panel changing anything (the default) | yes | **no** | no | yes |
| `tenantBilling` — the reseller topping up its billing wallet | yes | yes | no | yes |
| `register` | yes | **no** | no | **no** |
| `sell` — an end user buying a service (no route yet) | yes | **no** | no | **no** |
| `endUserDeposit` — deposit quote/start, in-chat pre-checkout, gift redeem | yes | **no** | no | **no** |
| `system` — gateway webhook and callback, in-chat `paid`, expiry, reconcile, notifications, vault maintenance | yes | yes | yes | yes |
| `subscriptionLink` — `/sub` | yes | until `graceEndsAt` | no | **no** |

## Rules
| # | Rule | Trigger | Exception |
|---|---|---|---|
| 1 | Suspending stamps `suspendedAt` = now, `graceEndsAt` = now + `suspensionHoldDays` (default 7, 0..90, `tenant_subscription_setting`) | status -> `suspended` | — |
| 2 | Reactivating clears `suspendedAt`, `graceEndsAt`, `suspendedReason` | `suspended`/`trial` -> `active` | — |
| 3 | Every change appends one `tenant_status_history` row and one `tenant_status_change` audit row, in the change's transaction under the tenant row's lock | any change | an unchanged status is refused, writing nothing |
| 4 | **Nothing is deleted** by any status: users, wallets, configs and history stay | any change | — |
| 5 | Enforcement is in the services (`TenantStatusGuard`, `APP_GUARD` in auth-, billing- and notification-service; `TenantSocketWatch` for gateway-service sockets — C-11 fails an app that opens a tenant scope without it), from `tenant:status:<id>` in Redis — forward-auth has no tenant (ADR-0024) | every request with a tenant in scope | a request with no tenant is not judged |
| 9 | A background tick that names a tenant runs only if the status allows its job's `tenantCapability` (unset = `staffWrite`); a refused tick is acked, is no run and takes no slot (`worker-service` `TenantStatusGate`, F-018-p) | every tick with `tenantId` | a platform tick is not judged; a missing key refuses nobody |
| 6 | Redis follows Postgres at once: a trigger on `tenant.status`/`graceEndsAt` notifies `tenant_status_changed`, `TenantStatusListener` rewrites the key, and recomputes every tenant on each connect | commit | **a missing key refuses nobody** (F-101-b's trade) |
| 7 | `system` is never closed | — | a payment already taken still settles, or the record of money that moved is lost |
| 8 | A refusal is `403` `{i18nKey: tenant.suspended \| tenant.terminated \| tenant.onboarding, reason: tenantSuspended \| tenantTerminated \| tenantOnboarding}` | — | a `trial` or `active` tenant only ever gets the onboarding one |
| 10 | A due renewal the billing wallet covers is charged, and takes `trial` -> `active` (history `subscription_renewed`, actor null) | `currentPeriodEnd` passed (`contract.billing.md` "Subscription renewal") | a manual suspension stays |
| 11 | A short renewal warns the owner at most once a day until `currentPeriodEnd` + `renewalGraceDays` (default 3) | the renewal finds the wallet short | an already suspended tenant is not warned |
| 12 | Grace over and still short: `suspended`, `suspensionCause = non_payment`, reason `subscription_unpaid`, #1's stamps, the owner told; nothing deleted (#4) | renewal after the grace | a tenant already suspended is left as it is |
| 13 | A payment lifts **only** a `non_payment` suspension: the charge is taken at once and the tenant is `active`, its new period starting now | a credit to the billing wallet, or the next sweep | a `manual` suspension is charged and renewed and stays suspended (user, 2026-09-17) |
| 16 | A purchase opens the reseller `active`: created `trial` and moved in the same transaction once the first period is charged (history `reseller_purchased`, actor the buyer) | `POST /api/tenants/purchase` (F-019-h) | — |
| 15 | The platform owner gives more time: the renewal does not suspend before `graceUntil`, and a `non_payment` suspension becomes `active` at once; nothing is credited (F-019-g) | `POST .../subscription/grace` | a `manual` suspension stays |
| 17 | A reseller with no `verified` `panel` `custom_domain` is judged by the onboarding column too, and leaves it by proving one — never by paying. The flag is computed by `TenantStatusListener` into `tenant:status:<id>`, on a domain change as much as a status one (migration `20260919000400_tenant_onboarding_gate`); a state without it is not onboarding | every request with a tenant in scope | the platform owner |
| 14 | The platform owner suspending a `non_payment`-suspended reseller makes the cause `manual`; the suspension's stamps are kept (F-018-s) | `PUT .../status` `suspended` | already `manual` is `status_unchanged` |

## Edge cases decided
| Case | Decision | Date |
|---|---|---|
| `/sub` has no server yet | the matrix column and `graceEndsAt` ship now (user, F-018-f). Enforced since F-113-e by `sub-service` (Go), which copies only this column and reads `tenant:status:<id>` on every answer, cached or not; refused = the inactive Grant's empty `200` (`sub-api/contract.md`) | 2026-09-17 |
| A mutating route nobody labelled | closed for a suspended tenant (`staffWrite`) — fail closed (user, F-018-f) | 2026-09-17 |
| One row, one session | the user chose not to split enforcement per service | 2026-09-17 |
| A terminated tenant's in-flight payment | settles (`system`); a card-to-card confirmation by staff does not (`staffWrite`) | 2026-09-17 |
| Services other than auth-/billing-service | `notification-service` registers the guard; ticks are judged by `TenantStatusGate` (F-018-p). `bot-service` calls auth-/billing-service, which refuse. `gateway-service` judges only `read`, since a client frame only subscribes: a suspended tenant keeps its sockets; a **terminated** one is refused `403` at the upgrade and its open sockets close `4403` at once on the listener's `tenant:status-changed`, backstopped by the 60s re-check. Terminating revokes no session, so without this the socket lived as long as the session (F-018-r, `realtime/contract.md`) | 2026-09-18 |
| The platform owner reactivates a `non_payment`-suspended reseller without a payment | allowed; the period is still unpaid and past grace, so the next sweep suspends it again. To give time, grant grace (#15) — never a manual credit, which records money that never arrived | 2026-09-17 |
| A campaign already `sending` when its reseller is suspended or terminated | it finishes — `system`, like a payment already taken; only starting one is `staffWrite` (user, F-018-p) | 2026-09-17 |
| The reseller's owner, whose session is their platform tenant's (ADR-0059 (1)) | `TenantStatusGuard` would judge that always-active tenant, so a reseller self-service route judges the path's reseller with `tenantAllows` in `ResellerAccess` (invariant 21, F-061-h); the owner of a suspended reseller reads but does not write, as its staff would not. The platform owner's staff are not held to the reseller's matrix, except `terminated` | 2026-09-18 |
| A reseller that has not opened yet | closed for its users, open for its owner: the onboarding column, whose checklist (domain, gateway, bot, pricing) is computed from live rows and stored nowhere. Only the domain step gates — a reseller may sell before it connects a bot (F-018-l) | 2026-09-19 |
| The reseller's own staff (F-018-j), whose session **is** the reseller's | judged twice, and by the same matrix both times: `TenantStatusGuard` on their ambient tenant and `ResellerAccess` on the path's, which are the same tenant. So a suspended reseller's member lists its team (`read`) and seats nobody (`staffWrite`), exactly as its owner | 2026-09-19 |
| The platform owner wants those sends stopped too | a second call, notification's owner-only `POST .../campaigns/tenants/:tenantId/stop` (F-018-x), after the `sending-summary` heads-up: the campaigns move to `stopped` at the next delivery run's boundary, rows kept `queued`. A stopped campaign stays stopped on reactivation and is resumed by hand, never while the tenant is closed (user, F-018-q). Tenant administration itself does not reach campaigns (ADR-0058 (5), F-018-w) | 2026-09-17 |
