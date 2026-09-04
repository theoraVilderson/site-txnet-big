---
id: glossary
status: active
updated: 2026-09-04
---

# Glossary

One term = one meaning across the entire project. Check here **before**
introducing any new noun. If a concept already has a name, reuse it; if you must
introduce a synonym, record why.

| Term | Meaning | Owning unit | Do NOT confuse with |
|---|---|---|---|
| User | An identity that can authenticate. Always belongs to exactly one Tenant. | identity | Tenant staff member (a role *within* a tenant), Account |
| Tenant | An isolation + branding boundary. Exactly one row is `platform_owner`; the rest are `reseller`. | tenant | User, Panel "region" |
| Platform owner | The single `tenantType = platform_owner` Tenant — you. | tenant | Reseller |
| Reseller | A `tenantType = reseller` Tenant: white-label brand with its own domain, pricing, gateway, bot. | tenant | Tenant staff, Affiliate |
| Wallet | A user's balance record. `cachedBalance` is a cache; `WalletTransaction` (append-only) is the truth. | billing | TenantBillingWallet, Sub-account |
| TenantBillingWallet | What a Tenant owes the platform. Separate ledger from user Wallet. | tenant | Wallet |
| Ledger | The append-only `*Transaction` table pattern. Balance is derived, never `UPDATE`d. | billing | cachedBalance |
| Sub-account | A shared spending pocket scoped to one Config, drawn from a parent Wallet. | billing | Wallet, Linked account group |
| Base currency | The one `Currency.isBaseCurrency = true`. All money is stored in it. | currency | Display currency, USD |
| Display currency | A per-user/-admin presentation choice applied only at render time. | currency | Base currency |
| Config | A user's VPN/proxy credential on a Panel (Xray uuid + protocol). | network | App configuration, `.env`, RemoteClient (driver-internal name for the same thing) |
| Panel (infra) | The remote VPN control install a Config lives on — x-ui / 3x-ui / Marzban / Marzneshin / S-UI / Hiddify. Wrapped by one Driver. `ownershipType` = platform \| tenant. | network | User panel (the site-pwa web app), PanelGroup, ResellerNode, Tenant |
| PanelGroup | A mirroring set of Panels (`role` = primary \| replica \| drain) resolved per variant; gives zero-downtime subscription links. | network | Panel, Cluster, ResellerNode |
| Entitlement | Whether a feature key is switched on for a Tenant (`TenantFeatureEntitlement`). | tenant | Permission (RBAC), Restriction |
| Restriction | An upper bound / cap on a user's or tenant's usage or spend. | governance / tenant | Entitlement, Permission |
| Permission | An RBAC capability key (e.g. `user.impersonate`) attached to a Role. | identity | Entitlement, Restriction |
| Session | A server-tracked login. Postgres row is the record; a Redis marker is the fast revocation check. | identity | JWT access token, Impersonation session |
| Impersonation | An admin operating as a user without their credentials; time-boxed, always audit-logged. | audit / identity | Account switch (user's own linked accounts) |
| OTP | A one-time code. **Redis is the source of truth**; the `otp_code` table is audit only. | identity | JWT `otp_login` token |
| Scope (locale) | `backend` / `frontend` / `shareds` slice of the translation tree. | i18n | Permission scope, RBAC |
| Namespace (locale) | One JSON file of keys inside a scope (e.g. `auth`, `errors`, `otp`). | i18n | Postgres schema/namespace |
| Keyspace version | `REDIS_KEYSPACE_VERSION`; bumping it abandons every Redis key at once. | redis-keyspace | Contract `version` front matter |
| ForwardAuth | The Traefik middleware backed by `auth-handler` that gates protected routes. | forward-auth | auth-api (the NestJS service) |
| User panel | The user-facing web app (`site-pwa`), served at `panel.<domain>`; unit id `panel-web`. | panel-web | Panel (infra), Traefik dashboard, admin console |
| Grant | The single unit of entitlement. A user's right to a thing, keyed by `featureKey`; every access check is "is there an active Grant?". `fulfilmentKind` = network_access \| external_order \| feature_access \| wallet_topup. | catalog / entitlement | Entitlement (tenant-level), Permission (RBAC), Plan |
| QuotaAdjustment | An append-only row that raises or lowers a Grant's quota (rollover, gift, admin top-up). A dead Grant is never revived. | catalog | Refund, adjustment ledger row |
| Subscription link | `GET https://<sub-domain>/sub/{token}` — cookieless, cross-origin-isolated endpoint that renders a Grant's configs. Redis-cached, never writes Postgres. | network | User panel, payment callback URL |
| TenantDomain | A host owned+verified by a Tenant. `purpose` = panel \| subscription \| assets; `state` = primary \| standby \| retired. No `isPrimary` flag. | tenant | Panel (infra), platform domain |
| TrafficWallet | A Tenant's **prepaid** traffic balance (`balanceMicro >= 0`, DB-enforced). Separate ledger from user Wallet and TenantBillingWallet. | tenant / billing | Wallet, TenantBillingWallet |
| Treasury | FX-risk observability (`TreasuryConversion`, `TreasurySnapshot`, coverage ratio). **Advisory only — never read on the money path.** | billing | Ledger, FX rate engine |
| AttentionBudget | `engagement.AttentionBudget` — per-user cap on AI proactive messages. **Never a LedgerAccount or LedgerEntry** (C-13). | engagement / ai | Wallet, Ledger, reseller_credit |
| Credential Vault | `TenantCredential` + `TenantDek` — envelope-encrypted per-tenant secrets (bot tokens, gateway keys, AI keys…). Admin UI only ever sees `{configured, fingerprint, lastUsedAt, status}`. | tenant / security | `.env`, plaintext config |
| LegacyUpstream | `LegacyUpstream(tenantId, url, credentialRef, status)` — an old panel's subscription URL that TXNet proxies instead of rebuilding (C-17). Upstream host/URL never shown to the user. | network / migration | Panel (infra), PanelGroup |
| BotIntegration | `automation.BotIntegration` — one bot per `(tenantId, platform, botUsername)`; `role` = primary \| sales \| support \| secondary. Exactly one `primary` per `(tenantId, platform)` carries OTP + transactional actions (C-05). | automation | LinkedBotAccount, webhook path |
| ResellerNode | `identity.ResellerNode(tenantId, path ltree, …)` — a node in a Tenant's internal reseller tree. RLS is `tenantId` + `path <@ currentPath`. | identity / tenant | Panel (infra), PanelGroup, Tenant |
| ownershipType | `platform` \| `tenant` — on a Panel and on an `AIProvider`. Decides whose infra/keys/cost a thing uses. Same pattern both places. | network / ai | Entitlement, tenantType |

## Banned words
Terms that were ambiguous and are now forbidden project-wide.

| Banned | Use instead | Why |
|---|---|---|
| customer / account (for a person) | User | Three names for one identity would become three tables |
| config (for app settings) | settings / env | `Config` is the network-domain VPN credential model |
| gateway (unqualified) | ForwardAuth gateway / payment gateway | Two unrelated "gateways" in this system |
| Node | Panel (infra) or ResellerNode | Bare "Node" is banned. The VPN server install is a `Panel`; the reseller-tree entity is a `ResellerNode`. The old schema `Node` model renames to `Panel` (F-017). |
| panel (for the web app) | User panel | The infra install is the `Panel`; the site-pwa web app is the `User panel` (`panel-web` unit). |
| client (for a VPN credential) | Config | `App-Features.md` driver interface returns `RemoteClient`; our model is `Config`. "client" stays driver-internal only. |
