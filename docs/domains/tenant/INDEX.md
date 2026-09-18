---
id: tenant
layer: domain
status: active
version: 27
keywords: [tenant, reseller, reseller branding, brand name, upload a logo, dark logo, favicon, og image, brand colours, socials, support contact, /api/branding, برندینگ نماینده, آپلود لوگو, لوگوی نماینده, رنگ برند, add a custom domain, verify a domain, prove domain ownership, TXT record, _domain-verification, domain stuck verifying, domain verification failed, expected and found, domain dropped to pending, revalidating, CNAME target, tenant-domain-probe, دامنه اختصاصی, تایید دامنه, رکورد TXT, دامنه تایید نمیشه, subscription renewal, renew a reseller, charge a reseller, unpaid renewal, renewal grace, renewalGraceDays, give a reseller more time to pay, extend a reseller's grace, graceUntil, unpaid reseller keeps getting suspended, مهلت بیشتر به نماینده, تمدید مهلت پرداخت نماینده, suspended for non-payment, suspensionCause, reseller paid but still suspended, package_price_in_use, تمدید اشتراک نماینده, کسر اشتراک از کیف پول نماینده, تعلیق به دلیل بدهی, مهلت پرداخت اشتراک, suspend a reseller, reactivate a reseller, terminate a reseller, tenant status, suspended tenant, terminated tenant, graceEndsAt, suspensionHoldDays, tenant.suspended, status history, TenantStatusPolicy, TenantCapability, suspended reseller can still sell, تعلیق نماینده, فعال‌سازی دوباره نماینده, خاتمه نماینده, وضعیت نماینده, نماینده معلق هنوز می‌فروشد, apply a package to subscribers, force package features, package feature change, اعمال فوری پکیج روی همه, reseller subscription, put a reseller on a package, change a reseller's package, currentPeriodEnd, trial length, trialDays, package_included, اشتراک نماینده, تغییر پکیج نماینده, مدت دوره آزمایشی, reseller package, tenant package, feature package, package price, yearly price, deactivate a package, includedFeatureKeys, پکیج نماینده, قیمت پکیج, create a reseller, new reseller, list resellers, reseller administration, tenant.manage, ساخت نماینده, لیست نماینده‌ها, white-label, branding, domain, entitlements, tenant billing, billing wallet, reseller balance, reseller wallet, prepaid balance, manual adjustment, reseller top-up, top up the billing wallet, reseller pays the platform, tenant_billing.topup, credit a reseller, debit a reseller, admin_manual_adjust, کیف پول نماینده, شارژ دستی نماینده, subscription domain, domain purpose, panel domain, assets domain, path allowlist, my subscription domain shows the login page, the panel loads on the wrong domain, sub domain serves the panel, host, hostname, custom domain, which tenant, tenant resolution, default tenant, tenant claim, wrong tenant, logged in on the wrong site, session does not belong to this address, X-Tenant-Id, unknown host, unknown domain, my domain returns 404, the api answers 404 on my domain, no fallback tenant, neutral 404, credential vault, vault, audit a decryption, who read the token, credential access log, refuses to boot, bot token in env, leftover env var, bot token, gateway key, api key, sms api key, sms line in the vault, SMS_API_KEY refuses to boot, secret, encryption, encrypted credential, DEK, KEK, rotate a credential, fingerprint, where do tenant secrets live, تنانت اشتباه, این نشست به این آدرس تعلق ندارد, دامنه ناشناخته, دامنه من ۴۰۴ می‌دهد, رمزنگاری اعتبارنامه, توکن ربات]
source:
  - txnet-backend/prisma/domains/tenant.prisma
  - txnet-backend/auth-service/src/app/tenant/**
  - txnet-backend/tenant-service/**
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
  - txnet-backend/shared-core/src/lib/tenant/status-policy.ts
  - txnet-backend/shared-core/src/lib/tenant/owner-cache.ts
  - txnet-backend/prisma/domains/migrations/20260917001500_tenant_status/**
  - txnet-backend/prisma/domains/migrations/20260917001600_tenant_subscription_renewal/**
  - txnet-backend/prisma/domains/migrations/20260917001700_tenant_subscription_grace/**
  - txnet-backend/prisma/domains/migrations/20260918000100_tenant_domain_verification/**
  - txnet-backend/prisma/domains/migrations/20260918000500_tenant_branding/**
owns_tables: [tenant, tenant_branding, tenant_domain, tenant_feature_package, tenant_subscription, tenant_subscription_setting, tenant_feature_entitlement, tenant_staff_member, tenant_billing_wallet, tenant_billing_transaction, tenant_usage_meter, tenant_gateway_config, tenant_sms_config, tenant_restriction, tenant_credential, tenant_dek, tenant_credential_access]
depends_on: [identity, billing, redis-keyspace]
updated: 2026-09-18
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
| [contract.domains.md](contract.domains.md) | adding or proving a reseller's custom domain |
| [contract.branding.md](contract.branding.md) | editing or rendering a reseller's brand |
| [rules.md](rules.md) | what a suspended or terminated tenant may do |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-18 | contract v26 -> **v27** (**break**, F-018-ab, ADR-0058 (2)): the vault's internal seams — `destroy-expired` and `gateway-credential*` — are `tenant-service`'s (`contract.vault.md`); `auth-service` reads the vault and serves no route on it. Consumers: automation (worker, `TENANT_API_BASE_URL`), billing (`TENANT_API_BASE_URL`/`_TIMEOUT_MS`), both in this change |
| 2026-09-18 | contract v25 -> **v26** (additive, F-018-h): a reseller's branding at `/api/tenants/:id/branding` (text + four image slots through object-storage) and public `GET /api/branding` by Host; `tenant_branding` holds keys, not URLs (migration `20260918000500_tenant_branding`). Consumers: panel-web (F-066-v), marketing-web (F-040), neither built yet |
| 2026-09-18 | contract v24 -> **v25** (**break**, F-061-i, ADR-0059 (6)): a session claim and a bot claim that disagree are `403 tenant.claimMismatch` instead of the session silently winning — except the bot tenant's owner, scoped to their own tenant with `brand` = the bot's. Consumers: bot-app (none relied on it; only the owner ever reaches it) |
| 2026-09-18 | contract v23 -> **v24** (additive, F-018-i): a reseller's owner or platform staff adds a custom domain at `/api/tenants/:id/domains`; the `tenant_domain_verification` sweep proves it (TXT + CNAME + http/https probe) and re-validates it; `GET /api/tenant-domain-probe` is public. New status `verifying`. Consumers: automation (the job); panel-web none yet (F-018-l) |
| 2026-09-18 | contract v22 -> **v23** (**break**, F-018-y, ADR-0058 (4)): reseller create/list/read are `tenant-service`'s at `/api/tenants*` (no `/auth`), and `POST` names an existing platform user as `ownerUserId` instead of creating one (`owner_not_found` 404, `owner_inactive` 409). Consumers: none yet (F-018-k, F-019-h are `todo`) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
