---
id: master-index
status: active
updated: 2026-09-04
---

# Master Index

Entry point for every task. One line per unit. **Never add detail here.**

Legend — `status`: `active` = implemented in code; `draft` = schema/intent only,
no service yet. A unit that is `active` with an empty `source:` is a lie and
`tools/docs-check.py` will fail on it.

## Domains — business logic, owns state
| id | one-line responsibility | status | doc |
|---|---|---|---|
| identity | users, RBAC roles/permissions, sessions, OTP, linked bot accounts | active | [->](domains/identity/INDEX.md) |
| tenant | multi-tenant / reseller white-label: branding, domains, entitlements, tenant billing, BYO integrations | draft | [->](domains/tenant/INDEX.md) |
| billing | user wallet ledger, sub-accounts, transfers, coupons, payment gateways/transactions, affiliate | draft | [->](domains/billing/INDEX.md) |
| currency | multi-currency display layer: exchange rates, user preference, admin currency policy | draft | [->](domains/currency/INDEX.md) |
| catalog | product categories, service plans, direct promotions | draft | [->](domains/catalog/INDEX.md) |
| network | panels (VPN infra) + drivers, user configs (Xray/VPN), panel groups, subscription links, traffic logs + aggregates, IP access rules | draft | [->](domains/network/INDEX.md) |
| governance | per-user settings, temporal access grants, user restrictions/caps | draft | [->](domains/governance/INDEX.md) |
| automation | definition + scheduling + run logs of background workers | draft | [->](domains/automation/INDEX.md) |
| engagement | daily spin wheel with hard financial cap + strict eligibility | draft | [->](domains/engagement/INDEX.md) |
| support | tickets, ticket messages/attachments, live chat | draft | [->](domains/support/INDEX.md) |
| notification | notification hub + campaigns + per-recipient delivery state | draft | [->](domains/notification/INDEX.md) |
| fraud | device fingerprints, central fraud flags + automatic actions | draft | [->](domains/fraud/INDEX.md) |
| audit | append-only admin audit log, impersonation sessions, account-switch groups | draft | [->](domains/audit/INDEX.md) |
| ai | recommendation engine with financial guardrails | draft | [->](domains/ai/INDEX.md) |

## Interfaces — outside-world touchpoints
| id | surface | status | doc |
|---|---|---|---|
| auth-api | NestJS auth-service HTTP API: `/api/auth/*`, `/api/i18n/*`, `/admin/*` impersonation | active | [->](interfaces/auth-api/INDEX.md) |
| panel-web | Next.js user panel (site-pwa): auth screens, locale/theme, API proxy | active | [->](interfaces/panel-web/INDEX.md) |
| marketing-web | Next.js public landing site (coinsite) | draft | [->](interfaces/marketing-web/INDEX.md) |

## Platform — cross-cutting, no business rules
| id | capability | status | doc |
|---|---|---|---|
| i18n | locale-service (gRPC source of truth) + shared Go/Node clients + `locales/` content | active | [->](platform/i18n/INDEX.md) |
| forward-auth | Go Traefik ForwardAuth gateway: JWT + Redis session + RBAC -> identity headers | active | [->](platform/forward-auth/INDEX.md) |
| redis-keyspace | shared Redis key prefix/versioning + session & OTP key catalog + TTLs | active | [->](platform/redis-keyspace/INDEX.md) |

## Cross-cutting docs
- [Surface map](SURFACES.md) — user-visible thing -> unit -> file. **Start here for any vague request.**
- [Code layout](CODE-LAYOUT.md) — the mirror rule / the roots of this monorepo; `.sync` marks the last point docs and code agreed
- [Conventions](CONVENTIONS.md) — house style, `C-nn` ids, and what is actually enforced
- [Agent setup](AGENT-SETUP.md) — running this on a tool other than Claude Code
- [Handoff](HANDOFF.md) — mid-item session state. Read it before `/next` if it is `active`.
- [Backlog](BACKLOG.md) — what is built vs not; read with this file for MODE: NEXT
- [Feature catalog manifest](features/MANIFEST.md) — the spec index. **Never open `features/App-Features.md`;** use `python3 tools/spec.py <F-id>`.
- [Feature format](FEATURES-FORMAT.md) — the contract the catalog satisfies
- [Architecture overview](architecture/overview.md)
- [Dependency graph](architecture/dependency-graph.md) — read before any change
- [Decisions (ADR)](architecture/decisions/)
- [Glossary](GLOSSARY.md) — check before naming anything
- [Operations](operations/INDEX.md)
- [Security](security/threat-model.md)
