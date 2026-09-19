---
id: tenant
layer: domain
status: active
version: 36
keywords: [tenant, reseller, onboarding gate, reseller not open yet, my reseller cannot sell, users cannot register on my panel, setup checklist, onboarding checklist, connect your domain first, tenantOnboarding, دروازه راه‌اندازی, نمایندگی هنوز باز نشده, کاربرهام نمی‌تونن ثبت‌نام کنن, چک‌لیست راه‌اندازی, staff seat, reseller staff, invite staff, add a colleague, remove a member, staff access expiry, time-bound access, tenant_staff_member, accept an invitation, کارمند نماینده, دعوت همکار, حذف عضو تیم, انقضای دسترسی کارمند, buy a reseller package, become a reseller, reseller purchase, خرید نمایندگی, reseller branding, brand name, upload a logo, dark logo, favicon, og image, brand colours, socials, support contact, /api/branding, برندینگ نماینده, آپلود لوگو, لوگوی نماینده, رنگ برند, add a custom domain, verify a domain, prove domain ownership, TXT record, _domain-verification, domain stuck verifying, domain verification failed, expected and found, domain dropped to pending, revalidating, CNAME target, tenant-domain-probe, دامنه اختصاصی, تایید دامنه, رکورد TXT, دامنه تایید نمیشه, subscription renewal, renew a reseller, charge a reseller, unpaid renewal, renewal grace, renewalGraceDays, give a reseller more time to pay, extend a reseller's grace, graceUntil, unpaid reseller keeps getting suspended, مهلت بیشتر به نماینده, تمدید مهلت پرداخت نماینده, suspended for non-payment, suspensionCause, reseller paid but still suspended, package_price_in_use, تمدید اشتراک نماینده, کسر اشتراک از کیف پول نماینده, تعلیق به دلیل بدهی, مهلت پرداخت اشتراک, suspend a reseller, reactivate a reseller, terminate a reseller, tenant status, suspended tenant, terminated tenant, graceEndsAt, suspensionHoldDays, tenant.suspended, status history, TenantStatusPolicy, TenantCapability, suspended reseller can still sell, تعلیق نماینده, فعال‌سازی دوباره نماینده, خاتمه نماینده, وضعیت نماینده, نماینده معلق هنوز می‌فروشد, apply a package to subscribers, force package features, package feature change, اعمال فوری پکیج روی همه, reseller subscription, put a reseller on a package, change a reseller's package, currentPeriodEnd, trial length, trialDays, package_included, اشتراک نماینده, تغییر پکیج نماینده, مدت دوره آزمایشی, reseller package, tenant package, feature package, package price, yearly price, deactivate a package, includedFeatureKeys, پکیج نماینده, قیمت پکیج, create a reseller, new reseller, list resellers, reseller administration, tenant.manage, ساخت نماینده, لیست نماینده‌ها, white-label, branding, domain, entitlements, tenant billing, billing wallet, reseller balance, reseller wallet, prepaid balance, manual adjustment, reseller top-up, top up the billing wallet, reseller pays the platform, tenant_billing.topup, tenant_billing.read, read a reseller's billing ledger, گردش حساب نماینده, credit a reseller, debit a reseller, admin_manual_adjust, کیف پول نماینده, شارژ دستی نماینده, subscription domain, domain purpose, panel domain, assets domain, path allowlist, console only, my panel 404s before my domain is verified, the platform subdomain serves nothing, users get 404 on the platform subdomain, bot login fails on the platform subdomain, زیردامنه پلتفرم ۴۰۴ می‌دهد, تا دامنه تایید نشود پنل سرو نمی‌شود, my subscription domain shows the login page, the panel loads on the wrong domain, sub domain serves the panel, host, hostname, custom domain, which tenant, tenant resolution, default tenant, tenant claim, wrong tenant, logged in on the wrong site, session does not belong to this address, X-Tenant-Id, unknown host, unknown domain, my domain returns 404, the api answers 404 on my domain, no fallback tenant, neutral 404, credential vault, vault, audit a decryption, who read the token, credential access log, refuses to boot, bot token in env, leftover env var, bot token, gateway key, api key, sms api key, sms line in the vault, SMS_API_KEY refuses to boot, secret, encryption, encrypted credential, DEK, KEK, rotate a credential, fingerprint, where do tenant secrets live, تنانت اشتباه, این نشست به این آدرس تعلق ندارد, دامنه ناشناخته, دامنه من ۴۰۴ می‌دهد, رمزنگاری اعتبارنامه, توکن ربات]
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
  - txnet-backend/shared-core/src/lib/tenant/entitlements.ts
  - txnet-backend/shared-core/src/lib/tenant/owner-cache.ts
  - txnet-backend/prisma/domains/migrations/20260917001500_tenant_status/**
  - txnet-backend/prisma/domains/migrations/20260917001600_tenant_subscription_renewal/**
  - txnet-backend/prisma/domains/migrations/20260917001700_tenant_subscription_grace/**
  - txnet-backend/prisma/domains/migrations/20260918000100_tenant_domain_verification/**
  - txnet-backend/prisma/domains/migrations/20260918000500_tenant_branding/**
  - txnet-backend/prisma/domains/migrations/20260918000600_reseller_purchase/**
  - txnet-backend/prisma/domains/migrations/20260919000100_tenant_billing_read/**
  - txnet-backend/prisma/domains/migrations/20260919000300_tenant_staff_member/**
  - txnet-backend/prisma/domains/migrations/20260919000400_tenant_onboarding_gate/**
owns_tables: [tenant, tenant_branding, tenant_domain, tenant_feature_package, tenant_subscription, tenant_subscription_setting, tenant_feature_entitlement, tenant_staff_member, tenant_billing_wallet, tenant_billing_transaction, tenant_usage_meter, tenant_gateway_config, tenant_sms_config, tenant_restriction, tenant_credential, tenant_dek, tenant_credential_access]
depends_on: [identity, billing, catalog, redis-keyspace]
updated: 2026-09-19
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
| [contract.onboarding.md](contract.onboarding.md) | asking why a reseller cannot sell yet, or what it still has to set up |
| [contract.staff.md](contract.staff.md) | putting someone on a reseller's team, or taking them off |
| [contract.branding.md](contract.branding.md) | editing or rendering a reseller's brand |
| [contract.entitlements.md](contract.entitlements.md) | gating a route on a feature key, or asking if a tenant has one |
| [rules.md](rules.md) | what a suspended or terminated tenant may do |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-19 | contract v35 -> **v36** (F-018-ai, ADR-0063): the door rule is who owns the host, not the gate — **every** reseller platform subdomain serves nothing, no Redis read; `tenantType` joins the cached surface, so no host the migration deleted lingers in `tenant:host:*` after the deploy. [contract.onboarding.md](contract.onboarding.md) |
| 2026-09-19 | contract v34 -> **v35** (**break**, F-018-ai, ADR-0063, user): a reseller has **one** platform host, its CNAME target `<slug>.edge.<domain>`, and it serves nothing — no `<slug>.<domain>` (migration deletes the old ones); the domain check's `http`/`https` lines pass only as the domain itself, so the reseller's CDN must keep the visitor's host. ArvanCloud setup: [contract.domains.md](contract.domains.md) |
| 2026-09-19 | contract v33 -> **v34** (**break**, F-066-x, D-01, user 2026-09-19): a gated reseller's platform `subdomain` serves **nothing** — its console left too; the reseller configures from the platform's panel. `gatedConsoleServesPath` is gone (`door.ts` `gatedDoor`). New `GET /api/auth/door` answers `{serves}` for the panel. [contract.onboarding.md](contract.onboarding.md) |
| 2026-09-19 | contract v32 -> **v33** (**break**, F-018-ag, D-01): while the onboarding gate is on, a reseller's platform `subdomain` serves its configuration console only — `gatedConsoleServesPath` (`auth-service/src/app/tenant/tenant.ts`), refused by `TenantGuard` with the neutral 404, keyed on the gate of the tenant that owns the *host*. Resolution answers `surfaceDomainType` beside `surfacePurpose`, so a `custom_domain` is never filtered; the platform owner is never gated, so the platform's own domain is never filtered (`contract.onboarding.md`). Consumers: none in the backend — the rule is `auth-service`'s own; panel-web needs the mirror and has no row yet |
| 2026-09-19 | contract v31 -> **v32** (additive, F-018-l, catalog F-213): the onboarding gate — `TenantOnboardingPolicy`, a column applied on top of a reseller's status while it has proved no `panel` custom domain, closing `register` / `sell` / `endUserDeposit` / `subscriptionLink` (`403 tenant.onboarding`); `tenant:status:<id>` gains a computed `onboarding` flag, and `GET /api/tenants/:id/onboarding` is the console's checklist (`contract.onboarding.md`). Consumers: auth-, billing-, notification-service, worker-service's gate and gateway-service's socket watch all inherit it through `tenantAllows` — no change in any of them; panel-web's console is not built yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
