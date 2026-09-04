---
id: threat-model
status: active
updated: 2026-09-04
---

# Threat model

Scope note: only `identity` + edge auth + i18n are implemented. Rows about
`billing`, `tenant`, `network` describe **intended** posture and current gaps.

## Assets (ranked)

1. User money — `billing.wallet` / ledgers, payment gateway credentials.
2. Tenant integration secrets — `tenant_gateway_config`, `tenant_bot_integration`
   (encrypted-at-rest, plaintext in memory).
3. Authentication material — password hashes, the shared JWT HMAC secret, refresh
   tokens, OTP codes.
4. Cross-tenant data confidentiality — one reseller must not see another's users,
   configs, or revenue.
5. VPN node control — `network.node.panelApiCredentials`.
6. Audit integrity — `audit.admin_audit_log` must be tamper-evident.

## Trust boundaries

| Boundary | Untrusted input crosses here | Validation point |
|---|---|---|
| Browser -> Traefik | all request data, `X-User-*` spoof attempts | Traefik `strip-fake-headers` removes client identity headers |
| Traefik -> auth-handler `/validate` | the Bearer token | HMAC-SHA256 (HS256 only) + `exp` + Redis session + RBAC file |
| auth-handler -> upstream services | `X-User-Id` / `X-Tenant-Id` / `X-Role-Id` / `X-User-Permissions` | upstream **trusts** these — they are only set after validation |
| Service -> Postgres | query parameters | Prisma parameterization; zod on request bodies |
| Service -> locale-service | none (internal, private network, no auth) | network isolation only |
| Bot webhooks (Bale/Telegram) | inbound webhook payloads | per-tenant `webhookPath` isolation (planned) |

## Tenancy isolation

**The single most important row, and currently the weakest.** Every
tenant-scoped table carries `tenantId`, but isolation today depends entirely on
application code adding the right `WHERE tenantId = ?`. The structural controls
specified in the schema's "section 99" — Postgres Row-Level Security, partial
unique indexes, multi-column CHECK constraints, native partitioning — are
**not applied**. Until they are, a missing filter in any query is a cross-tenant
leak. See ADR-0001 and `operations/migrations.md`.

## Secrets

| Secret | Storage | Rotation | Blast radius if leaked |
|---|---|---|---|
| JWT HMAC secret (`JWT_ACCESS_SECRET` == `JWT_SECRET`) | env / compose `.env.*` | manual, requires coordinated redeploy of auth-service + auth-handler | forge any access token until rotated |
| `JWT_REFRESH_HASH_SECRET` | env | manual | forge refresh-token hashes |
| Redis password | env | manual | read all sessions/OTP; DoS |
| Postgres password | env | manual | full data access |
| Tenant gateway / bot / SMS credentials | DB columns marked "Encrypted" (cipher + key mechanism **undecided** — open question in `tenant`) | per tenant | that tenant's payment / bot takeover |
| Node panel API credentials | `network.node` (encrypted, planned) | per node | node takeover |
| Traefik dashboard / registry htpasswd | `.env.*` | manual | ops-plane access |
| ACME account / certs | `dev_letsencrypt/acme.json` | automatic (Let's Encrypt) | cert misissue |

## Accepted risks

| Risk | Why accepted | Revisit trigger |
|---|---|---|
| One symmetric JWT secret shared by two services | single internal issuer; simplicity (ADR-0004) | a third issuer, or a compliance requirement for key rotation without downtime |
| `locale-service` has no authN/authZ | internal-only, private Docker network, non-secret data | any consumer outside the private network |
| Tenancy isolation is app-code-only for now | pre-launch, no real tenants yet | before onboarding the first external reseller / first prod data |
| Redis outage fails auth closed (availability hit) | correctness over availability for auth | if auth availability SLO is threatened |
| `admin_audit_log` append-only is convention, not a DB grant | low current admin surface | before first external admin / SOC2-style requirement |
