---
id: domains-index
status: active
updated: 2026-09-04
---

# Domains

Business logic. A unit belongs here if it has rules of its own **and** owns state.

| id | responsibility | status | depends_on |
|---|---|---|---|
| identity | users, RBAC, sessions, OTP, linked bots | active | audit, i18n, redis-keyspace |
| tenant | reseller white-label core + tenant billing | draft | identity, billing |
| billing | user wallet ledger, payments, coupons, affiliate | draft | identity, catalog, currency, tenant |
| currency | display-currency layer, rates, policies | draft | identity |
| catalog | categories, service plans, promotions | draft | tenant |
| network | panels (VPN infra), VPN configs, traffic, IP rules | draft | identity, catalog, tenant, billing |
| governance | user settings, temporal grants, restrictions | draft | identity |
| automation | worker registry + scheduling + run logs | draft | (none) |
| engagement | daily spin wheel + eligibility + cap | draft | identity, billing, fraud |
| support | tickets + live chat | draft | identity, audit |
| notification | notification hub + campaigns | draft | identity, tenant, automation |
| fraud | device fingerprints + fraud flags | draft | identity |
| audit | append-only admin log, impersonation, account switch | draft | identity |
| ai | recommendation engine + financial guardrails | draft | identity, billing, automation |

Copy `_TEMPLATE/` to create a new domain. Delete files that would be empty.
