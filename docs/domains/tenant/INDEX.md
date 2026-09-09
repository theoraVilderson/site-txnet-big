---
id: tenant
layer: domain
status: active
version: 7
keywords: [tenant, reseller, white-label, branding, domain, entitlements, tenant billing, host, hostname, custom domain, which tenant, tenant resolution, default tenant, tenant claim, wrong tenant, logged in on the wrong site, session does not belong to this address, X-Tenant-Id, unknown host, unknown domain, my domain returns 404, the api answers 404 on my domain, no fallback tenant, neutral 404, credential vault, vault, audit a decryption, who read the token, credential access log, refuses to boot, bot token in env, leftover env var, bot token, gateway key, api key, secret, encryption, encrypted credential, DEK, KEK, rotate a credential, fingerprint, where do tenant secrets live, تنانت اشتباه, این نشست به این آدرس تعلق ندارد, دامنه ناشناخته, دامنه من ۴۰۴ می‌دهد, رمزنگاری اعتبارنامه, توکن ربات]
source:
  - txnet-backend/prisma/domains/tenant.prisma
  - txnet-backend/auth-service/src/app/tenant/**
  - txnet-backend/prisma/domains/migrations/20260909000000_credential_vault/**
  - txnet-backend/prisma/domains/migrations/20260909000100_credential_access_audit/**
owns_tables: [tenant, tenant_branding, tenant_domain, tenant_feature_package, tenant_feature_entitlement, tenant_staff_member, tenant_billing_wallet, tenant_billing_transaction, tenant_usage_meter, tenant_gateway_config, tenant_sms_config, tenant_restriction, tenant_credential, tenant_dek, tenant_credential_access]
depends_on: [identity, billing, redis-keyspace]
updated: 2026-09-09
---

# Tenant

**Responsibility (one sentence):** the multi-tenant / reseller white-label core —
a Tenant's identity, branding, domains, feature entitlements, platform-side
billing, and bring-your-own gateway / SMS / bot integrations.
**Explicitly NOT responsible for:** end-user wallets or payments (`billing`),
end-user RBAC (`identity`), product pricing (`catalog`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing tenant from outside |
| [contract.vault.md](contract.vault.md) | storing or reading a tenant-owned secret |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-09 | contract v6 -> **v7** (breaking): `tenant_bot_integration` is **removed**, replaced by `automation.bot_integration` — several bots per tenant, with roles, and the token as a `credentialRef` instead of a column (F-066-h, spec: F-315 F-316). The table had never been written and no code had ever read it, so no shape is kept (§8). |
| 2026-09-09 | contract v5 -> **v6**: every decryption writes a `tenant_credential_access` row before it returns (invariant 11), and `CredentialEnvGuard` refuses the boot when an env var holds a tenant credential (invariant 12). `use(ref, caller)` -> `use(ref, {caller, actorId?})`; no call site existed. ADR-0026 rules 5-6. spec: F-1215 F-1216 |
| 2026-09-09 | contract v4 -> **v5** (additive): the **Credential Vault** is implemented — `tenant_credential` + `tenant_dek`, one DEK per tenant wrapped by a KEK from a mounted file (ADR-0026, superseding ADR-0022). New topic file `contract.vault.md` (§10); invariants 8-10 are this unit's first *enforced* ones. spec: F-1213 F-1214 F-1217 F-1207 |
| 2026-09-09 | contract v3 -> **v4** (breaking): the fallback tenant is gone in every environment — a host that matches no `tenant_domain` row, on a request with no claim, resolves to nothing and gets a neutral 404 from `TenantGuard` (renamed from `TenantAgreementGuard`, which now carries both refusals). ADR-0025 supersedes ADR-0020. spec: F-1210 |
| 2026-09-09 | contract v2 -> **v3** (breaking): `resolve(host)` becomes `resolve(claim)` — session, then bot, then verified host — and a claim that disagrees with its surface is refused, not reconciled (ADR-0024 decision 4, ADR-0025). One in-process caller, updated here. spec: F-1208 F-1209 |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
