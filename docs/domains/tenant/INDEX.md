---
id: tenant
layer: domain
status: active
version: 10
keywords: [tenant, reseller, white-label, branding, domain, entitlements, tenant billing, billing wallet, reseller balance, reseller wallet, prepaid balance, manual adjustment, reseller top-up, top up the billing wallet, reseller pays the platform, tenant_billing.topup, credit a reseller, debit a reseller, admin_manual_adjust, کیف پول نماینده, شارژ دستی نماینده, subscription domain, domain purpose, panel domain, assets domain, path allowlist, my subscription domain shows the login page, the panel loads on the wrong domain, sub domain serves the panel, host, hostname, custom domain, which tenant, tenant resolution, default tenant, tenant claim, wrong tenant, logged in on the wrong site, session does not belong to this address, X-Tenant-Id, unknown host, unknown domain, my domain returns 404, the api answers 404 on my domain, no fallback tenant, neutral 404, credential vault, vault, audit a decryption, who read the token, credential access log, refuses to boot, bot token in env, leftover env var, bot token, gateway key, api key, sms api key, sms line in the vault, SMS_API_KEY refuses to boot, secret, encryption, encrypted credential, DEK, KEK, rotate a credential, fingerprint, where do tenant secrets live, تنانت اشتباه, این نشست به این آدرس تعلق ندارد, دامنه ناشناخته, دامنه من ۴۰۴ می‌دهد, رمزنگاری اعتبارنامه, توکن ربات]
source:
  - txnet-backend/prisma/domains/tenant.prisma
  - txnet-backend/auth-service/src/app/tenant/**
  - txnet-backend/shared-core/src/lib/tenant/vault/**
  - txnet-backend/prisma/domains/migrations/20260909000000_credential_vault/**
  - txnet-backend/prisma/domains/migrations/20260909000100_credential_access_audit/**
  - txnet-backend/prisma/domains/migrations/20260909002000_tenant_domain_purpose/**
  - txnet-backend/prisma/domains/migrations/20260917000800_tenant_sms_config_vault/**
  - txnet-backend/auth-service/src/seed-sms-line.ts
  - txnet-backend/shared-core/src/lib/tenant/billing/**
  - txnet-backend/billing-service/src/app/tenant-billing/**
  - txnet-backend/prisma/domains/migrations/20260917000900_tenant_billing_wallet/**
owns_tables: [tenant, tenant_branding, tenant_domain, tenant_feature_package, tenant_feature_entitlement, tenant_staff_member, tenant_billing_wallet, tenant_billing_transaction, tenant_usage_meter, tenant_gateway_config, tenant_sms_config, tenant_restriction, tenant_credential, tenant_dek, tenant_credential_access]
depends_on: [identity, billing, redis-keyspace]
updated: 2026-09-17
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
| [contract.billing.md](contract.billing.md) | moving a reseller's billing balance |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-17 | contract v9 -> **v10** (additive): a reseller tops up its billing wallet online — `POST /api/billing/tenant-wallet/topup` and its gateway list, a payment in the platform owner's scope that settles into the billing wallet (F-019-b, ADR-0056). |
| 2026-09-17 | contract v8 -> **v9** (additive): the reseller billing wallet is implemented — `TenantBillingLedger` in shared-core, database CHECKs and a unique (reason, reference), and the platform owner's manual adjustment in billing-service. New topic file `contract.billing.md`; invariants 3, 14, 15 (F-019-a, D-41). |
| 2026-09-09 | contract v7 -> **v8** (additive): `tenant_domain` gains `purpose` (`panel`/`subscription`/`assets`, catalog 13.1 C-16) and resolution answers `surfacePurpose` when a host matched a row. A non-panel door resolves its tenant and serves no route of this process — the same neutral 404 an unknown host gets (F-066-q, spec: F-1212). |
| 2026-09-09 | contract v6 -> **v7** (breaking): `tenant_bot_integration` is **removed**, replaced by `automation.bot_integration` — several bots per tenant, with roles, and the token as a `credentialRef` instead of a column (F-066-h, spec: F-315 F-316). The table had never been written and no code had ever read it, so no shape is kept (§8). |
| 2026-09-09 | contract v5 -> **v6**: every decryption writes a `tenant_credential_access` row before it returns (invariant 11), and `CredentialEnvGuard` refuses the boot when an env var holds a tenant credential (invariant 12). `use(ref, caller)` -> `use(ref, {caller, actorId?})`; no call site existed. ADR-0026 rules 5-6. spec: F-1215 F-1216 |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
