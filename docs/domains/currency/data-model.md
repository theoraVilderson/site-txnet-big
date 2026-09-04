---
id: currency
layer: domain
updated: 2026-09-04
---

# Data model — currency

Source of truth: `txnet-backend/prisma/domains/currency.prisma` (Postgres schema
`currency`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| currency | ISO-4217 or internal code, symbol, decimals, base/selectable flags | no | permanent |
| currency_exchange_rate | append-only rate (base -> this currency) with `source`, `effectiveAt` | no | permanent |
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

Base-currency uniqueness and the `currency_policy` partial unique index are
"section 99" manual SQL — not applied. Redis cache key `fx:rate:{code}`.
