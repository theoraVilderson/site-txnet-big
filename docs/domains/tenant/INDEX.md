---
id: tenant
layer: domain
status: active
version: 14
keywords: [tenant, reseller, apply a package to subscribers, force package features, package feature change, اعمال فوری پکیج روی همه, reseller subscription, put a reseller on a package, change a reseller's package, currentPeriodEnd, trial length, trialDays, package_included, اشتراک نماینده, تغییر پکیج نماینده, مدت دوره آزمایشی, reseller package, tenant package, feature package, package price, yearly price, deactivate a package, includedFeatureKeys, پکیج نماینده, قیمت پکیج, create a reseller, new reseller, list resellers, reseller administration, tenant.manage, ساخت نماینده, لیست نماینده‌ها, white-label, branding, domain, entitlements, tenant billing, billing wallet, reseller balance, reseller wallet, prepaid balance, manual adjustment, reseller top-up, top up the billing wallet, reseller pays the platform, tenant_billing.topup, credit a reseller, debit a reseller, admin_manual_adjust, کیف پول نماینده, شارژ دستی نماینده, subscription domain, domain purpose, panel domain, assets domain, path allowlist, my subscription domain shows the login page, the panel loads on the wrong domain, sub domain serves the panel, host, hostname, custom domain, which tenant, tenant resolution, default tenant, tenant claim, wrong tenant, logged in on the wrong site, session does not belong to this address, X-Tenant-Id, unknown host, unknown domain, my domain returns 404, the api answers 404 on my domain, no fallback tenant, neutral 404, credential vault, vault, audit a decryption, who read the token, credential access log, refuses to boot, bot token in env, leftover env var, bot token, gateway key, api key, sms api key, sms line in the vault, SMS_API_KEY refuses to boot, secret, encryption, encrypted credential, DEK, KEK, rotate a credential, fingerprint, where do tenant secrets live, تنانت اشتباه, این نشست به این آدرس تعلق ندارد, دامنه ناشناخته, دامنه من ۴۰۴ می‌دهد, رمزنگاری اعتبارنامه, توکن ربات]
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
  - txnet-backend/prisma/domains/migrations/20260917001100_tenant_create/**
  - txnet-backend/prisma/domains/migrations/20260917001200_tenant_feature_package/**
  - txnet-backend/prisma/domains/migrations/20260917001300_tenant_subscription/**
  - txnet-backend/prisma/domains/migrations/20260917001400_tenant_package_apply/**
  - txnet-backend/shared-core/src/lib/tenant/feature-keys.ts
owns_tables: [tenant, tenant_branding, tenant_domain, tenant_feature_package, tenant_subscription, tenant_subscription_setting, tenant_feature_entitlement, tenant_staff_member, tenant_billing_wallet, tenant_billing_transaction, tenant_usage_meter, tenant_gateway_config, tenant_sms_config, tenant_restriction, tenant_credential, tenant_dek, tenant_credential_access]
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
| [contract.admin.md](contract.admin.md) | creating, listing or reading a reseller, a package sold to one, or its subscription |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-17 | contract v13 -> **v14** (additive): a key added to a package reaches its subscribers in the edit; removals wait for renewal; `POST /api/auth/tenant-packages/:id/apply` forces the list now (F-018-o). |
| 2026-09-17 | contract v12 -> **v13** (additive): the platform owner puts a reseller on a package and period — `PUT/GET /api/auth/tenants/:id/subscription`, `tenant_subscription` (trial from the first package), `package_included` entitlements replaced; `trialDays` setting (F-018-e). |
| 2026-09-17 | contract v11 -> **v12** (additive): the platform owner creates, edits and deactivates the packages sold to resellers — `/api/auth/tenant-packages`, `yearlyPrice`, `TENANT_FEATURE_KEYS` (F-018-d). |
| 2026-09-17 | contract v10 -> **v11** (additive): the platform owner creates, lists and reads resellers — `POST/GET /api/auth/tenants`, tenant + owner + empty billing wallet + subdomain in one transaction, the first writer of `tenant_domain` to retract the host cache. New topic file `contract.admin.md` (F-018-c). |
| 2026-09-17 | contract v9 -> **v10** (additive): a reseller tops up its billing wallet online — `POST /api/billing/tenant-wallet/topup` and its gateway list, a payment in the platform owner's scope that settles into the billing wallet (F-019-b, ADR-0056). |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
