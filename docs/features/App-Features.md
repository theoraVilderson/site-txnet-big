# TXNet — Complete Features Catalog (Version 3 — Consolidated)

> Document assumption: the platform is fully implemented and all features are active.
> Feature IDs `F-xxx` from v2 have been retained so as not to break references in BLUEPRINT and PROGRESS.
> IDs `C-xx` are resolved conflicts, and IDs `D-xx` are foundational decisions.

**Status Column Guide:**

| Label        | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `base`       | Described in v1 and unchanged                                           |
| `new`        | Added in v2 and integrated into the architecture here                   |
| `changed`    | The v1 decision was reversed — the reason is in the conflicts table     |
| `partial`    | Infrastructure exists in v1; the interface or logic is not yet complete |
| `next-phase` | Schema is built from day one; implementation is deferred                |

---

## Section 0 — Foundational Decisions

These five decisions sit above every other section. Wherever this document conflicts with them, they win.

| #        | Decision                                                                                                                                                                                                         | Why                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-01** | **No platform domain or subdomain is ever served to an end user.** A custom domain is mandatory for _every_ plan — from the cheapest to the most expensive.                                                      | If one rogue tenant's domain gets filtered while sitting on your domain, it takes the whole platform down with it. The blast radius must be exactly one tenant. |
| **D-02** | **Bot parity with the web panel is an architectural rule, not a goal.** Every feature is defined on a single `ActionRegistry`; the web app and the bot are merely renderers.                                     | If the bot is a "second-class client," within six months half the features exist only on the web.                                                               |
| **D-03** | **The platform never touches end-user money and never holds an AI key.** The payment gateway, the model key, the domain, the bot, and the trust badge all belong to the tenant. The platform is purely software. | Complete elimination of payment-facilitator obligations and one whole layer of legal liability — the same stance taken on white-labeling.                       |
| **D-04** | **AI is a decorative layer on top of a deterministic base, never a dependency.** Every path where AI participates has a rule-based fallback that works perfectly without AI.                                     | The factory default is "no AI," and the product is fully functional.                                                                                            |
| **D-05** | **Traffic is always prepaid. Withdrawal never exists.** No traffic credit, no debt, no payout.                                                                                                                   | Eliminates collections, KYC/AML obligations, and the single largest fraud vector.                                                                               |

---

## Section 0.1 — Resolved Conflicts

This table records precisely where v1 and v2 (or v1 with itself) contradicted each other, and what was decided. Every row here has been applied throughout the body of the document.

| #        | Conflict                                                                                                                                                                                                                                                                                                                                            | Resolution                                                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C-01** | v1 §14.2 gave Starter a "subdomain," and v1 §15.5 defined the tenant-detection chain as "custom domain → **platform subdomain** → header." D-01 violates both.                                                                                                                                                                                      | The platform subdomain is **removed entirely**. Chain: "verified custom domain → `X-Tenant-Id` header, on platform-staff tokens only." Until domain verification, the tenant operates only from the **onboarding console** on the platform domain, where no end user is ever served.                                |
| **C-02** | v1 example §3.10: "Starter reseller has no custom domain" — false after D-01.                                                                                                                                                                                                                                                                       | The example changed to `checkLimit(ctx, 'limit.domains', n)`. Domain is no longer a plan feature; the **number** of domains is a plan limit.                                                                                                                                                                        |
| **C-03** | v1 §13.1 doesn't route the domain until `terms`/`privacy`/`contact` are published, yet the v1 plan table gave Starter "public pages: —." That meant Starter could structurally never go live.                                                                                                                                                       | The three legal pages are mandatory and present on **every plan**. The plan limit applies only to **additional** pages (`about`, `faq`, `refund`).                                                                                                                                                                  |
| **C-04** | v1 §13.5 served uploads from a "separate asset origin" — which was actually a **shared platform host**. This violates both D-01 and F-107/F-108 (anti-fingerprinting).                                                                                                                                                                              | The asset origin is now **per-tenant**, on the tenant's own domain (e.g. `assets.<tenant-domain>`), with a `Content-Security-Policy` header and no cookies. The security property "separate from the app origin" is preserved; cross-tenant sharing is eliminated.                                                  |
| **C-05** | v1 §10.1 had a unique key of `(tenantId, platform)`; F-315 wants multiple bots per tenant.                                                                                                                                                                                                                                                          | The unique key changed to `(tenantId, platform, botUsername)`, and a `role: primary                                                                                                                                                                                                                                 | sales | support | secondary`field was added. Exactly **one**`primary`bot is allowed per`(tenantId, platform)` — the same one used for OTP flows and transaction alerts. |
| **C-06** | v1 §7.5 says the `/sub` path **never writes to the database**; F-402 (ISP-based routing) needs a success signal recorded per (ISP × inbound).                                                                                                                                                                                                       | The signal is collected **fully asynchronously**: the `/sub` path only does an `INCR` on Redis and drops an event in a buffer. Aggregation happens in a separate worker. The hot path still has **zero synchronous Postgres writes** and stays under 50ms at p99.                                                   |
| **C-07** | The link cache in v1 was keyed by `(grantId, healthyPanelSetHash)`; F-105 adds an alternate domain list to the response body, and F-113 separates the `/sub` domain. A stale cache means dead-domain bleed. On top of that, v1's rate limit (60 requests/minute per token) breaks down once `Profile-Update-Interval` is shortened during a crisis. | The cache key became `(grantId, healthyPanelSetHash, activeDomainSetHash, format)`, and it is **explicitly** invalidated on any domain status change. The token rate limit is now tied to "at least 3× the shortest currently active `Profile-Update-Interval`," not a fixed number.                                |
| **C-08** | v1 §7.5 only supported manual output format via `?format=`; F-406 wants auto-detection.                                                                                                                                                                                                                                                             | Auto-detection from `User-Agent` is now the **default**, and `?format=` remains an **explicit override** (C-08). Unknown UA → base64-URI format (the safest mode).                                                                                                                                                  |
| **C-09** | v1 §4.4 makes Grant transfers one-way, and a spent Grant never comes back to life; F-604 (rollover of unused volume) appears to violate this.                                                                                                                                                                                                       | Rollover **never revives the old Grant**. The remaining allowance is written as a single `QuotaAdjustment` row on the **new** Grant, with a percentage cap and an independent expiry. The `promotional_liability` account carries this debt.                                                                        |
| **C-10** | v1's appendix **permanently** deleted the "free test node pool"; F-705 wants free testing.                                                                                                                                                                                                                                                          | Free testing of the **platform** remains deleted. Free testing **funded by the tenant's own resources** (own panel or own traffic wallet) is allowed and first-class. The platform gives away no gigabytes.                                                                                                         |
| **C-11** | v1 §20.2 put the referral system in "next-phase"; F-701 moves it forward.                                                                                                                                                                                                                                                                           | The referral system entered the **core**. The reward is **volume only**, never cash — consistent with D-05 (no withdrawal) and requiring no KYC.                                                                                                                                                                    |
| **C-12** | v1 §20.4: "`ai` schema empty, next-phase"; v2 section 15 defines a full AI layer.                                                                                                                                                                                                                                                                   | AI entered the core, **but as BYO and off by default** (D-04). The platform holds no key and bears no inference cost.                                                                                                                                                                                               |
| **C-13** | F-1501 describes the "attention budget" as a "ledger-like wallet." Taken literally, it would enter `LedgerEntry` and pollute §5.2 (two separate money trees).                                                                                                                                                                                       | The attention budget lives in its own **separate table**, `engagement.AttentionBudget`. It is **never** a `LedgerAccount` or `LedgerEntry`. The ledger is money only.                                                                                                                                               |
| **C-14** | v1 §5.6: "amount mismatch = human review" and "server-side confirmation only"; F-803/F-804 wants automatic card-to-card matching.                                                                                                                                                                                                                   | Automatic matching happens **only** with a **definitive triple match**: exact unique amount + destination account + time window. Any deviation (underpayment, overpayment, duplicate amount, outside window) → human review queue, exactly like crypto.                                                             |
| **C-15** | v1 has no reseller hierarchy, and the `tenantId` ownership model is flat; F-901..F-907 wants a reseller tree from day one.                                                                                                                                                                                                                          | A reseller is a **node in the `identity.ResellerNode` tree** inside the same tenant (path stored as `ltree`), and RLS is enforced via `tenantId` + path prefix. For F-907 (separate brand and bot), a reseller is promoted to a **child tenant** with its own domain and gateway — itself subject to D-01 and D-03. |
| **C-16** | v1 §13.7 forces all API calls to be same-origin; F-113 separates the `/sub` domain from the panel domain.                                                                                                                                                                                                                                           | Domain roles are split: the **panel domain** is same-origin and cookie-bearing; the **subscription domain** is a completely independent origin, with **absolutely no cookies**, no CORS to the panel, and authenticated only by a subscription token in the path. No session ever crosses from that origin.         |
| **C-17** | v1 §7.5's "proxy link native to the panel" only applied to our own registered panels; F-203 (adopting a legacy link) wants the same mechanism for an **external** panel.                                                                                                                                                                            | The same mechanism was generalized: `LegacyUpstream(tenantId, url, credentialRef, status)`. The token is still ours, the upstream URL is never shown to the user, and the upstream is parsed as **adversarial input** (volume cap, config-count cap, timeout, no following redirects into internal networks).       |
| **C-18** | v1 §7.2 sends a tenant's panel alert to that tenant itself; F-1207 ("route alert to panel owner") is the same idea, but v2 marked it "present" while leaving reseller panels undefined.                                                                                                                                                             | The rule was generalized: the alert goes to the **owner of the panel record**, which can now also be a reseller node. The platform's on-call team is only paged for panels with `ownershipType = platform`.                                                                                                         |
| **C-19** | The v1 plan table gave Starter "dedicated gateway: —," yet the v1 appendix says "the platform never pays out to end users." That meant Starter had structurally no way to receive money unless the platform acted as intermediary — exactly what is being eliminated.                                                                               | **A dedicated gateway is mandatory on every plan** (D-03). Plans differ in the **number** of gateways and access to advanced methods (multi-account card-to-card, bank SMS parsing), not in whether a gateway exists at all.                                                                                        |

---

## Table of Contents

- [Section 1 — Multilingual and Localization](#section-1--multilingual-and-localization)
- [Section 2 — Identity, Login and Account Security](#section-2--identity-login-and-account-security)
- [Section 3 — Access Control (RBAC) and Time-Bounded Access](#section-3--access-control-rbac-and-time-bounded-access)
- [Section 4 — Product Model, Catalog and Sales Engine](#section-4--product-model-catalog-and-sales-engine)
- [Section 5 — Wallet, Ledger and Payment](#section-5--wallet-ledger-and-payment)
- [Section 6 — Dollar Pricing and FX Rate Engine](#section-6--dollar-pricing-and-fx-rate-engine)
- [Section 7 — Network Service: Supply, Stability and Connection Intelligence](#section-7--network-service-supply-stability-and-connection-intelligence)
- [Section 8 — Usage Measurement and Usage Billing](#section-8--usage-measurement-and-usage-billing)
- [Section 9 — Multichannel Notifications and Campaigns](#section-9--multichannel-notifications-and-campaigns)
- [Section 10 — Bot as a Full Panel](#section-10--bot-as-a-full-panel)
- [Section 11 — Unified Support](#section-11--unified-support)
- [Section 12 — Realtime](#section-12--realtime)
- [Section 13 — White-Label, Domain and Resilience Against Filtering](#section-13--white-label-domain-and-resilience-against-filtering)
- [Section 14 — Panel Business: Plans, Subscriptions and Traffic Wallet](#section-14--panel-business-plans-subscriptions-and-traffic-wallet)
- [Section 15 — Multi-Tier Reseller](#section-15--multi-tier-reseller)
- [Section 16 — Migration, Import and Onboarding](#section-16--migration-import-and-onboarding)
- [Section 17 — Retention, Anti-Churn and Growth](#section-17--retention-anti-churn-and-growth)
- [Section 18 — Reseller Profitability Tools](#section-18--reseller-profitability-tools)
- [Section 19 — Security, Fraud and Abuse](#section-19--security-fraud-and-abuse)
- [Section 20 — Governance, Isolation, Treasury and Audit](#section-20--governance-isolation-treasury-and-audit)
- [Section 21 — Platform Management Console](#section-21--platform-management-console)
- [Section 22 — Public API and Integration](#section-22--public-api-and-integration)
- [Section 23 — Monitoring, Reconciliation and Operations](#section-23--monitoring-reconciliation-and-operations)
- [Section 24 — The AI Layer](#section-24--the-ai-layer)
- [Section 25 — Next-Phase Features](#section-25--next-phase-features)
- [Appendix A — Permanent Decisions](#appendix-a--permanent-decisions-out-of-scope)
- [Appendix B — Mapping v2 IDs](#appendix-b--mapping-of-v2-ids-to-sections-of-this-document)

---

## Section 1 — Multilingual and Localization

### 1.1 Language as Data, Not Code

In most existing panels, language is an `enum` in the code — meaning adding a new language requires a code change, a database migration, and a redeploy. In TXNet, language is entirely data. Nowhere — not in Prisma, not in TypeScript, not in Go — is there a closed list of languages.

Business consequence: going from 2 languages to 30 languages is a **content operation**, not an engineering project.

### 1.2 Dedicated Translation Service (locale-service)

An independent Go service over gRPC that is the single source of truth for all translations:

- **`GetSnapshot`** — every service caches the full set of translations in memory on startup
- **`Watch`** — translation changes are pushed to every service as a stream; no restart needed
- Changing one string in the admin panel takes effect in the backend, frontend, and bots within seconds

### 1.3 Translation Namespacing and Scoping

Translations are split across 11 namespaces: `common`, `messages`, `auth`, `errors`, `billing`, `network`, `support`, `notification`, `admin`, `email`, `bot` — and across three domains: `backend`, `frontend`, `bot`.

Each client only receives its own domain; the Telegram bot never downloads the volume of translations belonging to the admin panel.

### 1.4 Type-Safe i18n

Translation keys are **code-generated with their variable signature**. If a key's text contains `{{count}}` and `{{name}}`, the generated function takes exactly those two arguments.

- Calling a parameterized key without arguments → a **compile error** in both `tsc` and `go build`
- CI checks in **both directions**: every key used in code must exist in the reference language, and every key in the reference language must exist in every active language with the same `{{vars}}`

### 1.5 RTL/LTR and Numeral Localization

Every language has a `metadata.json` containing `{ code, name, nativeName, direction, numberSystem, enabled }`. Page direction is driven by this data — nowhere is `if (lang === 'fa') rtl` hardcoded.

### 1.6 Language Detection Chain

**Explicit user preference → `Accept-Language` negotiation → tenant default language → platform default (fa)**

Bot language is stored **independently of panel language**, per user (F-320).

### 1.7 Ambient Brand Variables

Brand name, support link, and tenant details are automatically injected into **every `t()` call**. Nowhere in the code are they passed manually.

In a white-label product, the worst possible bug is the platform's brand name appearing on a reseller's site. With this design, that error is structurally impossible.

### 1.8 Full Text Override by Tenant

| #      | Feature                                                                                                | Status |
| ------ | ------------------------------------------------------------------------------------------------------ | ------ |
| F-317  | Bot text, menus, emoji and buttons fully overridable by the tenant (override within its own namespace) | base   |
| F-1545 | Brand-tone prompt as **data** in `locale-service`, versioned                                           | new    |
| F-1533 | Automatic translation of locale content for new languages, with **mandatory human review**             | new    |

---

## Section 2 — Identity, Login and Account Security

### 2.1 Registration and Login

- Registration with `fullName`, `username`, `phoneNumber`, `password`
- The account receives no token until **phone number verification**; unverified accounts older than 24 hours are purged by a cron job
- Login with **username or mobile number + password**, or directly via **OTP**
- Username and number uniqueness is scoped **per tenant** — `(tenantId, username)` and `(tenantId, phoneNumber)`

> **Note on C-15:** Uniqueness is at the **tenant** level, not the reseller-node level. Two resellers under the same tenant log in on one domain; if uniqueness moved to the reseller level, two users named `ali` would collide on one login page.

- **Full registration and login inside the bot** is also supported (F-303) — the user never has to open a browser

### 2.2 Password Policy

- At least 8 characters, including uppercase, lowercase, digit, and symbol
- Rejected if the password contains the username, full name, or phone number
- **Checked against a leaked-password database (HIBP)** using k-anonymity — only the first 5 characters of the hash are sent
- Hashed with **argon2id** (not bcrypt, not SHA)

### 2.3 OTP System

Redis is the source of truth; the database table is only for history and audit.

**Five distinct use cases:** `login`, `register_phone_verify`, `password_reset`, `wallet_transfer`, `account_link` — each with its own independent cooldown and counter.

**Three channels:** SMS, Telegram, Bale. If the user has no linked messenger account, it automatically falls back to SMS — and it never reveals through one channel that another channel exists.

**Issuance flow:** atomic lock `SET NX EX 2` → 60-second cooldown check → generate 6 digits with `crypto.randomInt` → argon2 hash → 5-minute TTL → send.

**Verification flow:** a Lua script atomically checks and counts. After 5 failed attempts, the code burns. A consumed code is **deleted immediately** — replay is impossible.

> OTP is always sent from the tenant's `role = primary` bot (C-05). Sales and support bots never carry OTP, because a campaign bot getting banned should never block the login path.

### 2.4 Sessions and Tokens

- **Access token:** short-lived JWT, 15 minutes
- **Refresh token:** an opaque random string, hashed in the database, `httpOnly` + `Secure` + `SameSite=Strict` cookie, 30-day lifetime, and **rotated on every use**
- **Token theft detection:** reuse of an already-rotated refresh token signals theft. The system **invalidates the entire session family**, notifies the user, and logs the event
- Redis holds session liveness; deleting the key = instant logout from **all services** simultaneously
- A password change invalidates all of the user's sessions **within the same transaction**
- **Shared session between the PWA and the Telegram Mini App** (F-310) — same session, same token, no re-login

### 2.5 Attack Protection

Account lockout after failed attempts is a **TTL key in Redis**, not a `status = locked` column. It expires on its own, so there is no path by which a real user gets locked out forever — which would itself be a denial-of-service attack.

### 2.6 Rate Limiting

Two layers: Traefik at the edge, per IP, and services with identity-precise limits in Redis (sliding window via Lua).

| Path                  | Key                         | Limit                                                     | Window   |
| --------------------- | --------------------------- | --------------------------------------------------------- | -------- |
| Login                 | IP                          | 20                                                        | 15 min   |
| Login                 | user ID                     | 5                                                         | 15 min   |
| OTP request           | phone number                | 5                                                         | 1 hour   |
| OTP request           | IP                          | 15                                                        | 1 hour   |
| Registration          | IP                          | 10                                                        | 1 hour   |
| Forgot password       | phone number                | 3                                                         | 1 hour   |
| Invoice creation      | user                        | 30                                                        | 1 hour   |
| Payment start         | user                        | 20                                                        | 1 hour   |
| **Subscription link** | token                       | **dynamic — ≥ 3× the shortest `Profile-Update-Interval`** | 1 min    |
| Impersonation         | admin                       | 20                                                        | 1 day    |
| Bot webhook           | tenant (sub-bucket per bot) | 300                                                       | 1 min    |
| Data export           | tenant                      | 1                                                         | 24 hours |
| Migration import      | tenant                      | 3 concurrent runs                                         | —        |
| AI call               | tenant (and per task)       | tenant-configurable                                       | —        |

Bot webhook limiting is per **tenant** — one reseller's bot traffic can never starve another reseller's service. With multiple bots (C-05), the tenant's cap stays fixed and is shared across its bots.

---

## Section 3 — Access Control (RBAC) and Time-Bounded Access

### 3.1 Roles as Data

Three entities: `Role`, `Permission`, `RolePermission`. Permission keys are defined in code (so typos are impossible), but **roles are data**. Creating a role such as "financial specialist who only sees invoices and cannot touch the wallet" is an action in the admin panel, not a deploy.

### 3.2 Permission Key Structure

The `noun.verb` pattern, with full coverage:

`user.read` · `user.impersonate` · `wallet.manual_adjust` · `gateway.toggle` · `panel.manage` · `grant.assign` · `coupon.manage` · `tenant.manage` · `support.respond` · `bot.manage` · `restriction.assign` · `audit.read` · `domain.manage` · `theme.manage` · `page.publish` · `credential.manage` · `export.request` · `reseller.manage` · `migration.run` · `ai.configure` · `campaign.send`

### 3.3 Separation of Platform Permissions from Tenant Permissions

Platform staff permissions are a **completely separate set**: `platform.tenant.create`, `platform.plan.assign`, `platform.node.manage`, `platform.report.read`, `platform.impersonate`.

These can never be expressed as a plan feature and are never granted to a tenant role. A platform-staff token can never be used as a tenant token and vice versa — and this has automated tests in **both directions**.

### 3.4 Single Source of Truth for Permissions

The permission registry lives in one file, is seeded into the database at service boot, and is **the exact same list** the edge's `auth-handler` uses. Two sources of truth here is exactly what produces a permission hole.

### 3.5 Edge Authorization

Permission checks happen **before the request ever reaches a service**. Traefik hits a Go service (`auth-handler`) via ForwardAuth, which:

1. Verifies the JWT signature
2. Checks session liveness in Redis
3. Evaluates the RBAC policy
4. Injects identity headers into the downstream service

Identity headers are **stripped from the incoming request before ForwardAuth** — meaning a user can't spoof their own header to pretend to be an admin.

### 3.6 Impersonation

A critical support capability (F-1203), with six protective layers:

1. **Rank ceiling** — an admin can never impersonate a role at or above their own rank, and never a SuperAdmin
2. **Mandatory reason** — at least 10 characters. No reason, no session
3. **Hard time cap** — a maximum of **30 minutes**, and **no refresh token is ever issued**
4. **Forbidden paths** — changing a password, manually adjusting a wallet, reading/writing credentials, changing gateways, changing plans, changing 2FA, deleting an account, **configuring an AI provider**. The list is implemented as an **allowlist** — any new path that isn't explicitly recognized is closed by default
5. **Dual audit** — every write logs both `userId` (target) and `actorUserId` (the real admin) into that tenant's own log
6. **Time-bound tenant consent** — having the permission is not enough to enter a reseller tenant

### 3.7 Time-Bound Consent for Support

```
audit.SupportAccessConsent(tenantId, grantedByUserId, grantedAt,
                           expiresAt, revokedAt, reason)
```

- The reseller grants access **from their own panel**; the platform cannot invite itself
- Default duration is 4 hours, tenant-configurable, with a hard 24-hour cap
- Both boundaries (entry and exit) are audited
- The reseller sees the **full history** and **can revoke at any moment**; the session closes immediately

### 3.8 Temporal Access Grant (Elevated)

```
governance.TemporalAccessGrant(userId, permissionKey, grantedByAdminId,
                               startsAt, endsAt, reason)
```

Instead of permanently broadening a role for a temporary need: "Support agent X has `wallet.manual_adjust` today from 9 to 17 because finance is on leave." At 17:00 it expires on its own. Every temporal grant **requires a reason and an audit row**.

### 3.9 User-Level Restrictions (UserRestriction)

```
governance.UserRestriction(userId, restrictionKey, value, reason,
                           expiresAt, createdByAdminId)
```

Expresses arbitrary restrictions on a specific user **without a code change**: "max 3 active subscriptions," "not allowed to top up via crypto," "max 2 configs." Any restriction can carry an expiry date.

### 3.10 Strict Separation of the Four Access Mechanisms

| Question                                      | Mechanism                             | Example                              |
| --------------------------------------------- | ------------------------------------- | ------------------------------------ |
| Is this **tenant** entitled to do this?       | `TenantFeatureEntitlement`            | A Starter reseller has no public API |
| **How much** is this tenant entitled to?      | `checkLimit(ctx, 'limit.domains', n)` | Cap of 1 domain on Starter           |
| Is this **user** entitled to have this thing? | `Grant.featureKeys`                   | The user purchased 50GB of VPN       |
| What is this **user** restricted from?        | `UserRestriction`                     | This user cannot top up via crypto   |

They never share a table, a helper, or a key namespace. Mixing these is exactly the path by which a reseller could grant itself a feature it never purchased.

> **C-02:** "Custom domain" is no longer a `featureKey` — since everyone has one (D-01). Only `limit.domains` exists.

### 3.11 Ban on Plan-Name-Based Checks

`if (tenant.plan === 'pro')` is treated as a bug in this codebase — even when it produces the right answer. It makes a per-customer exception impossible and scatters the plan definition throughout the code.

```ts
requireFeature(ctx, "site.pages"); // FEATURE_NOT_ENTITLED
checkLimit(ctx, "limit.domains", currentCount); // LIMIT_EXCEEDED + limit in details
```

In the first month after launch, some customer will want "the Pro plan but with 20 domains." This architecture allows that to be done **that instant, from the panel, with no deploy**.

### 3.12 RBAC Down to the Reseller Level

| #      | Feature                                                             | Status |
| ------ | ------------------------------------------------------------------- | ------ |
| F-906  | RLS and audit down to the reseller-node level (`ltree` path prefix) | new    |
| F-1201 | Staff seats and time-bound access                                   | base   |
| F-904  | Reseller caps: user count, volume, max allowed discount             | new    |

The ownership model has been `(tenantId, resellerPath)` from day one, not just `tenantId`. Adding this later would mean rewriting every query in the system.

---

## Section 4 — Product Model, Catalog and Sales Engine

### 4.1 A Product-Agnostic Platform

The core system doesn't know what a VPN is. VPN is one **fulfilment strategy**, not the center of the model.

| Fulfilment type  | What it produces                      | Example                    |
| ---------------- | ------------------------------------- | -------------------------- |
| `network_access` | Grant + config on a panel group       | VPN plan, usage bucket     |
| `external_order` | Grant + order to a third-party API    | Instagram followers, views |
| `feature_access` | Grant carrying feature keys and quota | Password manager, API tier |
| `wallet_topup`   | Credit in the ledger only             | Wallet top-up              |

Adding a new product type = adding a `fulfilmentKind` and a handler. It **never** means adding a table to billing or changing the settlement process.

### 4.2 Catalog Structure

```
ProductCategory ──< Product ──< ProductVariant ──< Price (USD only)
                       │
                       └─ fulfilmentKind, featureKeys[], defaultQuotas
```

- **Product** is the marketing object; **ProductVariant** is the sellable unit (SKU)
- Price attaches to the **variant**, not the product
- Each variant has: `quotas` (JSONB), `durationDays` (null = permanent), `billingMode`, `panelGroupId`, `qualityTier`, and a three-state `visibility`: **`public` | `unlisted` | `admin_only`**

`unlisted` means it doesn't appear in the public catalog but is purchasable via a direct link. `admin_only` means only an admin can assign it.

### 4.3 Product Names as Translation Keys

Product name and description are **i18n keys, not text**. A reseller who wants to change a product's name overrides the key's value within their own namespace — not the database record. This is exactly what makes managing 30 languages × N products × M resellers practical.

### 4.4 Grant — The Single Concept of Entitlement

| Field                 | Meaning                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `source`              | `purchase` \| `admin_grant` \| `coupon` \| `affiliate_reward` \| `migration` \| `trial` \| `rollover` |
| `status`              | `pending` → `active` → (`suspended` \| `exhausted` \| `expired` \| `cancelled`)                       |
| `startsAt` / `endsAt` | `endsAt = null` means permanent access                                                                |
| `billingMode`         | `prepaid` \| `metered`                                                                                |
| `featureKeys`         | What it unlocks                                                                                       |
| `sharingPolicy`       | `exclusive` \| `shared_pool`                                                                          |
| `subscriptionToken`   | 32 random bytes, rotatable by the user                                                                |
| `billedBytes`         | Billing cursor for metered usage                                                                      |
| `resellerPath`        | Owning reseller node (C-15)                                                                           |

**Golden rule:** a user's access to _anything_ is answered by exactly one question: "Does an active Grant with this featureKey exist?"

**State transitions are one-way** (except `suspended → active`). An exhausted or expired Grant never comes back to life; a recharge either creates a new Grant or extends the quota with a `QuotaAdjustment` row.

> **C-09:** volume rollover follows exactly this same path — a `QuotaAdjustment` on the **new** Grant with `source = rollover`, a percentage cap, and an independent expiry. The old Grant stays untouched in the `exhausted` state.

### 4.5 Quota Types

| Metric               | Unit         | Used by         |
| -------------------- | ------------ | --------------- |
| `traffic_bytes`      | bytes        | network access  |
| `duration`           | via `endsAt` | all             |
| `concurrent_devices` | count        | network access  |
| `order_units`        | count        | external orders |
| `feature_items`      | count        | feature access  |
| `api_calls`          | count        | API tiers       |

**Reset policy (`resetPolicy`):** `none` (lifetime), `monthly`, `daily`.

### 4.6 One Package, Five Configs, One Shared Quota

**Quota sits on the Grant, never on the config.** Two kinds of multiplicity that must never be conflated:

- **Mirrored versions** — _one_ logical config across several panels for failover. The user sees one config
- **Distinct configs** — different protocols, different regions, one per family member

In both cases usage aggregates into **a single quota**, with no double-counting.

### 4.7 Discount Coupons

| Type           | Behavior                                    |
| -------------- | ------------------------------------------- |
| `percentage`   | A percentage of the invoice's dollar amount |
| `fixed_amount` | A fixed **dollar** amount                   |
| `free_grant`   | Issues a free Grant with `source = coupon`  |

**Constraints:** `maxRedemptions`, `maxPerUser`, `minOrderUsd`, `validFrom/validUntil`, `allowedProductVariants[]`, `allowedUserIds[]`, `firstPurchaseOnly`.

**Two-phase reservation:** a coupon is `reserved` when the invoice is created and `consumed` only on settlement. An abandoned invoice releases the coupon after its TTL. Without this, a user could exhaust a limited coupon's capacity with invoices they never pay. The **double-spend-under-concurrency case is tested**.

The discount always subtracts from the **dollar** amount first, and the toman amount is computed afterward — never the reverse.

### 4.8 Pricing and Campaign Engine

| #     | Feature                                                                      | Status  | Notes                                                                                                   |
| ----- | ---------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| F-501 | Product/variant/USD price catalog, three-state `visibility`                  | base    | —                                                                                                       |
| F-502 | Full coupon engine (§4.7)                                                    | base    | —                                                                                                       |
| F-503 | Time-boxed campaign with countdown in bot and panel                          | new     | Time reference is the server, not the client                                                            |
| F-504 | Tiered volume discounts                                                      | new     | Grows basket size                                                                                       |
| F-505 | Scheduled seasonal pricing (Nowruz, Yalda, Thursday-night)                   | new     | Jalali calendar, per tenant                                                                             |
| F-506 | Per-user custom plan (manual price and quota)                                | new     | An `admin_only` variant + `UserRestriction`                                                             |
| F-507 | Bulk purchase and group user creation via CSV                                | new     | Same import path (§16)                                                                                  |
| F-508 | Pure volume sale with no plan (top-up gigs)                                  | partial | `QuotaAdjustment` on an existing Grant                                                                  |
| F-509 | Presale / capacity reservation with discount                                 | new     | Debt recorded in `promotional_liability`                                                                |
| F-510 | **Auto-renewal from the wallet with explicit consent**                       | new     | ⭐ the single biggest LTV lever. Consent revocable with one tap, 48-hour notice before every withdrawal |
| F-511 | Invoice/receipt PDF with tenant branding                                     | new     | Server-side render, from a template we own                                                              |
| F-512 | Toman price display with live rate + rate lock at invoice time               | base    | §6                                                                                                      |
| F-408 | Node quality tiers: `standard` / `premium` with a different price multiplier | new     | The multiplier applies to traffic-wallet debiting, not as a catalog price matrix                        |

> **Rule:** F-505 and F-503 never overwrite an old `Price`. They create a new `Price` row with an `effectiveFrom` (§6.1). Yesterday's invoice is computed at yesterday's price.

---

## Section 5 — Wallet, Ledger and Payment

### 5.1 Double-Entry Ledger

Instead of "subtract $5 from the balance," every financial event is recorded as rows that **sum to zero**. The balance is a **result**, not an independently manipulated number.

```
LedgerAccount(tree, kind, ownerRef)
   tree: tenant_billing | platform_billing
   kind: user_wallet | gateway_clearing | platform_revenue
       | promotional_liability | reseller_subscription | traffic_wallet
       | reseller_credit | refund_clearing | rounding

LedgerTransaction(kind, reference, description, actorUserId)
   kind: deposit | purchase | metered_charge | refund | adjustment
       | promo_grant | reversal | subscription_charge
       | traffic_topup | traffic_charge | reseller_settlement
```

**Hard guarantees:**

- For every transaction, `SUM(amountMicro) = 0` — enforced with a deferred database trigger, not hope
- `LedgerEntry` is append-only. No `UPDATE`, no `DELETE`. Mistakes are fixed with a `reversal` transaction that mirrors and references the original
- The wallet balance is **always** equal to the sum of its ledger rows; a nightly reconciler checks every wallet, and any deviation is a Sev-1 incident

> **C-13:** `reseller_credit` (reseller credit balance, F-902) is a real account in the `tenant_billing` tree. But the **AI attention budget** (F-1501) never enters the ledger — it's a counter in `engagement.AttentionBudget`. The ledger is money only.

### 5.2 Two Separate Account Trees

`tenant_billing` is money between the end user and the reseller. `platform_billing` is money between the reseller and the platform.

**No query is allowed to return a number that sums the two.** A number that mixes them is wrong even when its arithmetic is correct — and it's exactly the kind of mistake that survives review because the number looks plausible. An automated test scans reporting queries for cross-tree aggregation.

Settlement between a reseller and a sub-reseller (F-905) happens entirely **inside** the `tenant_billing` tree and never reaches `platform_billing`.

### 5.3 Representing Money

Dollars are stored as `BigInt` **micro-dollars**: `1 USD = 1,000,000 µ$`.

Dollars are **never** a float, never a JavaScript `number`, never a Go `float64`. The `Usd` class cannot be constructed from a float, and `parse → toDecimalString` is lossless across the entire range — verified with a **property test**, not a sample test.

### 5.4 One Wallet, No Complexity

**One wallet per user, dollars only.** No per-currency wallets, no wallet selection, no split payments.

A negative balance is impossible at the **database** level (`CHECK (balanceMicro >= 0)`) — not merely at the application-code level.

### 5.5 Payment Gateways

| Gateway                       | Currency     | Rate mode       | Confirmation                            | Status       |
| ----------------------------- | ------------ | --------------- | --------------------------------------- | ------------ |
| Toman online (ZarinPal, etc.) | IRT          | live, validated | redirect + **server-side confirmation** | base (F-801) |
| Crypto (NowPayments)          | USDT         | fixed 1:1       | IPN with HMAC verification              | base (F-802) |
| **Card-to-card**              | IRT          | live            | triple match or human confirmation      | new (F-803)  |
| Manual                        | any currency | manual snapshot | admin confirmation with audit row       | base         |
| Fake (test)                   | —            | —               | —                                       | base (F-808) |

The gateway architecture is **plugin-based**. A **fake gateway** implementing the same interface — one that can fail, delay, double-deliver, and report the wrong amount — was built **before** any real adapter.

> **C-19 / D-03:** the gateway is mandatory on **every plan** and belongs to the tenant. The platform never receives end-user money. Plans differ only in gateway count and access to advanced methods.

### 5.6 Card-to-Card with Automatic Matching

| #     | Feature                                                                                | Status |
| ----- | -------------------------------------------------------------------------------------- | ------ |
| F-803 | Card-to-card as a first-class gateway                                                  | new    |
| F-804 | **Unique amount per invoice** (adding a few random rials to the amount)                | new ⭐ |
| F-805 | Receipt upload in bot + confirmation queue + one-click admin confirmation from the bot | new    |
| F-806 | Bank SMS parsing as a confirmation source (optional, tenant-side)                      | new    |
| F-807 | Multiple destination accounts with rotation                                            | new    |

**Matching rule (C-14):** automatic credit is given **only** when all three conditions hold:

1. The amount **exactly** equals the invoice's `uniqueAmountIrt`
2. The destination account is exactly the one assigned when the invoice was created
3. The deposit time falls inside the invoice's credit window

Any deviation — underpayment, overpayment, a duplicate amount within the window, wrong account, outside the window — goes to the **human review queue**. This is exactly the crypto rule, and there's no reason to be looser here.

A unique amount is never assigned twice within one window (a reservation lock in Redis), since two invoices with the same amount would defeat the entire mechanism.

### 5.7 Payment Path Protections

- **Credited amount = whatever was locked at the moment payment began.** Never recomputed from the amount the gateway reports paid
- **An expired quote is dead.** Settlement after `quoteExpiresAt` moves to `settled_late` and goes into the **admin review queue**, not automatic credit
- **Callbacks are idempotent** on `(gatewayKey, providerTransactionId)`, enforced by a unique database constraint
- **Amount mismatch = human review**, with both numbers shown in the queue
- **Server-side confirmation only.** A browser redirect with a success flag is never sufficient on its own
- **Payment reconciliation log** records every callback, including ones that match no invoice — which are exactly the interesting ones

### 5.8 Purchase Settlement Flow

```
1. POST /invoices  → server re-prices from the catalog in dollars
   The client-submitted price is always ignored, not merely validated
   → checks: active, visible to this tenant, coupon validity,
     governance restrictions, tenant subscription status, reseller cap
   → coupon reserved, invoice with a 30-minute expiry

2. POST /invoices/:id/pay → payment from wallet balance
   One atomic transaction:
     · advisory lock on the invoice
     · SELECT ... FOR UPDATE on the wallet
     · sufficiency check
     · write transaction and ledger rows
     · update balance
     · invoice → paid
     · create Grant(s) in pending state
     · consume coupon
     · publish grant.created event

3. Delivery (async, by fulfilment type)
   → success: Grant active, notification, websocket push
   → failure after N attempts: Grant cancelled + automatic full refund
```

**Money moves at step 2, entitlement is created at step 2, delivery is step 3.** Concurrent payment on one invoice succeeds **exactly once** — tested under concurrency.

### 5.9 Insufficient Balance

The error includes `shortfallMicro`. The client offers a top-up **pre-filled with exactly the shortfall amount** and returns the user to the same invoice. The suggested amount is rounded **up** so the user never returns to settlement short by a few microdollars again.

### 5.10 Refunds

- Via a `reversal` transaction referencing the original; dollars go back to the wallet
- **Always to the dollar wallet, never to the original gateway** (F-809)
- **Partial** refunds are a proportional dollar amount
- The Grant is cancelled and its configs deleted
- A consumed Grant that had usage is refunded **minus the dollar value already consumed**, computed from `usage_daily` — and **the computation is written into the description**
- Refunding an already-refunded invoice is **rejected**, not silently applied twice

### 5.11 Manual Balance Adjustment

The manual credit/debit path requires a **mandatory reason and an audit row**, and was built **before any gateway** so the ledger could be exercised end-to-end without an external dependency.

### 5.12 Treasury and FX Risk

```
TreasuryConversion(sourceCurrency, sourceAmountMinor, usdReceivedMicro,
                   impliedRate, marketRateAtRequest, realisedCostMicro, status)

TreasurySnapshot(outstandingUsdMicro, holdings, unconvertedFloat,
                 oldestUnconvertedAt, coverageRatio)
```

**Coverage ratio** = dollar value of assets ÷ total dollar liability (sum of wallets + unconsumed value of prepaid Grants + traffic wallets + **`promotional_liability` debt**).

- `≥ 1.0` — every dollar we owe is backed
- `< 1.0` — shortfall; a red dashboard with the shortfall amount
- A configurable alert floor (default 0.95)

A pending conversion row older than 24 hours warns; older than 72 hours is critical. Treasury numbers are explicitly labeled as **indicators** and are **never used in any calculation on the money path**.

---

## Section 6 — Dollar Pricing and FX Rate Engine

### 6.1 Why Dollars

Products are priced **exclusively in dollars**. `catalog.Price` is a `(variantId, priceMicro, effectiveFrom, isActive)` row.

- No per-currency price matrix, no per-currency coupons
- A price change creates a **new** row; old rows are kept
- **Yesterday's invoice is computed at yesterday's price** — and this has a test, because "obviously that's how it works" is exactly how it breaks

### 6.2 The FX Worker

**Completely decoupled from the request path.** Every-5-minutes loop:

1. All active sources are queried concurrently with a 3-second timeout
2. Failures and any value outside a hard sanity band are discarded
3. At least `minSources` must remain (default 2). The **median** is taken, not the mean
4. If the move exceeds `maxDeviationPercent` (default 5%), it is **rejected** and fires a critical alert
5. On acceptance, a snapshot is written and the rate is cached in Redis

**This single rule is what stops $100 of service from selling for 600,000 rials because of one broken API response.**

Every quoted price records its own `rateSnapshotId`.

### 6.3 Rate Staleness Ladder

| Age of last snapshot           | Behavior                                                       |
| ------------------------------ | -------------------------------------------------------------- |
| Under 15 minutes               | normal                                                         |
| 15–60 minutes                  | serve the last rate, gateway marked `degraded`, admins alerted |
| Over 60 minutes                | fall back to the gateway's `staticRate` if configured          |
| Over 60 minutes, no staticRate | **gateway is disabled**                                        |

Rejecting a sale costs one sale; a wrong guess costs an unbounded amount.

### 6.4 Manual Rate

An admin can pin a **manual rate with a reason and an expiry**. It writes a snapshot with `status = manual`, is audited, and is shown as a banner in the admin panel until it expires.

### 6.5 Gateway Pricing Engine

```jsonc
{
  "useLiveRate": true,
  "staticRate": "0",
  "percentageModifier": "0", // positive = markup in the platform's favor
  "fixedAmountModifier": "0",
  "minRate": "40000",
  "maxRate": "300000",
  "roundingStep": 1000,
  "roundingMode": "up", // up | nearest — never down
}
```

The calculator is a **pure function**: no I/O, no clock, no database.

- Computations happen in **precise decimal** (`decimal.js` and `shopspring/decimal`). A float operation in this function is a bug
- `roundingMode` is never `down`
- Golden-file tests: every gateway config in production, zero and negative modifiers, boundary rounding, min/max amounts, coupon interaction, out-of-range rates

### 6.6 One Calculator for Display and Charging

**The display path and the charging path call the exact same function.** If the wallet page says ≈ 300,000 tomans and settlement then wants 340,000, trust is gone.

Every displayed number is prefixed with `≈` and shows the **rate's timestamp on hover**.

---

## Section 7 — Network Service: Supply, Stability and Connection Intelligence

### 7.1 Panel Abstraction and Drivers

The infrastructure unit is a **Panel**, not a node. A Marzban install backed by 20 nodes is, to us, **one** Panel.

```go
type Driver interface {
    Capabilities(ctx) (Capabilities, error)
    HealthCheck(ctx) error
    ListInbounds(ctx) ([]Inbound, error)
    CreateClient(ctx, req) (RemoteClient, error)
    UpdateClient(ctx, req) error
    SetClientEnabled(ctx, remoteID, enabled bool) error
    DeleteClient(ctx, remoteID) error
    GetUsage(ctx) ([]ClientUsage, error)     // all clients in one call
    ResetUsage(ctx, remoteID) error
    BuildLink(ctx, client, inbound) (string, error)
    SubscriptionURL(ctx, remoteID) (string, bool)
}
```

**Supported drivers:** `xui_legacy`, `xui_3x`, `marzban`, `marzneshin`, `s_ui`, `hiddify` — with the interface already leaving room for `openvpn_as`, `wireguard`, and `l2tp`.

**Automatic capability discovery:** each driver declares whether it supports per-client usage, enable/disable toggling, usage reset, native subscription links, server-side expiry, and a bulk usage endpoint.

**Full isolation:** nothing outside the driver package knows what an inbound, a UUID, or an x-ui session cookie is.

**Fake driver** (F-214) — a driver that can fail, time out, reset its counter, return implausible numbers, and respond slowly. Every real driver must pass the same conformance suite. This is the foundation of the tenant sandbox environment.

### 7.2 Bring Your Own Node (Customer's Own Panel)

A first-class mode from the **very first database migration**. Every panel has an `ownershipType`: `platform` or `tenant`.

**Allocation order for tenant T:**

1. T's own panels
2. Pools T has been explicitly granted access to
3. The shared platform pool — **only if T's traffic wallet balance is positive**

**Key guarantee:** a tenant with only its own panels is fully operational at **zero** traffic balance and never touches a platform panel.

**Alerting difference (C-18):** a tenant-owned panel that goes unhealthy alerts the **owner of the panel record** — which can be the tenant or a reseller node — not the platform's on-call team.

**Usage attribution:** usage is attributed to both the end user and the **panel owner** (F-1002).

### 7.3 Panel Group and Mirroring — Zero Downtime

```
PanelGroup(name, strategy, minHealthyPanels, subscriptionTtlSeconds)
PanelGroupMember(panelId, priority, weight, role)
    role: primary | replica | drain
```

**On Grant fulfilment:**

1. Resolve the variant's panel group
2. Create a client on every member with `role != drain` and `status = healthy`
3. Every result becomes a config row sharing a `credentialGroupId`
4. Failures go to a retry queue with exponential backoff; the Grant activates as soon as `minHealthyPanels` versions exist

**Convergent provisioning:** the desired state lives in our database, and a loop reconciles reality with it — **exactly like a Kubernetes controller**. Killing a panel mid-provisioning produces **exactly one** config per panel, never a duplicate.

**Why this means zero downtime:** we serve the subscription link with a short TTL. If a panel dies, the health checker marks it unhealthy within one interval, the link generator drops its versions, and clients converge within one TTL — **no reprovisioning, no migration, no admin action**.

**Draining:** `role = drain` → new Grants are rejected → wait `2 × subscriptionTtl` → delete configs → remove member. **No user is ever cut off at any point.**

### 7.4 Health Checks

- 30-second interval, configurable per panel
- Unhealthy after 3 consecutive failures; healthy again after 2 successes (hysteresis)
- Panel unhealthy for over 10 minutes → critical alert to the panel owner
- Status lives in Redis for speed, mirrored to Postgres for history

**If every panel in a group is unhealthy**, the subscription endpoint returns the last known-healthy link set with a `Warning` header, not an empty config (F-413).

**Sales blocking (F-412):** when a variant's panel group is unhealthy, that variant is pulled from the purchasable catalog. Not selling beats selling something that won't deliver.

### 7.5 Subscription Link

```
GET https://<sub-domain-of-tenant>/sub/{subscriptionToken}
```

- The token is a **32-byte random, URL-safe** string on the Grant, **rotatable by the user themselves**
- The response is built from the Grant's configs on **currently healthy** panels
- **Formats:** base64 URI, Clash, Sing-box, Xray JSON, Outline (F-407)
- **Automatic format detection from `User-Agent`**, with `?format=` as an explicit override (C-08). Unknown UA → base64 URI
- A `Subscription-Userinfo: upload=…; download=…; total=…; expire=…` header so client apps can **natively display remaining quota** (F-609)
- `Profile-Update-Interval` is synchronized with the TTL

**Performance:** the hottest path in the entire system. **Never requires a Postgres write**, is served from a cached render in Redis, and must return under **50ms at p99**.

**Cache key (C-07):** `(grantId, healthyPanelSetHash, activeDomainSetHash, format)` — and it is **explicitly** invalidated on any domain status change.

**Behavior for inactive Grants:** an **empty but valid config**, plus a `Subscription-Userinfo` header showing zero remaining — **never a 4xx error**. Client apps handle 4xx badly.

**Instant token rotation:** the old token is invalidated **immediately**, not at the next cache expiry.

**Independent origin (C-16):** the `/sub` domain has no cookies, no CORS to the panel domain, and no session ever crosses it. Its only authentication is the token in the path. The subscription link is the piece most likely to get filtered and must never take the panel down with it (F-113).

**Upstream proxying (C-17):** if a `LegacyUpstream` or a panel's native `SubscriptionURL` is configured, TXNet **proxies** it rather than building the body itself — while still applying its own auth, quota headers, and health filtering. The token is ours; the upstream URL is never shown to the user.

### 7.6 Domain Rotation in the Subscription Response

| #     | Feature                                                                                                                                          | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| F-105 | **Automatic subscription-link domain rotation** — the `/sub` response includes a list of alternate domains and a short `Profile-Update-Interval` | new ⭐ |
| F-106 | **Emergency broadcast** — when a domain goes unhealthy, the new link is immediately pushed to all of that tenant's users via the bot             | new    |
| F-115 | "Always-warm standby domain" path — a standby pre-issued and pre-tested, switchover under a minute                                               | new    |

The most important item here is F-105: client apps cache the link; if that domain dies, the user is orphaned. And the only channel that still works when the domain is dead is the **bot** (F-106).

### 7.7 Connection Intelligence and ISP-Based Routing

| #      | Feature                                                                                                                                       | Status | Notes                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------- |
| F-402  | **Routing based on the user's ISP** — tracking success rate per (ISP × inbound × hour) and serving a config that works on _that same_ carrier | new ⭐ | its engine is F-1520          |
| F-403  | Automatic detection of an inbound getting blocked, from a drop in success rate                                                                | new    | —                             |
| F-404  | Automatic inbound rotation: create new, mirror, retire old, no admin involvement                                                              | new    | same convergence loop as §7.3 |
| F-405  | A "my connection isn't working" button in the bot that signals the routing engine                                                             | new    | real edge data, for free      |
| F-1521 | Predicting an inbound getting blocked from the drop trend and rotating **before** full outage                                                 | new    | §24                           |

> **C-06 — how this doesn't break the hot path:** the `/sub` path only does an `INCR` on Redis (key: ISP derived from IP × the inbound set served) and drops an event in a buffer. Aggregation, scoring, and routing decisions all happen in a separate worker, and the result is cached as a small `RoutingWeight` table that the link generator only **reads**. Zero synchronous Postgres writes.

### 7.8 Connection Experience

| #     | Feature                                                                       | Status  |
| ----- | ----------------------------------------------------------------------------- | ------- |
| F-409 | Speed-test and ping page per region before purchase                           | new     |
| F-410 | User-selected region with a shared quota                                      | partial |
| F-411 | Public status page per tenant (on its own domain)                             | new     |
| F-414 | Per-OS app installation guide, localized, in-bot and in-panel                 | new     |
| F-307 | Link, QR, **per-app deep link**, token rotation, reset — all in bot and panel | new     |

### 7.9 Concurrent Device Limits

`concurrent_devices` quota is enforced from distinct observed source IPs, wherever the driver makes them available (F-1101).

### 7.10 Enforcement

Triggered by: exceeding quota, wallet exhaustion, traffic-wallet exhaustion, expiry, admin action, tenant subscription suspension, or a fraud freeze.

```
Grant → suspended | exhausted | expired
  → publish event
  → network-service issues SetClientEnabled(false) to every config of the Grant
  → every result is recorded per config; failures retry with backoff
  → enforcementState: pending → partial → complete
```

**Enforcement is convergent.** A state reconciler compares each config's desired state against the panel-reported state and repairs the drift. Leaving an active config running after quota exhaustion is free service.

**Grace policy:** a metered Grant whose wallet hits zero enters `grace` for 10 minutes with a notification, then suspends. A prepaid Grant whose quota runs out suspends immediately — **except for the 24-hour grace period after time-based expiry (F-603)**, which applies to every Grant type, not just metered ones.

---

## Section 8 — Usage Measurement and Usage Billing

This is where money is made or lost.

### 8.1 The Fundamental Problem

Panels report a **cumulative counter** per client. These counters reset: when an admin resets them, when a client is rebuilt, when a panel is restored from backup.

Naively storing "the current total" produces both **under-counting** (after a reset) and **phantom usage** (after a restore).

### 8.2 The Fix: Deltas with Explicit Reset Detection

```go
func computeDelta(prev CounterState, cur ClientUsage) (dUp, dDown int64, reset bool) {
    if cur.Up < prev.LastUp || cur.Down < prev.LastDown {
        return cur.Up, cur.Down, true   // counter went backward → reset
    }
    return cur.Up - prev.LastUp, cur.Down - prev.LastDown, false
}
```

**A counter going backward is a reset, never negative usage.** A negative delta is never published, stored, or deducted from quota. Every reset increments an `Epoch` and publishes an event.

### 8.3 Quarantining Implausible Deltas

A single delta larger than `maxPlausibleDeltaPerInterval` (default: interval × 10 Gb/s) is **quarantined, not applied**. It's written to `usage_delta_quarantine` and fires an alert (F-1104).

### 8.4 Collection Pipeline

```
Every 60 seconds:
  runID = uuid7()
  for every healthy panel (bounded concurrency, 10s timeout):
      usages = driver.GetUsage()        ← all clients in one call
      for every usage:
          compute delta, detect reset
          publish to RabbitMQ
          store the new CounterState
```

**Exactly-once effect with at-least-once delivery:** `CounterState` is stored **after** a successful publish, and the message carries `(credentialId, collectorRunId)`, which is unique in the consumer's table.

**Byte counts travel over the wire as strings.** A JSON number above 2^53 silently loses precision.

**Bulk queries are mandatory:** per-client queries are **forbidden**.

### 8.5 Pay-As-You-Go Billing

```
chargeableUnits = floor((consumedBytes - billedBytes) / incrementBytes)
if chargeableUnits > 0:
    amountMicro = chargeableUnits × pricePerIncrementMicro × qualityTierMultiplier
    debit wallet, write ledger, billedBytes += chargeableUnits × incrementBytes
```

`incrementBytes` defaults to 100MB. **The cursor makes double-billing mathematically impossible.**

`qualityTierMultiplier` comes from F-408 and applies to the **debit**, not to the catalog price.

**Smart batching:** charges accumulate in Redis and flush to the ledger once **one cent or 15 minutes** accumulates — plus on shutdown, on enforcement, and on invoice generation.

The Redis accumulator is **only valid in-flight**. If Redis is lost, recovery recomputes from `consumedBytes − billedBytes` — which is why the cursor lives in Postgres.

### 8.6 Usage Baseline on Migration

`billedBytes` is set from the user's prior usage on the source panel at import time (F-208). Otherwise a migrated user either gets a zeroed quota or gets billed double.

---

## Section 9 — Multichannel Notifications and Campaigns

### 9.1 Structure

```
Template(key, channel, languageCode, subjectKey, bodyKey, variables[])
Preference(userId, eventKey, channels[], isMuted)
Campaign(id, tenantId, resellerPath, audienceQuery, templateKey,
         scheduleAt, status, stats, cursor)
DeliveryLog(id, tenantId, userId, channel, templateKey, status,
            providerRef, error, createdAt)
```

**Channels:** `in_app`, `push` (PWA), `sms`, `telegram`, `bale`, `email` (later).

### 9.2 Notifications as Domain Events

Every notification fires as a **domain event**, never as a direct call from business logic. The billing service publishes `grant.exhausted`; it **has no idea a Telegram bot even exists**.

### 9.3 Event Keys

`auth.login_new_device` · `auth.password_changed` · `wallet.credited` · `wallet.low_balance` · `invoice.paid` · `invoice.failed` · `grant.activated` · `grant.expiring_soon` · `grant.exhausted` · `grant.suspended` · `support.agent_replied` · `panel.degraded` · `domain.unhealthy` · `domain.switched` · `tenant.subscription_expiring` · `tenant.subscription_state_changed` · `tenant.traffic_low` · `tenant.traffic_exhausted` · `reseller.*` · `admin.*`

### 9.4 Preferences and Quiet Hours

Delivery respects the user's preferences, the user's language, and a **quiet-hours window**. Per-user notification settings can also be changed from inside the bot (F-319).

But transactional security events (`auth.*`) and the **emergency domain broadcast (`domain.switched`, F-106)** override mute settings — you cannot opt out of learning that your password changed or that your domain died.

### 9.5 Retention Notifications

| #      | Feature                                                                         | Status                                          |
| ------ | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| F-601  | Multi-threshold usage notifications (50% / 80% / 95%) and time (7 / 3 / 1 days) | partial                                         |
| F-602  | Exhaustion prediction: "at this rate, your volume runs out in 4 days"           | new                                             |
| F-603  | 24-hour post-expiry grace period with a notice, instead of an abrupt cutoff     | changed (for all Grants, not just metered ones) |
| F-1515 | An AI version of this same prediction, with **one** well-timed message          | new (§24)                                       |

### 9.6 Campaigns

- Audience selection is a **saved, named query descriptor** (`{ filters: [...] }`), not raw SQL — validatable, previewable with a count, safely built in the UI
- **Ready-made segments (F-313):** expiring soon, exhausted, churned, never purchased, high usage, low usage
- Sending is throttled with a **token bucket per provider**
- Campaigns are **resumable**: a crashed campaign continues from its own cursor, never from the start
- A campaign is scoped to a reseller node; one reseller cannot message another reseller's users
- F-1529: AI can suggest segmentation and write copy in the brand's tone — always in **draft-with-approval** mode

### 9.7 No-Fallback Rule

Notifications sent on behalf of a tenant use **that same tenant's channels and credentials**. A tenant with no bot token gets no bot notifications at all; **the platform's bot never substitutes for their bot**. The delivery log records the failure rather than hiding it.

This rule has an **explicit automated test**, because it's the one rule whose violation is invisible from the inside — everything appears to work, and a reseller's customers get messaged by us.

**The same rule applies to AI:** a tenant that hasn't configured an AI provider gets the template. The platform never runs inference on its own key on their behalf (D-03).

### 9.8 A Queue Resilient to Bot Bans

F-316: the message queue is decoupled from the token. If a bot's token gets banned, the tenant registers a new token and the queue resumes from the same cursor — **no message is lost**. Bots get banned; that's not an "if."

---

## Section 10 — Bot as a Full Panel

> **D-02:** one shared `ActionRegistry`. Every action: permission, input validation, execution, output. The web app and the bot only render. A new capability added only on the web **fails in CI**, because the action registry rejects any action with no bot renderer.

### 10.1 Multiple Bots per Tenant

```
automation.BotIntegration
  tenantId, platform(telegram|bale), botUsername,
  role(primary|sales|support|secondary),
  credentialRef,          -- a vault reference, not a token column
  webhookSecret, webhookPath,
  status(pending|active|disabled|error), lastErrorAt, capabilities
    unique (tenantId, platform, botUsername)
    partial unique (tenantId, platform) where role = 'primary'
```

**C-05:** the `primary` bot carries OTP and transactional alerts. `sales` / `support` / `secondary` bots exist for campaigns, secondary brands, and spreading ban risk (F-315).

### 10.2 Webhook Architecture

- URL: `POST /bots/{platform}/{webhookPath}`, where `webhookPath` is a random 32-byte string
- **The tenant is resolved from the path, never from the message body**
- The platform performs `setWebhook`/`deleteWebhook` on the tenant's behalf using its own token; `status` and `lastErrorAt` are visible to the tenant
- The `X-Telegram-Bot-Api-Secret-Token` header is verified on **every request**
- Rotating the webhook path re-registers upstream, and the old path **immediately** stops responding

**Webhook, never polling.** Fifty resellers means fifty bots, and fifty polling loops would mean fifty long-lived outbound connections — a scale this network can't keep reliable.

### 10.3 Telegram/Bale Abstraction Layer

| #     | Feature                                                                                         | Status |
| ----- | ----------------------------------------------------------------------------------------------- | ------ |
| F-301 | Shared abstraction layer with **capability flags** (file size, keyboard type, WebApp, payments) | new    |
| F-302 | Automatic degradation policy — if a capability is missing, fall back without failing            | new    |

Bale is a subset of Telegram, not a copy of it. Code assuming they're identical breaks on Bale in production.

### 10.4 Full Bot Capabilities

| #      | Feature                                                                             | Status    |
| ------ | ----------------------------------------------------------------------------------- | --------- |
| F-303  | **Full registration and login inside the bot** (OTP, language choice, profile)      | new       |
| F-304  | Catalog, variant selection, invoicing, and payment inside the bot                   | new       |
| F-305  | **One-click renewal and top-up on the same Grant**                                  | new ⭐    |
| F-306  | Wallet: top-up, balance, transaction history, invoices                              | new       |
| F-307  | Config management: link, QR, per-app deep link, token rotation, reset               | new       |
| F-308  | Usage chart as a **rendered image** in the bot                                      | new       |
| F-309  | Two-way support ticket with attachments inside the bot                              | new       |
| F-310  | **Mini App / WebApp** — the same PWA inside Telegram, sharing a session             | new       |
| F-311  | Reseller management panel inside the bot: create user, renew, block, revenue report | new       |
| F-312  | Sub-reseller panel inside the bot                                                   | new       |
| F-313  | Bulk sending with segmentation + a rate-limited queue                               | new       |
| F-314  | Login deep links: `?start=buy_<sku>` / `?start=ref_<code>` / `?start=trial`         | new       |
| F-318  | Channel-membership gate for claiming a free trial                                   | new       |
| F-319  | Per-user notification settings inside the bot                                       | new       |
| F-405  | "My connection isn't working" button                                                | new       |
| F-1531 | Daily/weekly business summary for the reseller in the bot                           | new (§24) |

An Iranian reseller works from a phone. If the management panel only exists on the web, half their work doesn't get done.

### 10.5 Account Linking

`LinkedBotAccount` binds the triple `(userId, platform, platformUserId)` and is unique on `(platform, platformUserId)` **per tenant**. One Telegram account cannot be linked to two users within one tenant.

With multiple bots (C-05), linking is scoped at the **tenant** level, not the bot level — a user who started with the sales bot is the same user in the support bot.

**Legacy bot-user mapping (F-210):** at migration time, `platformUserId`s from the old bot are automatically linked. Otherwise everyone has to re-verify with OTP, and that's exactly where you lose them to churn.

### 10.6 Bot Token Security

Bot tokens live in the **vault** and are never logged, never returned by any API, and once stored are **never rendered in the admin UI** — only "set / not set" plus a fingerprint.

---

## Section 11 — Unified Support

### 11.1 One Door, No Choice

**There is a single support entity** and one entry point, simply labeled "Support." Tickets and live chat are not two products; they are **one thread** whose behavior varies depending on whether a human is currently available.

```
Conversation(tenantId, resellerPath, userId, subject, category, status,
             priority, assignedToUserId, mode, firstResponseAt,
             lastMessageAt, closedAt, ratingScore, aiTriageLabel)
    status: open | pending_user | pending_agent | resolved | closed
    mode:   live | async     ← a moment-in-time attribute, not a record type

Message(conversationId, senderKind(user|agent|system|bot|ai), senderUserId,
        body, attachments[], readAt, createdAt)     -- monthly-partitioned
```

### 11.2 Behavior

- The user opens support, optionally picks a category, and types. **That is the entire flow.**
- If at least one agent is online and within working hours, the conversation opens as `live`
- Otherwise it's `async`, with an explicit wait-time notice. **Same thread, same history.**
- The conversation moves freely between modes
- **Fully usable from inside the bot too** (F-309), with attachments

**The user is never asked "is this a ticket or a chat?"**

### 11.3 Agent Side

- **A single unified inbox** with filters for `live now`, `pending`, `mine`, `unassigned`
- **SLA timers**
- **Canned responses** (as i18n keys — meaning multilingual)
- **Internal notes** invisible to the user
- A **360° user context panel** in the sidebar: balance, Grants, recent invoices, active configs, recent errors, **ISP and last successful connection**
- **AI triage and drafting** (F-1530) in draft-with-approval mode

### 11.4 File Attachments

Attachments go to S3 with a **virus-scan hook** and **short-lived signed URLs** (5 minutes). Addresses are never public and never guessable.

### 11.5 Queue Priority

`support.priority` (a plan feature) controls only **position in the queue**. It never changes what the user can say or see.

### 11.6 Tenant and Reseller Isolation

Support is **tenant-scoped** like everything else, and now also **reseller-scoped**: a reseller's agents only see conversations under their own subtree. Platform staff reach them only through time-bound consent (§3.7).

---

## Section 12 — Realtime

Socket.IO with a Redis adapter, in a dedicated service.

**Authentication:** the client presents its own access token on connect; the service validates it exactly as the edge does. Sockets are disconnected **immediately** when the session key disappears.

**Rooms:** `user:{userId}`, `tenant:{tenantId}`, `reseller:{path}`, `admin`, `conversation:{id}`. Room membership is **tenant-checked on join**.

**Pushed events:** live traffic counter, balance change, Grant status change, invoice settlement, support message, **domain status change**, infrastructure alerts for admins.

Live traffic values are read from the Redis counter, **at most once every 2 seconds per user**, and coalesced.

**Golden rule:** realtime is a **delivery mechanism, never a source of truth**. Any value that gets pushed must also be retrievable from a REST endpoint.

---

## Section 13 — White-Label, Domain and Resilience Against Filtering

This section merges §13 of the v1 document with section 1 of the v2 document, and had the most conflicts.

### 13.1 Domain Model

```
TenantDomain(host, purpose, state, verificationToken, status, tlsStatus,
             verifiedAt, lastRevalidatedAt, healthState, lastProbeAt)
    purpose: panel | subscription | assets
    state:   primary | standby | retired
    status:    pending | verifying | verified | revalidating | failed | disabled
    tlsStatus: none | issuing | issued | renew_failed
```

> **C-01 + C-07 + C-16:** v1's boolean `isPrimary` field was removed. A tenant simultaneously has `panel/primary`, `panel/standby`, `subscription/primary`, and `assets/primary` domains. These three roles **never collapse onto one domain**, except on the Starter plan, whose allowed minimum is one panel domain + one subscription domain.

| #     | Feature                                                                                              | Status  | Notes                                                  |
| ----- | ---------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| F-101 | A custom domain is mandatory for every plan; registered and owned by the tenant                      | changed | D-01 / C-01                                            |
| F-102 | Multiple domains with `primary` / `standby` / `retired` roles                                        | new     | A filtered domain must be a switch, not a crisis       |
| F-113 | A domain separate from the panel domain for `/sub`                                                   | new     | C-16                                                   |
| F-114 | Domain and certificate expiry alerts to the tenant                                                   | new     | An expired domain = a total outage for their customers |
| F-115 | An **always-warm** standby domain — certificate pre-issued and pre-tested, switchover under a minute | new     | Issuing a certificate mid-crisis doesn't work          |

### 13.2 Domain Verification Lifecycle

1. Tenant adds a host → `pending` with a random token
2. Tenant creates the `TXT` record in **their own registrar** → `verifying`
3. A worker resolves the record. On failure, the tenant sees **exactly what was expected and what was found** — the single most common support ticket in any white-label product
4. CDN setup with the **tenant's own account** (F-111): CNAME, a shared-secret header between the CDN and the origin, an origin firewall restricted to CDN ranges — **so the origin IP is never exposed**
5. TLS issuance, `tlsStatus` visible to the tenant
6. **Periodic re-validation.** A domain whose TXT record disappears → `revalidating` → after a grace period → `pending`, and **routing stops**

**The platform never registers, purchases, renews, or controls DNS for a tenant's domain.** Holding onto a customer's domain is a liability, not a service.

**Publish gate (C-03):** a `purpose = panel` domain is **not routed** until `terms`, `privacy`, and `contact` are published in the tenant's default language. This is enforced in the domain state machine at the **service layer**. All three pages are available on **every plan**.

**Onboarding console (C-01):** until the first domain is verified, the tenant only has access to the onboarding console on the platform domain. There, **no end user ever registers, no sale ever happens, and no subscription link is ever served.** Configuration only.

### 13.3 Resilience Against Filtering

| #     | Feature                                                                                                  | Status | Why                                                       |
| ----- | -------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| F-103 | Domain health probing **from inside Iran** (multiple ISPs: Hamrah-e Avval, Irancell, Shatel, Mokhaberat) | new    | Detect filtering before a user files a ticket             |
| F-104 | Block-type detection: DNS poisoning, SNI block, IP block, RST injection                                  | new    | Each has a different fix                                  |
| F-105 | Automatic domain rotation in the subscription response                                                   | new ⭐ | §7.6                                                      |
| F-106 | Emergency broadcast of a new domain via the bot                                                          | new    | The only channel that still works when the domain is dead |
| F-110 | An IP pool with per-tenant allocation and rotation; controllable IP neighborhood                         | new    | A shared IP means one blocked tenant blocks everyone      |
| F-112 | Email, webhooks, and outbound links sent from the tenant's own domain                                    | new    | Brand leakage and correlated risk                         |

### 13.4 Anti-Fingerprinting

| #     | Feature                                                                                                                                               | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| F-107 | HTML structure, class names, asset hashes, and paths **differ per tenant**                                                                            | new    |
| F-108 | Complete removal of platform traces: no "powered by," no shared domain in the JS bundle, source maps off, no shared asset host, dedicated error pages | new    |
| F-109 | Independent TLS certificate per domain; **never a SAN shared across tenants**                                                                         | new    |

> **C-04:** the v1 rule "uploads are served from a separate asset origin" is preserved, but that origin is now **per-tenant on its own domain** (`purpose = assets`), not a shared platform host. The security property (separate from the app origin, preventing SVG-based XSS) is fully preserved, and cross-tenant correlation is eliminated.
>
> If your panel's HTML fingerprint is recognizable, every tenant gets filtered together. A certificate with a shared SAN means your entire customer map sits in public Certificate Transparency logs.

### 13.5 Public Pages

```
TenantPage(slug, languageCode, title, bodyMarkdown, bodyHtmlCache,
           status, publishedAt, version, updatedBy)
    slugs: about | terms | privacy | refund | contact | faq | docs
    status: draft | published | archived
```

- **Markdown is rendered server-side and sanitized via an allowlist**: no `<script>`, `<iframe>`, `<style>`, no event handlers, no `javascript:`
- **Sanitization happens at render time, not only at save time** — tightening the policy retroactively applies to old content. The HTML cache is keyed by the sanitizer version
- **Versioning:** every edit writes a new `version`
- **Language fallback:** a missing translation falls back to the tenant's default language. An empty terms page is a legal risk, not a cosmetic bug
- F-1305: a per-tenant docs page on its own domain

**The platform provides no default legal text** — not a document, not a fill-in-the-blank template. Identical text across fifty reseller sites would be the clearest possible evidence that these are one operation with different logos.

### 13.6 Trust Badges (eNamad and similar)

```
TrustBadge(domainId, kind, code, imageUrl, linkUrl, placement,
           status, verifiedAt, createdBy)
```

**Per domain, not per tenant.** A badge is stored as **structured data, never as the HTML or script the issuer provides**. The snippet is parsed on input; only `code` and, optionally, a hosted copy of the image are stored. Rendering comes from a template we own.

> Every badge issuer's instructions tell the site owner to paste a script tag. Doing what the instructions say hands each reseller a stored-XSS tool against their own customers — and the fact that they pasted it themselves doesn't make it any less our fault.

### 13.7 Theme System

```
TenantTheme(name, basePreset, mode, tokens JSONB, tokensVersion, isDefault)
    mode: light | dark
```

- **A versioned token contract** (`ThemeTokensV1`). `tokens` only stores the **diff** from the base preset
- **Light/dark mode** resolves a `system` preference
- **Two-layer validation:** a token-name whitelist + a closed grammar per type — hex, `rgb()`, `rgba()`, `hsl()`, a constrained form of `linear-gradient()`, bounded numbers with units. `url()`, `expression()`, `var()`, `/*`, `;`, `}`, and `<` are rejected
- **The renderer re-validates before publishing the style block**
- `AVAILABLE_THEMES` is a **runtime** list, not compile-time — adding a new preset needs no deploy

### 13.8 Branding and SEO

```
TenantBranding(brandName, logoLightUrl, logoDarkUrl, faviconUrl,
               supportContact, socials JSONB, ogImageUrl)
```

- SEO per domain: `robots.txt`, `sitemap.xml`, canonical URLs, and `og:image` are **generated per domain**
- A sitemap only lists that domain's own pages. Cross-listing would be both a tenant leak **and** an SEO penalty
- Every tenant-supplied string rendered into HTML — especially the brand name — is escaped at render time
- Uploads are served from the **tenant's own asset origin** (C-04) and count against a storage quota
- An uploaded SVG is **never served from the app origin**
- F-708: a social sharing link with a preview of the tenant's brand

### 13.9 Reseller-Specific (BYO) Integrations

- **Telegram / Bale** — the token is a vault reference, not ciphertext on the row
- **SMS** — `provider`, `apiKey` (vault), and `senderLine` per tenant
- **Payment gateway** — per-tenant merchant credentials from the vault (mandatory on every plan, C-19)
- **CDN and DNS** — the tenant's own account (F-111)
- **AI** — the tenant's own key and model (§24, D-03)

**The payment callback URL is always `https://<tenant-panel-domain>/api/payments/<gateway>/callback`, never a platform hostname.**

### 13.10 Browser-Level Isolation

Frontend API calls are **same-origin**. A default pointing at the platform's API hostname would expose the platform's identity in the browser's Network tab, on a reseller's own domain.

**A defined exception (C-16):** the `purpose = subscription` domain is intentionally a separate origin, but the frontend never calls it — only the VPN client app hits it. So the panel's same-origin property isn't violated.

---

## Section 14 — Panel Business: Plans, Subscriptions and Traffic Wallet

### 14.1 Two Products, Sold Separately

|             | **Panel subscription**                        | **Traffic**                                           |
| ----------- | --------------------------------------------- | ----------------------------------------------------- |
| What's sold | software: an account with features and limits | bandwidth on platform nodes                           |
| Priced by   | feature tier + limits                         | gigabytes consumed × quality multiplier               |
| Billing     | periodic, recurring                           | **prepaid balance only**                              |
| Mandatory?  | yes, always                                   | no — a reseller can run entirely on their own servers |

**The panel subscription price is never a function of gigabytes.** Mixing the two turns a software subscription into a bandwidth bill — and bandwidth billing is a commodity someone always sells cheaper.

**Traffic is prepaid** (D-05). No traffic credit, no traffic invoice, and no traffic debt — ever.

### 14.2 Plans as Data

```
Plan(key, name, priceUsdMicro, billingPeriod, isPublic, status)
PlanFeature(planKey, featureKey, limitValue)
```

**A plan definition is data, not code.** Changing a limit is an admin action with an audit row, not a deploy.

**Initial plans — rewritten after C-01, C-03, C-19:**

|                                   | **Starter**      | **Pro**      | **Business** | **Internal** |
| --------------------------------- | ---------------- | ------------ | ------------ | ------------ |
| **Custom domain**                 | ✅ **mandatory** | ✅ mandatory | ✅ mandatory | ✅           |
| Panel domains                     | 1                | 3            | 10           | ∞            |
| Subscription domains (`/sub`)     | 1                | 2            | 5            | ∞            |
| Warm standby domains              | 1                | 2            | 5            | ∞            |
| **Mandatory legal pages**         | ✅               | ✅           | ✅           | ✅           |
| Additional public pages           | 0                | 3            | 6            | ∞            |
| Trust badge                       | ✅               | ✅           | ✅           | ✅           |
| Custom SEO                        | ✅               | ✅           | ✅           | ✅           |
| Logo and brand                    | ✅               | ✅           | ✅           | ✅           |
| End-user count                    | 500              | 5,000        | 50,000       | ∞            |
| Staff seats                       | 2                | 5            | 15           | ∞            |
| Panel count                       | 3                | 15           | 100          | ∞            |
| Custom themes                     | 1                | 3            | 10           | ∞            |
| **Dedicated gateway**             | ✅ **mandatory** | ✅           | ✅           | ✅           |
| Gateway count                     | 1                | 3            | 10           | ∞            |
| Multi-account card-to-card        | —                | ✅           | ✅           | ✅           |
| Bank SMS parsing                  | —                | —            | ✅           | ✅           |
| Telegram bot                      | 1                | 2            | 5            | ∞            |
| Bale bot                          | —                | ✅           | ✅           | ✅           |
| Dedicated SMS line                | —                | —            | ✅           | ✅           |
| **Reseller tiers**                | 0                | 1            | 2            | ∞            |
| Reseller promoted to child tenant | —                | —            | ✅           | ✅           |
| Import and migration              | ✅               | ✅           | ✅           | ✅           |
| **Own panel (BYO)**               | ✅               | ✅           | ✅           | ✅           |
| Platform panel                    | ✅               | ✅           | ✅           | ✅           |
| Own AI (BYO)                      | ✅               | ✅           | ✅           | ✅           |
| Tenant-side AI relay              | —                | ✅           | ✅           | ✅           |
| Public API                        | —                | —            | ✅           | ✅           |
| Outbound webhooks                 | —                | ✅           | ✅           | ✅           |
| Priority support                  | —                | —            | ✅           | ✅           |
| Full data export                  | ✅               | ✅           | ✅           | ✅           |

**Three key points:**

1. "Own panel" is available on **every plan**. Restricting it would push the smallest resellers onto platform infrastructure — exactly the opposite of what a healthy risk profile wants
2. "Custom domain" and "dedicated gateway" are no longer plan features — they are **entry requirements** (D-01, D-03)
3. "Full data export" is on every plan, in every state, even `suspended`

### 14.3 Per-Customer Exceptions

Entitlements are **derived from the plan at assignment time and then stored per tenant**. This is what allows a single tenant to be given an exception without inventing a new plan tier.

Editing a plan **does not retroactively rewrite already-assigned entitlements**, unless explicitly reapplied.

### 14.4 Safe Downgrade

A downgrade that would violate a current count is **rejected with a message stating exactly what must be removed first**:

> "You have 12 domains; Starter allows 1; remove 11 to continue."

It never silently disables the excess, because a reseller's own customers sit behind those domains.

### 14.5 Traffic Wallet

```
TrafficWallet(tenantId, balanceMicro, lowBalanceThresholds JSONB,
              autoTopupRule JSONB)
    CHECK (balanceMicro >= 0)
TrafficLedgerEntry(tenantId, kind, amountMicro, bytesAttributed, sourceRef)
    kind: topup | usage_debit | adjustment | reversal
```

- **`balanceMicro >= 0` is a database constraint**, not an application check
- **At zero balance:** provisioning on platform panels is disabled. **The tenant's own panels remain untouched**
- **Low-balance alerts** at configurable thresholds, through the tenant's own channels
- **Automatic top-up at a threshold** (F-810) — with explicit consent, from the tenant's own wallet or gateway. Still prepaid, with no credit whatsoever
- Attributed bytes are reconciled **exactly** against debited microdollars; any mismatch is Sev-1

### 14.6 Subscription Lifecycle State Machine

```
active ──expiry──► grace ──7 days──► read_only ──30 days──► suspended ──60 days──► deleted
   ▲                 │                │                      │
   └──── payment ─────┴────────────────┴──────────────────────┘   (reactivation)
```

| Phase       | Days since expiry | Reseller's panel                                                                   | Their end users   |
| ----------- | ----------------- | ---------------------------------------------------------------------------------- | ----------------- |
| `grace`     | 0–7               | full functionality, warnings shown                                                 | unaffected        |
| `read_only` | 7–37              | login, view, export, pay. **No** new users, sales, provisioning, or config changes | service continues |
| `suspended` | 37–97             | login, export, and pay only                                                        | service stopped   |
| `deleted`   | 97+               | deleted                                                                            | deleted           |

- **`read_only` is enforced at the service layer, not the UI** (F-1208)
- **Anti-abuse rule:** the full grace period applies **once per rolling 12 months**
- **Six mandatory notices**, on days −7, 0, 7, 30, 60, and 90. **Deletion is blocked if any notice failed to send**
- **Reactivation** from any state prior to deletion immediately restores prior entitlements on payment

### 14.7 Protecting Reseller End Users

End-user Grants suspended because of the _tenant's_ subscription carry the reason `tenant_suspended` and are restored on reactivation. **They are never `cancelled`**, because cancellation is one-way, and destroying a paying end user's entitlement over their reseller's billing dispute is unacceptable.

### 14.8 Data Export and Deletion

**A reseller can always take their data and leave** (F-212). This is a product decision, not a compliance checkbox: it's the single thing that makes a small operator willing to build their business on someone else's panel.

**Contents:** users, Grants, quotas, invoices, ledger rows, config metadata (never secrets), support conversations, pages, themes, domains, bot-user mappings, the reseller tree, and audit rows.

- **Asynchronous**, with a **short-lived signed URL**, and the **delivery itself is audited**
- **Available in every state including `suspended`, never behind a paywall**, limited to once per 24 hours
- Deletion is a soft-delete with a reversible window, then an irreversible pass
- Audit rows describing deleted entities **survive**

**Completeness test:** an automated test enumerates every table in tenant-owned schemas and **fails if any of them is handled by neither export nor deletion**.

---

## Section 15 — Multi-Tier Reseller

> **C-15:** a reseller is a **node in a tree inside the tenant**, not a separate tenant — unless promoted to a child tenant.

```
identity.ResellerNode(tenantId, path ltree, parentId, ownerUserId,
                      displayName, status, creditAccountId,
                      pricingRule JSONB, limits JSONB)
    unique (tenantId, path)
```

Every `User`, `Grant`, `Conversation`, `Campaign`, and `Panel` has a `resellerPath`. RLS is enforced via `tenantId` + `path <@ currentPath`.

| #     | Feature                                                            | Status | Notes                                                                                                     |
| ----- | ------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------- |
| F-901 | Reseller hierarchy (at least 2 levels, tree model from day one)    | new ⭐ | the #1 ask in the Iranian market and a direct plan upsell                                                 |
| F-902 | Reseller credit balance, separate from the user wallet             | new    | `reseller_credit` account in the `tenant_billing` tree                                                    |
| F-903 | Reseller pricing: multiplier or dedicated price list               | new    | The multiplier applies to the **dollar** price, before FX conversion                                      |
| F-904 | Reseller caps: user count, volume, max allowed discount            | new    | via the same `checkLimit`                                                                                 |
| F-905 | Reseller profit report and **internal settlement** (no withdrawal) | new    | entirely inside `tenant_billing` — D-05                                                                   |
| F-906 | RLS and audit down to the reseller level                           | new    | §3.12                                                                                                     |
| F-907 | Separate brand and bot for a reseller                              | new    | **promotion to a child tenant** — which is then subject to D-01/D-03 and needs its own domain and gateway |
| F-311 | Reseller management panel inside the bot                           | new    | §10.4                                                                                                     |
| F-312 | Sub-reseller panel inside the bot                                  | new    | §10.4                                                                                                     |

**Hard rule:** a reseller never has direct access to `Panel.credential` or the vault, even for a panel it added itself. Panel ownership by a reseller is recorded in `Panel.ownerResellerPath`, and its alerts go to them (C-18).

---

## Section 16 — Migration, Import and Onboarding

The only real reason a reseller says "no" is fear of migration. This section targets that fear directly.

| #      | Feature                                                                                                              | Status  | Why                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| F-201  | Import from Marzban, Marzneshin, legacy x-ui, 3x-ui, S-UI, Hiddify                                                   | new     | —                                                                         |
| F-202  | Import: user, quota, consumed usage, expiry, active/inactive status, protocol                                        | new     | —                                                                         |
| F-203  | **Legacy Link Adoption**                                                                                             | new ⭐  | C-17 — the end user does nothing                                          |
| F-204  | Domain takeover mode — the old panel domain points to TXNet and the old `/sub` path keeps responding                 | new     | migration is fully invisible                                              |
| F-205  | Gradual migration — TXNet configs sit alongside legacy configs in the same link, with the share increasing over time | new     | zero risk; you can roll back if it breaks                                 |
| F-206  | Dry run with a diff report before commit                                                                             | new     | a blind import against 3,000 users happens exactly once                   |
| F-207  | Incremental, **idempotent** import based on remote identity                                                          | new     | run it repeatedly, no duplicates                                          |
| F-208  | Usage baseline carry-over — `billedBytes` set from prior usage                                                       | new     | §8.6                                                                      |
| F-209  | CSV import of wallets and user balances                                                                              | new     | every row is an `adjustment` transaction with a reason and an audit trail |
| F-210  | **Legacy bot-user mapping**                                                                                          | new     | §10.5                                                                     |
| F-211  | An N-day rollback window with the source state preserved                                                             | new     | reduces decision-maker anxiety                                            |
| F-212  | **Full data export at any moment**                                                                                   | new     | §14.8 — anti-lock-in                                                      |
| F-213  | Onboarding wizard: connect panel → import → pricing → **domain** → gateway → bot → first sale                        | changed | order changed: domain and gateway are now mandatory (D-01, D-03)          |
| F-214  | Sandbox environment with a fake driver and sample data                                                               | base    | §7.1                                                                      |
| F-1532 | AI onboarding and migration co-pilot                                                                                 | new     | §24                                                                       |

**Hard import rules:**

- Import **never** writes directly into the tables. It creates a `MigrationRun`, generates a dry run, and only commits after confirmation
- Every imported record gets `Grant.source = migration` and a `remoteIdentity` — the idempotency key
- The source panel is read as **adversarial input**: count caps, volume caps, timeouts, no following redirects into internal networks
- A money import (F-209) creates a real ledger transaction, not an `UPDATE` on a balance — otherwise the first nightly reconciliation fires a Sev-1

---

## Section 17 — Retention, Anti-Churn and Growth

### 17.1 Retention

| #      | Feature                                                                                                 | Status  | Notes                                                       |
| ------ | ------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------- |
| F-601  | Multi-threshold usage and time notifications                                                            | partial | §9.5                                                        |
| F-602  | Volume exhaustion prediction                                                                            | new     | rule-based; AI version in F-1515                            |
| F-603  | 24-hour post-expiry grace period                                                                        | changed | for all Grant types                                         |
| F-604  | **Unused-volume rollover**                                                                              | new     | C-09 — via the `QuotaAdjustment` path                       |
| F-605  | Automatic win-back campaign: expired + N days of silence → dedicated coupon in the bot                  | new     | the cheapest revenue possible                               |
| F-606  | Loyalty tiers (cumulative volume → bonus volume or an upgrade)                                          | new     | reward is volume only, never cash                           |
| F-607  | Gifting/transferring volume between users of the same tenant                                            | new     | via `wallet_transfer` OTP, viral, money stays in the system |
| F-608  | Family sub-accounts with a shared quota                                                                 | partial | `sharingPolicy: shared_pool` exists; UI doesn't             |
| F-609  | Native display of remaining quota in the client app                                                     | base    | §7.5                                                        |
| F-610  | A one-question survey on non-renewal                                                                    | new     | the only real data on why people churn                      |
| F-611  | Customer health score for the reseller (churn probability)                                              | new     | a timely-intervention tool                                  |
| F-1519 | Reason-driven churn path: if the risk is **connection quality**, quality gets fixed, **not a discount** | new     | §24                                                         |

### 17.2 Growth and Acquisition

| #     | Feature                                                        | Status         | Notes                                                   |
| ----- | -------------------------------------------------------------- | -------------- | ------------------------------------------------------- |
| F-701 | **Referral system — reward as volume, not cash**               | changed (C-11) | entered the core. Volume = no KYC, no withdrawal (D-05) |
| F-702 | Two-sided reward (referrer and referee)                        | new            | multiplies conversion rate                              |
| F-703 | Referral link and code, live stats, referral tree in the bot   | new            | —                                                       |
| F-704 | Referral anti-fraud: device fingerprint, number, usage pattern | new            | without this, a referral system is just a leak          |
| F-705 | **Free trial funded from the reseller's own share**            | changed (C-10) | the _platform's_ free trial remains removed             |
| F-706 | One trial per (tenant × fingerprint × number)                  | new            | —                                                       |
| F-707 | Lucky wheel and interactive mechanics                          | next-phase     | `engagement` schema ready                               |
| F-708 | Social sharing link with the tenant's brand preview            | new            | §13.8                                                   |
| F-709 | UTM and campaign attribution down to purchase                  | new            | resellers can see which channel actually brings money   |
| F-314 | Bot login deep link                                            | new            | bridges campaign, site, and bot                         |
| F-318 | Channel-membership gate for a free trial                       | new            | cheap, common growth tactic in this market              |

**Reward accounting rule:** any gifted volume (referral, loyalty, trial, wheel) writes a row into `promotional_liability` and is factored into the **treasury coverage ratio**. A free reward that never touches the ledger is an invisible debt.

---

## Section 18 — Reseller Profitability Tools

Resellers today fly blind; this section alone could be reason enough to stay.

| #      | Feature                                                                   | Status    |
| ------ | ------------------------------------------------------------------------- | --------- |
| F-1001 | Revenue, cost, and margin dashboard per user / panel / product / reseller | new       |
| F-1002 | Bandwidth cost attribution to the panel owner                             | base      |
| F-1003 | "This user costs more than they pay" alert                                | new       |
| F-1004 | Cohort and LTV by acquisition channel                                     | new       |
| F-1005 | Usage forecast and capacity planning                                      | new       |
| F-1006 | Scheduled report to bot or email                                          | new       |
| F-1007 | CSV/Excel export of every report                                          | new       |
| F-1527 | Plan-layout suggestions based on actual user consumption distribution     | new (§24) |
| F-1528 | Margin analysis and loss-making-plan alert                                | new (§24) |

**Rule:** all of these reports read only from the `tenant_billing` tree (§5.2). No reseller report ever sees a number from `platform_billing`.

---

## Section 19 — Security, Fraud and Abuse

### 19.1 Three Unrecoverable Risks

Everything else can be fixed with a new release. These three cannot:

1. **Cross-tenant data leakage** — covered by RLS, tenant detection, six isolation layers, an automated harness
2. **Silent money leakage** — covered by the double-entry ledger, treasury, reconcilers, byte-for-byte end-to-end tests
3. **Credential exposure** — covered by the vault, the logger's redaction list, and the "never in any response" rule

An automated test **greps the entire test-run log output for a known secret and fails if it appears**. Discipline about not logging secrets isn't a policy here; it's a test.

### 19.2 Input Handling

- Validation with **Zod, right at the route**, and nowhere else
- Tenant markdown is rendered server-side and sanitized via an allowlist
- Theme tokens are validated against a closed grammar, **both before saving and before publishing**
- Uploads: content-type sniffing, size caps, per-tenant quota, served from the **tenant's own asset origin** (C-04)
- **AI output is also input** (F-1542): every number must exist in the input, length is capped, no HTML, no injected links

### 19.3 Transport and Edge

- TLS at Traefik, HSTS, no mixed content
- Identity headers are stripped from the incoming request **before** ForwardAuth
- A shared-secret header between the CDN and origin + an origin firewall restricted to CDN ranges — **the origin IP is never exposed**
- Coarse per-IP rate limiting at the edge, identity-precise limiting in services
- **Unknown host = neutral 404** (§20.2)

### 19.4 Fraud and Abuse Detection

```
fraud.FraudFlag(tenantId, resellerPath, userId, kind, severity,
                evidence JSONB, status, raisedAt, resolvedAt,
                resolvedByAdminId, note)
```

| #      | Feature                                                                | Status    |
| ------ | ---------------------------------------------------------------------- | --------- |
| F-1101 | Concurrent-device cap from distinct IPs                                | base      |
| F-1102 | **Link-sharing detection** — multiple ISPs or cities simultaneously    | new       |
| F-1103 | Graduated response: warn → restrict → suspend (never an abrupt cutoff) | new       |
| F-1104 | Abnormal usage pattern detection and delta quarantine                  | base      |
| F-1105 | Node abuse policy (port scanning, spam) with automatic suspension      | new       |
| F-1106 | User risk score and fraud freeze                                       | base      |
| F-1107 | Rate limiting on account creation, free trials, and OTP                | base      |
| F-1108 | Per-tenant device-fingerprint blocklist                                | new       |
| F-704  | Referral anti-fraud                                                    | new       |
| F-1524 | AI-based fraud risk scoring at signup, trial, and referral             | new (§24) |

**Signals, in order of usefulness:**

1. Configs of a single Grant appearing simultaneously from an implausible number of distinct IPs or locations
2. Signup velocity from one IP range
3. Top-up-then-immediate-refund pattern
4. A coupon consumed across multiple accounts sharing one device fingerprint

**Two hard rules:**

- **Fraud detection never alters usage or billing figures.** It flags and may freeze a Grant. Bytes consumed remain bytes consumed. The moment fraud logic is allowed to adjust a meter, the meter stops being evidence
- **A fraud flag never auto-deletes an account and never auto-refunds.** It suspends and queues for a human, because a false positive that deletes a paying customer's data is worse than the fraud it caught

**A third rule (added for F-1102/F-1522):** sharing detection never cuts off on its own. The mandatory path is: warn the user → restrict devices → suspend. A real family on two ISPs looks exactly like a sold link.

### 19.5 Reseller Risk

**A reseller is a customer, not a trusted operator.** Every value a reseller supplies — domain, page markdown, theme tokens, badge snippet, brand name, bot token, **AI prompt, AI provider address, source-panel URL during migration** — is treated as **adversarial input**.

---

## Section 20 — Governance, Isolation, Treasury and Audit

### 20.1 Audit Log

```
AdminAuditLog(tenantId, resellerPath, adminId, action, targetEntityType,
              targetEntityId, oldValue JSONB, newValue JSONB, reason,
              adminIpAddress, userAgent, createdAt)
```

- Any admin action that changes money, access, role, or account status writes an audit row **in the same transaction as the change**. Not later, not asynchronously. **If the audit write fails, the change itself fails**
- Audit rows are **append-only** and never deleted, even when the target user or the whole tenant is deleted
- Before and after values are stored as JSONB — so you can see exactly what changed to what
- **Visible to the tenant itself** (F-1202), scoped to its own subtree
- **Every AI message is labeled and auditable** (F-1509)

### 20.2 Multi-Tenant Isolation — Six Layers

1. **Database** — Row-Level Security in PostgreSQL on `(tenantId, resellerPath)`, plus a **separate** role and connection pool for cross-tenant admin reads. Bypassing RLS on the normal pool is **not possible**
2. **Application** — a tenant-scoped Prisma extension; every query passes through `withTenant`
3. **Automated harness** — a test suite that measures isolation. This is the layer that still works after code is written by someone who never read this document
4. **Queues** — a per-tenant concurrency cap
5. **Integrations** — a tenant's gateway/SMS/bot/AI credentials are its own; a failure stays confined to that tenant
6. **Rate limiting** — per-tenant buckets at the edge

### 20.3 Tenant Detection

> **C-01 — the corrected chain:**
>
> **verified custom domain → `X-Tenant-Id` header, only on platform-staff tokens**
>
> "Platform subdomain" has been **removed** from this chain.

- **No code outside the resolver ever reads the `Host` header.** One reader, one decision, one context object
- An unknown or unverified host returns a **neutral 404 at the edge**. It must not render the platform's own site, must not reveal that a platform exists, and must **never fall back to a platform tenant**
- The `host → tenantId` cache in Redis is **explicitly** invalidated on creation, verification, standby switchover, and domain deletion — not merely by TTL. A stale mapping after a domain switch is a cross-tenant leak, not just a stale page
- A `purpose = subscription` domain resolves to the same tenant, but **no panel route is served on it** — a path allowlist at the edge

### 20.4 Credential Vault

```
TenantCredential(tenantId, kind, label, ciphertext, iv, authTag, dekId,
                 fingerprint, status, version, createdBy, rotatedAt,
                 lastUsedAt, expiresAt)
TenantDek(tenantId, wrappedKey, kekId, createdAt, retiredAt)
```

- **Envelope encryption**: one DEK per tenant, wrapped by a KEK held **outside the database**. AES-256-GCM, a per-record IV, stored auth tag
- **Supported types:** Telegram bot token, Bale bot token, SMS API key, SMS sender line, gateway merchant ID, gateway secret key, panel credentials, webhook secret, **AI provider API key**, **source-panel credentials during migration**, **tenant CDN/DNS credentials**
- **Fingerprint** — a truncated hash of the plaintext, which answers "is this the same value I already have?" **without revealing anything**
- **Versioned rotation:** the previous version is kept for a grace window so an in-flight webhook can still verify, then destroyed
- **Every decryption writes an audit row**: who, which tenant, which type, which caller. **Never the value itself**
- **Expiry dates** are supported on every credential

**Two hard guarantees:**

1. No API response, log line, or audit row ever contains the vault's plaintext. The admin UI only ever returns `{ configured, fingerprint, lastUsedAt, status }` — **including for the highest-ranking role**
2. No tenant-owned credential is ever read from an environment variable. A service **refuses to boot** if an environment variable matches a tenant credential type — because a leftover `TELEGRAM_BOT_TOKEN` or `OPENAI_API_KEY` in `.env` is exactly how the no-fallback rule accidentally gets violated

### 20.5 The 360° User View

Not a table — a composite read across domains: profile · sessions · wallet and balance · ledger history · invoices · Grants with quota bars · active configs and their panels · ISP and last successful connection · support conversations · notification delivery log · fraud flags · AI attention budget · audit rows where they were the target.

Runs on the **platform admin connection pool**, is fully audited, and **never exposes secrets** — not even to a SuperAdmin.

### 20.6 User Settings

```
governance.UserSetting(userId, key, value)
```

A per-user key-value system, for anything that doesn't need a dedicated column.

---

## Section 21 — Platform Management Console

A distinct tier with a distinct permission set, running on the admin connection pool. **The only part of the product that lives on the platform domain** — and no end user ever sees it (D-01).

**Scope:**

- List of resellers with subscription and traffic status
- Creating, suspending, and reactivating resellers
- Plan assignment and **per-tenant entitlement exceptions**
- Platform panel inventory with **bandwidth cost per reseller**
- **Money dashboard:** ledger deviation, treasury coverage ratio, failed payments, quarantined usage deltas
- **Domain health dashboard:** in-Iran probe results, domains currently being filtered, recent emergency switchovers
- Audit search
- Onboarding console for new tenants (before their domain is verified)

**Guarantees:**

- Every admin action writes an audit row **in the same transaction**
- A platform-staff token can never be used as a tenant token — the guard checks the **subject type**, not merely permissions
- No secret ever appears in any response, including for the highest-ranking role

---

## Section 22 — Public API and Integration

| #      | Feature                                                                               | Status |
| ------ | ------------------------------------------------------------------------------------- | ------ |
| F-1301 | Public API with a per-tenant key (plan feature `api.public`)                          | base   |
| F-1302 | **Outbound webhooks** for events (purchase, expiry, volume exhaustion, domain change) | new    |
| F-1303 | Embeddable sales widget/iframe for a reseller's site                                  | new    |
| F-1304 | Lightweight JS and PHP SDKs                                                           | new    |
| F-1305 | Per-tenant docs page on its own domain                                                | new    |

**Fixed rules:**

- A **standard response envelope** for every endpoint
- An **idempotency key** on every money-moving operation
- **Cursor-based pagination** — offset pagination on any table that can exceed 10,000 rows is **forbidden**
- i18n message keys, a permission key, a rate-limit rule, and documentation are mandatory for **every** endpoint — missing any one of these four leaves the change incomplete
- **Outbound webhooks are sent from the tenant's own domain** (F-112) and signed with a per-tenant shared secret
- The embeddable widget (F-1303) loads from the **tenant's own domain**, not the platform — otherwise D-01 gets violated on the reseller's own site

---

## Section 23 — Monitoring, Reconciliation and Operations

### 23.1 Nightly Reconciliation (03:00 UTC)

Seven independent jobs:

1. **Daily usage roll-up** — idempotent via `ON CONFLICT DO UPDATE`
2. **Deletion of partitions older than 30 days**
3. **Quota reconciliation** — for every active Grant, recompute from deltas and compare. Mismatch → finding logged, alert fired, and **never silently rewritten**
4. **Ledger reconciliation** — for every wallet and traffic wallet, sum the rows against the cached balance. Any mismatch is **Sev-1**
5. **Provisioning drift** — orphans (ours, deleted there) → deleted. Missing (here, not there) → re-provisioned. Unknown (never ours) → **report only, never touch**
6. **Traffic attribution** — total platform bandwidth per reseller
7. **Domain and certificate reconciliation** (new) — any `verified` domain whose TXT, CNAME, or certificate has drifted, and any `standby` whose certificate isn't fresh → finding + alert. A cold standby is useless in a crisis (F-115)

**Critical rule:** reconcilers **only report and repair in the direction that can't lose money**. Rebuilding a missing config is safe. Rewriting a quota is not — that always needs a human.

Every run writes a row with counts and findings, shown on the dashboard. **"Everything is fine" means a visible daily green check, not silence.** Silence is indistinguishable from a dead cron job.

### 23.2 End-to-End Money-Leak Test

A known amount of usage is generated against the fake driver, and it's asserted that **billed bytes exactly equal consumed bytes — down to the byte**. The single most important test in the entire repository.

### 23.3 Business Metrics Alongside System Metrics

Prometheus + Grafana + Loki + Alertmanager on a **separate server**.

- Active Grants, broken down by tenant and status
- Provisioning failures and convergence backlog
- Usage delta latency
- Quarantined deltas
- Ledger deviation and treasury coverage ratio
- Gateway error rate and mismatched-callback queue depth
- Subscription lifecycle transitions and failed notices
- Traffic wallet balances near zero
- **Success rate per (ISP × inbound)** and its drop slope
- **In-Iran domain probe status**
- **AI template-fallback rate, latency, and token usage per tenant**

### 23.4 Alert Severity Levels

| Level     | Meaning                                       | Example                                                                                                                                         |
| --------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sev-1** | Money or access is wrong right now            | ledger deviation, quota mismatch, coverage ratio below floor, cross-tenant test failure, a tenant's primary domain dead with no healthy standby |
| **Sev-2** | A subsystem is degraded and will become Sev-1 | panel unhealthy > 10 min, stale rate > 60 min, growing delta latency, non-empty dead-letter queue, expired standby certificate                  |
| **Sev-3** | Needs attention, not urgent                   | mismatched callback in queue, an aging pending treasury conversion, a high AI fallback rate                                                     |

**Every alert links to a runbook.** An alert with no runbook gets ignored at 3am.

### 23.5 Backup and Recovery

**A backup that has never been restored is not a backup.** A **monthly** restore drill runs against a scratch database, and the result is logged with a date and a name. Backup and restore of tenant data also exist as a first-class capability (F-1204).

Load testing (k6) covers exactly three paths: **the subscription endpoint, usage ingestion, and purchase settlement**.

---

## Section 24 — The AI Layer

> **Governing rule:** AI never speaks in order to "sell." It speaks to **solve a problem** and to **give the user information they don't have**; a sale is a side effect. Any message that's purely a CTA with no new information is forbidden.
>
> **D-04:** AI is a decorative layer on top of a deterministic base. The factory default is off.

### 24.1 Anti-Annoyance Mechanisms (These Come First, Before Any Feature)

| #      | Feature                                                                                          | Why                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1501 | A per-user **attention budget** — every proactive AI message has a cost and a periodic cap       | The only structural way to guarantee the system can't overdo it. **Lives in the `engagement.AttentionBudget` table, never in the ledger (C-13)** |
| F-1502 | Answering a user's own question **costs no budget**; only AI-initiated messages cost anything    | Answering isn't nagging; initiating is                                                                                                           |
| F-1503 | A confidence threshold — below it, the AI **stays silent**                                       | One irrelevant suggestion hurts more than ten good ones not given                                                                                |
| F-1504 | Cooldown per (user × suggestion type)                                                            | —                                                                                                                                                |
| F-1505 | "Don't show me this again" with one tap, permanent, per type                                     | —                                                                                                                                                |
| F-1506 | Quiet-down rules: open ticket, after a failed payment, connection-quality drop, during an outage | Pitching a purchase in the middle of a problem is the worst possible moment                                                                      |
| F-1507 | At most **one CTA per message**; no artificial urgency, no false scarcity, no guilt-tripping     | enforced at the prompt level **and** at output validation                                                                                        |
| F-1508 | A permanent control group (holdout) that receives no AI messages at all                          | The only way to actually prove AI drives sales                                                                                                   |
| F-1509 | Every AI message is labeled and auditable; a reseller can fully disable any type                 | It's their brand                                                                                                                                 |

### 24.2 AI for the End User

| #      | Feature                                                                                                                                           | Why                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| F-1510 | **A tool-using support agent** — reads real state before speaking: quota, panel health, ISP, device count, client app, last successful connection | ⭐ 2am, in Persian, no ticket needed                                             |
| F-1511 | Diagnosing the root cause of "I can't connect" and giving **exactly that fix**                                                                    | Half of this market's tickets are that one sentence                              |
| F-1512 | Interactive install guide tailored to the user's OS and app                                                                                       | —                                                                                |
| F-1513 | Smart escalation to a human, with a full diagnostic summary                                                                                       | An AI that doesn't know when to step back is itself the problem                  |
| F-1514 | **Suggesting a smaller plan when a user has over-bought**                                                                                         | ⭐ the most counterintuitive and effective move                                  |
| F-1515 | Volume-exhaustion prediction with **one** well-timed message                                                                                      | Information, not begging                                                         |
| F-1516 | Explaining abnormal usage ("yesterday it tripled; if that wasn't you, your link may be in use elsewhere too")                                     | Both security and sales, with no sales smell                                     |
| F-1517 | Suggesting a better region/server based on actual ISP and usage-time patterns                                                                     | Immediate, tangible value                                                        |
| F-1518 | Natural-language queries over the user's own account                                                                                              | —                                                                                |
| F-1519 | Reason-driven churn path: a quality problem → quality gets fixed, **not a discount**                                                              | Discounting someone whose problem is an outage burns both money and the customer |

### 24.3 Invisible AI (No User-Facing Text — the Highest-Value Tier)

| #      | Feature                                                                                    | Reference                                          |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| F-1520 | Learning success rate (ISP × inbound × hour) and automatically selecting the best config   | the engine behind F-402 ⭐                         |
| F-1521 | Predicting an inbound getting blocked from the drop trend, rotating **before** full outage | §7.7                                               |
| F-1522 | Link-sharing-detection model                                                               | F-1102, feeds the third rule in §19.4              |
| F-1523 | Usage-anomaly detection assisting the delta-quarantine decision                            | F-1104 — **assists the decision, doesn't make it** |
| F-1524 | Fraud risk scoring at signup, trial, and referral                                          | §19.4                                              |
| F-1525 | Forecasting a tenant's total usage for capacity planning and traffic-wallet top-ups        | F-1005                                             |

> **Hard rule:** the invisible layer, too, **never** alters a meter and never moves money automatically. The most it ever does is: routing weights, flags, and suggestions to a human.

### 24.4 AI for the Reseller (Here It Can Be Chatty — They Want a Staff Member)

| #      | Feature                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------- |
| F-1526 | Natural-language questions over their own data ("how many people didn't renew last month, and why?") |
| F-1527 | **Plan-layout suggestions** based on actual consumption distribution across their users ⭐           |
| F-1528 | Margin analysis and loss-making-plan alerts                                                          |
| F-1529 | Campaign segmentation suggestions + **writing copy in their own brand voice**                        |
| F-1530 | Ticket triage and reply drafting grounded in that same tenant's knowledge base                       |
| F-1531 | Daily/weekly business summary in the bot                                                             |
| F-1532 | Onboarding and migration co-pilot                                                                    |
| F-1533 | Automatic locale-content translation with human review                                               |

### 24.5 Where AI Has No Access

The payment path · enforcement and suspension decisions · generating or displaying credentials and configs · communications during an outage (rule-based templates only) · **deletion or refund decisions** · **any write to the ledger** · any decision without a deterministic, rule-based fallback.

### 24.6 AI Belongs to the Tenant, Not the Platform (BYO-AI)

**Rule (D-03):** the platform never pays for inference and never holds a key. Exactly the same `ownershipType` pattern already written for panels.

| #      | Feature                                                                                                                                              | Why                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| F-1534 | `AIProvider` with `ownershipType: tenant \| platform` — from the first migration, like `Panel.ownershipType`                                         | a familiar pattern, zero new concepts                                                                                |
| F-1535 | A generic `openai_compatible` driver + capability discovery (tool-calling, JSON mode, context length, streaming)                                     | one driver covers ninety percent of providers: OpenRouter, Groq, DeepSeek, Ollama and local vLLM, in-house providers |
| F-1536 | API key in the **vault** with envelope encryption; never logged, never returned by any API, only "configured + fingerprint"                          | the same behavior as bot tokens (§20.4)                                                                              |
| F-1537 | A per-tenant outbound proxy (SOCKS5/HTTP) to reach the provider                                                                                      | the tenant's own network path is their own problem                                                                   |
| F-1538 | **Tenant-side relay** — a small worker on the tenant's own server that reads from a job queue and calls the model itself                             | ⭐ the national-network scenario: the platform makes zero outbound requests at all                                   |
| F-1539 | Model selection **per task**                                                                                                                         | cost control stays in their hands                                                                                    |
| F-1540 | **Always falls back to a template** — error, timeout, invalid key, quota exhausted → the template renders, the user sees no error                    | D-04                                                                                                                 |
| F-1541 | A hard time budget (default 3 seconds); after that, the template wins                                                                                | a bot reply must never be held hostage by a third-party API                                                          |
| F-1542 | Output validation before sending: every number must exist in the input, length capped, no HTML, no injected links, required variables present        | §19.2                                                                                                                |
| F-1543 | Two modes: **draft-with-approval** (default) and **automatic** (enabled per message type)                                                            | campaign copy, sure; payment confirmations, never                                                                    |
| F-1544 | "Test connection" + `status` / `lastErrorAt` visible to the tenant                                                                                   | the same pattern as the panel driver's `HealthCheck`                                                                 |
| F-1545 | Brand-tone prompt as **data** in `locale-service`, versioned                                                                                         | the same place the templates live                                                                                    |
| F-1546 | Token accounting and usage caps per tenant and per task                                                                                              | even when it's their money being spent, they need visibility and a brake                                             |
| F-1547 | **PII scrubbing before egress** — phone numbers, emails, subscription tokens, IDs; disabling it requires explicit confirmation                       | the end user never consented to OpenAI; the tenant's consent doesn't stand in for theirs                             |
| F-1548 | **A safety floor that can't be turned off:** the attention budget, silence during outages, bot rate limits, a ban on accessing another tenant's data | the model is theirs, the guardrails are ours                                                                         |
| F-1549 | AI provider selection **per message key**, not one global key                                                                                        | —                                                                                                                    |
| F-1550 | Factory default: AI off, default templates on, product fully functional                                                                              | most tenants never configure anything, and that's exactly right                                                      |

**A legal side benefit:** the key is the tenant's, the model is the tenant's, the text is the tenant's. The platform is purely software — the exact same stance taken on white-labeling and the payment gateway (D-03). An entire layer of liability disappears.

---

## Section 25 — Next-Phase Features

These features are **designed, with their database schemas built empty from day one**, so adding them later is incremental and schema numbering never shifts.

| #     | Feature                                             | Infrastructure Ready                                                                                                                                                                                             |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-707 | **Lucky wheel and interactive mechanics**           | `engagement` schema; `Grant.source = affiliate_reward`; `free_grant` coupon; `promotional_liability` account; notification and bot system                                                                        |
| —     | **External orders (SMM APIs)**                      | `fulfilmentKind = external_order` + a driver interface mirroring the panel driver: `Submit / Poll / Cancel`, a polling worker with backoff, **partial delivery that reduces quota and enables a partial refund** |
| —     | **Feature-based access control** (`feature_access`) | `Grant.featureKeys` + quota for `feature_items` and `api_calls`                                                                                                                                                  |
| —     | **New protocol drivers** — OpenVPN, L2TP, WireGuard | `ProtocolFamily` in the driver interface. Adding a new driver **requires no changes to billing, Grant, or UI**                                                                                                   |
| —     | **Automatic panel installation**                    | The same driver interface post-install, so no downstream code changes                                                                                                                                            |
| —     | **Self-hosted deployment**                          | The rule "no code should assume more than one tenant exists in the database" has been observed from day one                                                                                                      |
| —     | **Email as a notification channel**                 | `Template.channel` and `Preference.channels[]` are already open                                                                                                                                                  |

> **Items graduated from v1:** the referral system (→ core, C-11), family sub-accounts with a shared wallet (→ §17.1 F-608), and AI-powered recommendations (→ §24, C-12).

---

## Appendix A — Permanent Decisions (Out of Scope)

These are not deferred; they are **deliberately and permanently removed**, and each one eliminates a substantial amount of work, legal risk, or attack surface:

| Item                                                 | Reason for removal                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Withdrawal and payout to users**                   | Eliminates KYC/AML obligations, a large fraud class, and a major share of ledger complexity (D-05)                               |
| Traffic credit or postpaid traffic                   | Eliminates collections and the largest abuse vector (D-05)                                                                       |
| End-user payout by the platform                      | The reseller's gateway takes their customers' money directly; **payment-facilitator obligations are entirely eliminated** (D-03) |
| Default legal text for resellers                     | Identical text on fifty sites would be the clearest possible evidence of a single operation                                      |
| **Platform subdomain for end users**                 | **New (D-01):** one filtered tenant on your domain takes the whole platform down                                                 |
| **Shared asset origin across tenants**               | **New (C-04):** one shared, fingerprintable signature, and a violation of D-01                                                   |
| **AI key held by the platform**                      | **New (D-03):** inference cost, content liability, and end-user consent — all three eliminated                                   |
| **Platform** free test node pool                     | A reseller connects their own or pays for traffic. Testing _funded by the reseller's own resources_ is allowed (C-10)            |
| Custom fonts for resellers                           | The largest attack surface and performance cost for the smallest possible gain                                                   |
| Multi-currency wallet, wallet choice, split payments | A single, unified dollar wallet                                                                                                  |

---

## Appendix B — Mapping of v2 IDs to Sections of This Document

| Range           | Topic                                   | Sections of this document |
| --------------- | --------------------------------------- | ------------------------- |
| F-101 … F-115   | Domain and resilience against filtering | §13.1 – §13.4, §7.6       |
| F-201 … F-214   | Migration and onboarding                | §16                       |
| F-301 … F-320   | Bot as a full panel                     | §10                       |
| F-401 … F-414   | Network and connection intelligence     | §7.3 – §7.8               |
| F-501 … F-512   | Sales, pricing and campaigns            | §4.8, §6                  |
| F-601 … F-611   | Retention and anti-churn                | §17.1, §9.5               |
| F-701 … F-709   | Growth and acquisition                  | §17.2                     |
| F-801 … F-810   | Payment for the Iranian reality         | §5.5 – §5.7, §14.5        |
| F-901 … F-907   | Multi-tier reseller                     | §15                       |
| F-1001 … F-1007 | Reseller profitability tools            | §18                       |
| F-1101 … F-1108 | Anti-abuse                              | §19.4                     |
| F-1201 … F-1208 | Operations, trust and governance        | §3, §20, §14.6, §23.5     |
| F-1301 … F-1305 | API and integration                     | §22                       |
| F-1501 … F-1550 | AI intelligence layer                   | §24                       |

---

## Appendix C — Checklist for Applying Changes in Other Documents

Once this document is approved, the following must be updated in `BLUEPRINT.md` and `DECISIONS.md`:

1. **Tenant detection chain** — remove the subdomain (C-01)
2. **Plan table** — domain and gateway mandatory across the board (C-01, C-19), legal pages across the board (C-03)
3. **`TenantDomain`** — remove `isPrimary`, add `purpose` and `state` (C-16)
4. **`BotIntegration`** — change the unique key and add `role` (C-05)
5. **Asset origin** — per-tenant, not shared (C-04)
6. **`identity.ResellerNode`** and add `resellerPath` to core tables + RLS policy (C-15)
7. **`AIProvider`** and `engagement.AttentionBudget` in the first migration (C-12, C-13)
8. **Subscription-link cache key** and dynamic rate limit (C-07)
9. **`LegacyUpstream`** for legacy link adoption (C-17)
10. **`reseller_credit`** account and `reseller_settlement` transaction in the ledger (C-15)
11. **`Grant.source`** — add `trial` and `rollover` (C-09, C-10)
12. **Nightly reconciliation job** — domain and certificate (§23.1)

---
