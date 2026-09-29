---
id: entitlement
layer: domain
status: draft
version: 23
keywords: [grant, entitlement, name a service, rename a service, service name, buyer's name for a service, access, quota, quota adjustment, subscription token, free grant, feature key, purge, purge clock, suspended grant, panel seat, revive, top-up restores service, delivery, paid grant, being prepared, refund undelivered purchase, renewal, renew grant, carry-over, traffic debt, debt forgiven, not connected yet, never connected, unused service, activated, usage threshold, volume running low, 80 percent used, usage period, service ending soon, days left, expiry reminder, 7 days before end, idle service, unused for a week, trouble connecting, check-in, exhaustion forecast, runs out soon, at this rate, volume runs out in days, freeze, frozen service, unfreeze, pause a user's service, change a service's days, add days, extend a service, set the end date, duration history, reset traffic, reset a user's volume, delete a user's service, remove a service, cancel a user's service, refund the remainder, renew a user's service, admin renewal, one more period]
source: [txnet-backend/prisma/domains/entitlement.prisma, txnet-backend/prisma/domains/migrations/20260914001600_entitlement_grant/**, txnet-backend/prisma/domains/migrations/20260929000900_a_grants_rate_is_its_meters/**, txnet-backend/prisma/domains/migrations/20260921000600_a_grant_buys_its_bytes_before_it_serves_them/**, txnet-backend/prisma/domains/migrations/20260925000700_grant_delivery_clock/**, txnet-backend/prisma/domains/migrations/20260925001300_a_subscription_link_is_kept/**, txnet-backend/prisma/domains/migrations/20260926000400_an_unlimited_grant_says_so/**, txnet-backend/prisma/domains/migrations/20260927001100_a_grant_asks_if_it_connected/**, txnet-backend/prisma/domains/migrations/20260927001200_a_grant_counts_its_usage_period/**, txnet-backend/prisma/domains/migrations/20260927001300_a_grant_is_told_its_end_is_near/**, txnet-backend/prisma/domains/migrations/20260927001500_a_metered_grant_is_told_its_wallet_is_low/**, txnet-backend/prisma/domains/migrations/20260927001700_a_grant_is_told_before_its_purge/**, txnet-backend/prisma/domains/migrations/20260927001800_a_used_grant_checks_in_when_idle/**, txnet-backend/prisma/domains/migrations/20260927002000_a_grant_forecasts_its_volume/**, txnet-backend/prisma/domains/migrations/20260927002100_a_grant_is_frozen/**, txnet-backend/prisma/domains/migrations/20260928000100_a_grant_remembers_its_days/**, txnet-backend/prisma/domains/migrations/20260928000200_a_grant_resets_its_traffic/**, txnet-backend/prisma/domains/migrations/20260928000300_an_admin_gifts_bytes/**, txnet-backend/prisma/domains/migrations/20260928000400_an_admin_deletes_a_grant/**, txnet-backend/prisma/domains/migrations/20260928000500_an_admin_renews_a_grant/**, txnet-backend/prisma/domains/migrations/20260928002100_a_buyer_names_a_service/**, txnet-backend/prisma/domains/migrations/20260928002200_a_grant_remembers_when_its_end_was_set/**, txnet-backend/prisma/domains/migrations/20260929000400_a_grant_locks_its_meters/**, txnet-backend/prisma/domains/migrations/20260929001200_a_resellers_grant_locks_its_wholesale_rate/**, txnet-backend/prisma/domains/migrations/20260929001500_a_resellers_platform_bytes_are_counted_apart/**, txnet-backend/billing-service/src/app/entitlement/**]
owns_tables: [grant, quota_adjustment, grant_duration_change, grant_deletion, grant_renewal, grant_meter]
depends_on: [catalog, identity, tenant]
updated: 2026-09-29
---

# Entitlement

**Responsibility (one sentence):** Grants — the single answer to "may this
user use X" — with their one-way lifecycle, quotas and quota adjustments.
**Explicitly NOT responsible for:** what is for sale or its price (`catalog`),
taking money (`billing`), provisioning a config for a Grant (`network`).

Runs as a module inside `billing-service` (ADR-0049). Spec:
`python3 tools/spec.py --section 4.4` (and 4.5, 4.6).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing entitlement from outside |
| [contract.admin.md](contract.admin.md) | an admin's action on a Grant: freeze, days, traffic, reset, delete, issue, renew, devices (F-311) |
| [contract.retention.md](contract.retention.md) | a retention notice: not connected, usage or time thresholds (F-601) |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-29 | v22 -> **v23** (additive): a reseller's meter locks its wholesale leg — `grant_meter.wholesale*` (payer, package rate, price, currency, `wholesaleBilled`), all or none; refusal `wholesale_rate_missing` (F-118-n2, ADR-0105 (10)). See [contract.md](contract.md) |
| 2026-09-29 | v21 -> **v22** (additive): a Grant locks its meters — table `grant_meter` (terms locked, counters), written by `issue` per card in effect; refusal `meter_not_served` (F-118-e, ADR-0105). See [contract.md](contract.md) |
| 2026-09-28 | v20 -> **v21** (additive): a buyer names a service — `grant.userLabel` (CHECK `grant_user_label_shape`), `GrantService.setLabel`; the list answers `label`, `q` matches it, `grants/names` answers it before the config labels (F-307-x). See [contract.retention.md](contract.retention.md) |
| 2026-09-28 | v19 -> **v20** (additive): an admin sets a Grant's device limit — `setGrantDeviceLimit` writes `quotas.concurrent_devices.limit` and a `concurrent_devices` `quota_adjustment`, naming the panels that will not hold it; refusal `devices_unchanged` (F-311-q). See [contract.admin.md](contract.admin.md) |
| 2026-09-28 | v18 -> **v19** (additive): an admin renews a Grant in place — `renewGrantByAdmin`: one period of the plan (`grant.periodDays`, copied at issue) or a typed amount, `admin_grant`, no money; table `grant_renewal`, one row per request (F-311-d). See [contract.admin.md](contract.admin.md) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
