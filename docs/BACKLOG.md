---
id: backlog
status: active
updated: 2026-09-04
---

# Backlog

The single source of truth for **what is built and what is not**. One row per
shippable feature. Read together with `MASTER_INDEX.md` at the start of every
MODE: NEXT session — these two files are the entire resume state.

`status`: `todo` | `doing` | `done` | `blocked` | `dropped`
`done` means code exists and is reachable. Not "documented", not "planned".

Seeded 2026-09-04 by MODE: RECONCILE against the existing code. `done` rows are
proven by a code path. `todo` rows below F-017 are epic-sized placeholders
flagged `needs-decision` — each is replaced by real per-feature rows when its
area is pulled in with MODE: INGEST (§6d).

`spec ref` is the **feature catalog id** (`F-105`), never a line range — line
numbers shift on the first catalog edit. Resolve it with:

```bash
python3 tools/spec.py F-105     # the spec block for one feature
python3 tools/spec.py --todo    # catalog features with no backlog row yet
```

Note the two id namespaces: rows `F-001`…`F-041` are this backlog's own ids from
RECONCILE. Catalog ids (`F-101`…`F-1550`) arrive in the `spec ref` column, and
ingested rows reuse the catalog id verbatim as their row id.

| id | feature | unit | status | depends_on | spec ref | proof (code path) | note |
|---|---|---|---|---|---|---|---|
| F-001 | User registration + phone verification (OTP) | identity | done | — | — | txnet-backend/auth-service/src/app/auth/register/register.service.ts | issues a session on verify |
| F-002 | Password login + per-identifier lockout | identity | done | — | — | txnet-backend/auth-service/src/app/auth/auth.service.ts | 10 fails / 900s -> locked |
| F-003 | OTP login (SMS / Bale / Telegram channels) | identity | done | — | — | txnet-backend/auth-service/src/app/auth/otp/otp.service.ts | Redis is source of truth (ADR-0007) |
| F-004 | Session issue + refresh-token rotation | identity | done | — | — | txnet-backend/auth-service/src/app/auth/session/session.service.ts | Redis marker + Postgres record |
| F-005 | Password reset (OTP -> reset token) + global session revoke | identity | done | F-003 | — | txnet-backend/auth-service/src/app/auth/auth.service.ts | resetPassword() |
| F-006 | Admin impersonation start/end (audited) | audit | done | F-004 | — | txnet-backend/auth-service/src/app/impersonation/impersonation.service.ts | 30 min, reason >=10 chars, writes admin_audit_log |
| F-007 | ForwardAuth edge gate (JWT + session + RBAC -> identity headers) | forward-auth | done | F-004 | — | auth-handler/internal/api/handlers/handler.go | Traefik forwardauth middleware |
| F-008 | RBAC policy-file enforcement at the edge | forward-auth | done | F-007 | — | auth-handler/internal/auth/engine.go | auth-handler/configs/permissions.yaml |
| F-009 | Fixed-window rate limiting (Redis, atomic) | redis-keyspace | done | — | — | txnet-backend/auth-service/src/app/common/rate-limit/rate-limiter.ts | per-route decorator + global guard |
| F-010 | Shared Redis keyspace prefix + version | redis-keyspace | done | — | — | txnet-backend/auth-service/src/app/redis/redis.service.ts | mirrored in auth-handler/internal/config/config.go (ADR-0005) |
| F-011 | locale-service (gRPC) + fs watch + Watch stream | i18n | done | — | — | i18n-platform/services/locale-service/internal/server/server.go | :50051, source of truth (ADR-0003) |
| F-012 | Shared Go + Node locale clients | i18n | done | F-011 | — | i18n-platform/clients/go/client.go | @txnet/locale-client tarball for Node |
| F-013 | i18n namespace read endpoints (backend + frontend) | auth-api | done | F-012 | — | txnet-backend/auth-service/src/app/i18n/i18n.controller.ts | + site-pwa/src/app/api/i18n/[lang]/[ns]/route.ts |
| F-014 | auth HTTP API surface (/api/auth/*) + response envelope + i18n filter | auth-api | done | F-001 F-002 F-003 F-004 F-005 | — | txnet-backend/auth-service/src/app/auth/auth.controller.ts | zod pipes, sanitizeError, ref ids |
| F-015 | Panel auth screens (login / signup / OTP / forgot-password) | panel-web | done | F-014 | — | site-pwa/src/app/(auth)/auth/ | Next.js App Router |
| F-016 | Panel -> API proxy + in-memory access token + refresh cookie | panel-web | done | F-014 | — | site-pwa/src/app/api/auth/[...path]/route.ts | src/lib/auth-api.ts |
| F-017 | Prisma schema for all 14 business domains (Postgres multiSchema) | — | doing | — | — | txnet-backend/prisma/domains/ | schema authored; NO prisma/migrations committed, "section 99" RLS/partitioning NOT applied; PENDING: rename `Node` model -> `Panel` (glossary decision 2026-09-04) |
| F-018 | Tenant onboarding + white-label (branding, domains, entitlements, staff) | tenant | todo | — | — | | needs-decision: awaiting feature spec; split into sub-items on ingest |
| F-019 | Tenant<->platform billing (subscription + metered usage) | tenant | todo | F-018 | — | | needs-decision: spec pending |
| F-020 | User wallet + append-only ledger + sub-accounts | billing | todo | — | — | | needs-decision: spec + service boundary (D-2) |
| F-021 | Payment gateways + transactions (rial / card / crypto) + reconciliation | billing | todo | F-020 | — | | needs-decision: spec pending; event transport (D-3) |
| F-022 | Coupon engine (reserve / confirm state machine) | billing | todo | F-020 | — | | needs-decision: spec pending |
| F-023 | Wallet transfers (OTP-confirmed, atomic) | billing | todo | F-020 | — | | needs-decision: spec pending |
| F-024 | Affiliate referrals + commission ledger | billing | todo | F-020 | — | | needs-decision: spec pending |
| F-025 | Multi-currency display layer + exchange rates + currency policy | currency | todo | — | — | | needs-decision: base currency + seed undecided (D-1) |
| F-026 | Product catalog (categories, service plans, promotions) | catalog | todo | — | — | | needs-decision: spec pending |
| F-027 | Panel + Config provisioning (x-ui / Xray) | network | todo | F-026 | — | | needs-decision: spec pending; event transport (D-3); schema `Node`->`Panel` rename pending in F-017 |
| F-028 | Traffic accounting (partitioned raw log + daily aggregate) | network | todo | F-027 | — | | needs-decision: partitioning migration owner (D-5) |
| F-029 | Durable IP access rules | network | todo | — | — | | needs-decision: spec pending |
| F-030 | User settings + temporal access grants + restrictions | governance | todo | — | — | | needs-decision: access-resolver location undecided |
| F-031 | Background worker registry + scheduler + run logs | automation | todo | — | — | | needs-decision: runner (@nestjs/schedule vs external) undecided |
| F-032 | Daily spin wheel (strict eligibility + hard daily cap) | engagement | todo | F-020 | — | | needs-decision: spec pending |
| F-033 | Support tickets + threaded messages + attachments | support | todo | — | — | | needs-decision: object-storage contract undecided |
| F-034 | Live chat (user <-> admin, realtime) | support | todo | — | — | | needs-decision: realtime transport undecided |
| F-035 | Notification hub + campaigns + delivery adapters | notification | todo | F-031 | — | | needs-decision: delivery-adapter unit undecided |
| F-036 | Fraud fingerprints + periodic flag scanners | fraud | todo | F-031 | — | | needs-decision: fingerprint recipe + thresholds undecided |
| F-037 | Account-switch groups (user's own linked accounts) | audit | todo | — | — | | needs-decision: owning surface undecided |
| F-038 | AI recommendation engine + financial guardrails | ai | todo | F-031 F-020 | — | | needs-decision: generation approach undecided |
| F-039 | billing-service implementation (currently an empty Nx scaffold) | billing | todo | F-020 | — | | needs-decision: fold billing here vs a new service (D-2) |
| F-040 | Marketing site (coinsite) real content | marketing-web | todo | — | — | | needs-decision: keep separate vs merge into site-pwa |
| F-041 | DB migrations + "section 99" structural SQL (RLS, partitioning, partial unique idx, audit REVOKE) | — | todo | F-017 | — | | needs-decision: BLOCKING before first prod data — see docs/operations/migrations.md (D-5) |

## Rules
- Never delete a row. Move it to `dropped` with a reason in `note`.
- An item too big to finish in one session must be split into sub-items first.
- `blocked` requires the blocker named in `note` and a matching entry in the
  unit's `open-questions.md`.
- Ids are permanent. Never renumber.

## Decisions needed from the user
Items flagged `needs-decision` — the loop will not touch these until answered.

| id | question | asked on |
|---|---|---|
| D-1 | System base currency (IRT? IRR?) and its `decimalPlaces` — blocks F-025 and every money feature | 2026-09-04 |
| D-2 | Billing logic: fill the existing empty `billing-service`, or a new service? — blocks F-020..F-024, F-039 | 2026-09-04 |
| D-3 | Cross-domain event transport: synchronous calls, transactional outbox, or RabbitMQ? — blocks F-021, F-027, F-035, F-038 | 2026-09-04 |
| D-4 | Credential encryption mechanism (KMS / app-level key / cipher) for tenant + node secrets — blocks F-018, F-027 | 2026-09-04 |
| D-5 | Migration strategy: when does `prisma/migrations/` start, and who owns the hand-written partitioning/RLS SQL? — blocks F-028, F-041 | 2026-09-04 |
