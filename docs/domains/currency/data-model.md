---
id: currency
layer: domain
updated: 2026-09-28
---

# Data model — currency

Source of truth: `txnet-backend/prisma/domains/currency.prisma` (Postgres schema
`currency`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| currency | ISO-4217 or internal code, symbol, decimals, base/selectable flags | no | permanent |
| currency_exchange_rate | append-only rate (USD -> this currency) with `source`, `effectiveAt`; a `manual_admin` row is a pin and also has `reason`, `expiresAt`, `setByAdminId` (CHECK `currency_exchange_rate_pin_shape`, F-0608-a) and, for a tenant's own pin, `tenantId` (CHECK `currency_exchange_rate_tenant_pin_only`, no FK; F-116-j). **Under RLS since F-116-j**: a row with no tenant is everyone's, a tenant's pin only that tenant's (`tenant_isolation`), `cross_tenant` sees all; unbound (the worker) sees the no-tenant rows only | no | permanent |
| currency_rate_pin_end | a pin ended before its expiry: `rateId` (unique), `endedById`, `endedAt`; insert-only (services hold `SELECT, INSERT`) | no | permanent |
| user_currency_preference | one active preferred display currency per user | via user | latest wins |
| currency_policy | admin lock (global or per-user) forcing a display currency | user-scoped rows | until changed |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| user_currency_preference.userId, currency_policy.userId | -> | identity.user.id | preferences/locks are per identity |

## Access rules

Read-mostly. Billing/UI ask this unit for a rate or a resolved currency; they do
not read the tables directly.

## Migration notes

Migration `20260928003400_a_platform_admin_pins_a_rate` (F-0608-a) added the
pin columns, the CHECK, `currency_rate_pin_end` and the `currency.pin`
permission. Base-currency uniqueness and the `currency_policy` partial unique index are
"section 99" manual SQL — not applied. Redis cache key `fx:rate:{code}`.
