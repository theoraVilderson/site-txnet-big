---
id: tenant
layer: domain
status: active
version: 45
keywords: [quota overage, sell past a limit, quota or guard, overage price, stop or overage, سهمیه, اضافه مصرف, پرداخت اضافه, reseller limits, limit a reseller, set a limit for one reseller, set a limit for several resellers, package limits, محدودیت فروشنده, tenant, operating currency, tenant currency, reseller currency, books currency, change my currency, sell in rial, sell in euro, convert wallets on a currency change, currency_unavailable, rate_unavailable, currency_changed, ارز عملیاتی, ارز نماینده, تغییر ارز, فروش به ریال, reseller, onboarding gate, reseller not open yet, my reseller cannot sell, users cannot register on my panel, setup checklist, onboarding checklist, connect your domain first, tenantOnboarding, دروازه راه‌اندازی, نمایندگی هنوز باز نشده, کاربرهام نمی‌تونن ثبت‌نام کنن, چک‌لیست راه‌اندازی, staff seat, reseller staff, invite staff, add a colleague, remove a member, staff access expiry, time-bound access, tenant_staff_member, accept an invitation, کارمند نماینده, دعوت همکار, حذف عضو تیم, انقضای دسترسی کارمند, buy a reseller package, become a reseller, reseller purchase, خرید نمایندگی, reseller branding, brand name, line-name template, default config name, name in the VPN app, {brand} {region}, الگوی نام کانفیگ, اسم کانفیگ توی اپ, upload a logo, dark logo, favicon, og image, brand colours, socials, support contact, /api/branding, برندینگ نماینده, آپلود لوگو, لوگوی نماینده, رنگ برند, add a custom domain, verify a domain, prove domain ownership, TXT record, _domain-verification, domain stuck verifying, domain verification failed, expected and found, domain dropped to pending, revalidating, CNAME target, tenant-domain-probe, دامنه اختصاصی, تایید دامنه, رکورد TXT, دامنه تایید نمیشه, subscription renewal, renew a reseller, charge a reseller, unpaid renewal, renewal grace, renewalGraceDays, give a reseller more time to pay, extend a reseller's grace, graceUntil, unpaid reseller keeps getting suspended, مهلت بیشتر به نماینده, تمدید مهلت پرداخت نماینده, suspended for non-payment, suspensionCause, reseller paid but still suspended, package_price_in_use, تمدید اشتراک نماینده, کسر اشتراک از کیف پول نماینده, تعلیق به دلیل بدهی, مهلت پرداخت اشتراک, suspend a reseller, reactivate a reseller, terminate a reseller, tenant status, suspended tenant, terminated tenant, graceEndsAt, suspensionHoldDays, tenant.suspended, status history, TenantStatusPolicy, TenantCapability, suspended reseller can still sell, تعلیق نماینده, فعال‌سازی دوباره نماینده, خاتمه نماینده, وضعیت نماینده, نماینده معلق هنوز می‌فروشد, apply a package to subscribers, force package features, package feature change, اعمال فوری پکیج روی همه, reseller subscription, put a reseller on a package, change a reseller's package, currentPeriodEnd, trial length, trialDays, package_included, اشتراک نماینده, تغییر پکیج نماینده, مدت دوره آزمایشی, reseller package, tenant package, feature package, package price, yearly price, deactivate a package, includedFeatureKeys, پکیج نماینده, قیمت پکیج, create a reseller, new reseller, list resellers, reseller administration, tenant.manage, ساخت نماینده, لیست نماینده‌ها, white-label, branding, domain, entitlements, tenant billing, billing wallet, reseller balance, reseller wallet, prepaid balance, manual adjustment, reseller top-up, top up the billing wallet, reseller pays the platform, tenant_billing.topup, tenant_billing.read, read a reseller's billing ledger, گردش حساب نماینده, credit a reseller, debit a reseller, admin_manual_adjust, کیف پول نماینده, شارژ دستی نماینده, subscription domain, domain purpose, panel domain, assets domain, path allowlist, console only, my panel 404s before my domain is verified, the platform subdomain serves nothing, users get 404 on the platform subdomain, bot login fails on the platform subdomain, زیردامنه پلتفرم ۴۰۴ می‌دهد, تا دامنه تایید نشود پنل سرو نمی‌شود, my subscription domain shows the login page, the panel loads on the wrong domain, sub domain serves the panel, host, hostname, custom domain, which tenant, tenant resolution, default tenant, tenant claim, wrong tenant, logged in on the wrong site, session does not belong to this address, X-Tenant-Id, unknown host, unknown domain, my domain returns 404, the api answers 404 on my domain, no fallback tenant, neutral 404, credential vault, vault, audit a decryption, who read the token, credential access log, refuses to boot, bot token in env, leftover env var, bot token, gateway key, api key, sms api key, sms line in the vault, SMS_API_KEY refuses to boot, secret, encryption, encrypted credential, DEK, KEK, rotate a credential, fingerprint, where do tenant secrets live, تنانت اشتباه, این نشست به این آدرس تعلق ندارد, دامنه ناشناخته, دامنه من ۴۰۴ می‌دهد, رمزنگاری اعتبارنامه, توکن ربات]
source:
  - txnet-backend/prisma/domains/tenant.prisma
  - txnet-backend/auth-service/src/app/tenant/**
  - txnet-backend/tenant-service/**
  - txnet-backend/shared-core/src/lib/tenant/**
  - txnet-backend/prisma/domains/migrations/20260909000000_credential_vault/**
  - txnet-backend/prisma/domains/migrations/20261001000100_a_reseller_is_bounded_at_three_levels/**
  - txnet-backend/prisma/domains/migrations/20261001000200_tenant_restriction_is_removed/**
  - txnet-backend/prisma/domains/migrations/20261001000300_past_a_quota_stop_or_overage/**
  - txnet-backend/prisma/domains/migrations/20260909000100_credential_access_audit/**
  - txnet-backend/prisma/domains/migrations/20260909002000_tenant_domain_purpose/**
  - txnet-backend/prisma/domains/migrations/20260917000800_tenant_sms_config_vault/**
  - txnet-backend/auth-service/src/seed-sms-line.ts
  - txnet-backend/billing-service/src/app/tenant-billing/**
  - txnet-backend/prisma/domains/migrations/20260917000900_tenant_billing_wallet/**
  - txnet-backend/prisma/domains/migrations/20260917001100_tenant_create/**
  - txnet-backend/prisma/domains/migrations/20260917001200_tenant_feature_package/**
  - txnet-backend/prisma/domains/migrations/20260917001300_tenant_subscription/**
  - txnet-backend/prisma/domains/migrations/20260917001400_tenant_package_apply/**
  - txnet-backend/prisma/domains/migrations/20260917001500_tenant_status/**
  - txnet-backend/prisma/domains/migrations/20260917001600_tenant_subscription_renewal/**
  - txnet-backend/prisma/domains/migrations/20260917001700_tenant_subscription_grace/**
  - txnet-backend/prisma/domains/migrations/20260918000100_tenant_domain_verification/**
  - txnet-backend/prisma/domains/migrations/20260918000500_tenant_branding/**
  - txnet-backend/prisma/domains/migrations/20260918000600_reseller_purchase/**
  - txnet-backend/prisma/domains/migrations/20260919000100_tenant_billing_read/**
  - txnet-backend/prisma/domains/migrations/20260919000300_tenant_staff_member/**
  - txnet-backend/prisma/domains/migrations/20260919000400_tenant_onboarding_gate/**
  - txnet-backend/prisma/domains/migrations/20260926000900_a_reseller_names_its_lines/**
  - txnet-backend/prisma/domains/migrations/20260928002400_every_tenant_has_an_operating_currency/**
  - txnet-backend/prisma/domains/migrations/20260929001100_a_reseller_package_prices_platform_meters/**
owns_tables: [tenant, tenant_branding, tenant_domain, tenant_feature_package, tenant_subscription, tenant_subscription_setting, tenant_feature_entitlement, tenant_staff_member, tenant_billing_wallet, tenant_billing_transaction, tenant_usage_meter, tenant_gateway_config, tenant_sms_config, tenant_credential, tenant_dek, tenant_credential_access, reseller_limit_setting, package_limit, reseller_limit]
depends_on: [identity, billing, catalog, redis-keyspace]
updated: 2026-09-28
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
| [contract.limits.md](contract.limits.md) | what a reseller may spend of the platform's — the limit keys, quota or guard, their three levels, stop or overage past a quota, and setting them (F-019-m, F-019-v1) |
| [contract.admin.md](contract.admin.md) | creating, listing or reading a reseller, a package sold to one, or its subscription |
| [contract.domains.md](contract.domains.md) | adding or proving a reseller's custom domain |
| [contract.onboarding.md](contract.onboarding.md) | asking why a reseller cannot sell yet, or what it still has to set up |
| [contract.staff.md](contract.staff.md) | putting someone on a reseller's team, or taking them off |
| [contract.branding.md](contract.branding.md) | editing or rendering a reseller's brand |
| [contract.currency.md](contract.currency.md) | reading or setting the currency a tenant keeps its books in |
| [contract.public-routes.md](contract.public-routes.md) | adding a route nobody signs in to, or asking what one costs a stranger |
| [contract.entitlements.md](contract.entitlements.md) | gating a route on a feature key, or asking if a tenant has one; admitting a caller to a route that names a reseller |
| [rules.md](rules.md) | what a suspended or terminated tenant may do |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-10-01 | contract v44 -> **v45** (additive, F-019-v1, ADR-0107): registry `kind` quota/guard; `stop`/`overage` + unit price past a quota at three levels — `resellerOverageOf`, tables `quota_overage_setting`, `package_quota_overage`, `reseller_quota_overage`, `…/overage` routes ([contract.limits.md](contract.limits.md)) |
| 2026-10-01 | contract v43 -> **v44** (additive, F-019-m, ADR-0106): reseller limits at three levels — `RESELLER_LIMITS`, `resellerLimitOf`, tables `reseller_limit_setting`, `package_limit`, `reseller_limit`, and `/api/tenants/limits/…` ([contract.limits.md](contract.limits.md)) |
| 2026-09-28 | contract v42 -> **v43** (additive, F-311-aa, ADR-0102): `ResellerAccess.admitIncludingPlatform`/`runIncludingPlatform` — the users-admin routes reach the platform's own tenant, for its staff ([contract.entitlements.md](contract.entitlements.md)) |
| 2026-09-28 | contract v41 -> **v42** (**break**, F-116-f, ADR-0098 part 5): `PUT …/operating-currency` converts the tenant's live money instead of refusing; `changeable` and `tenant_has_money` are gone, `rate_unavailable` 503 and `currency_changed` 409 are new; four tenant <-> platform tables carry `currencyCode` ([contract.currency.md](contract.currency.md)) |
| 2026-09-28 | contract v40 -> **v41** (additive, F-116-a, ADR-0098): `tenant.operatingCurrencyCode` (default `USD`) and `GET`/`PUT /api/tenants/:id/operating-currency`, [contract.currency.md](contract.currency.md) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
