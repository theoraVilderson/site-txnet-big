---
id: tenant
layer: domain
status: active
version: 8
updated: 2026-09-12
---

# Contract — tenant / the Credential Vault

A topic file of `contract.md` (§10), split out at authoring time rather than
after: the vault has its own consumers — `messenger` reads a bot token,
`network` a panel login, `billing` a gateway key — and none of them cares how a
host resolves to a tenant.

Implemented by `CredentialVaultService` (F-066-f) and `CredentialEnvGuard`
(F-066-g), in `shared-core/src/lib/tenant/vault/` since F-092-f. **ADR-0026** is
the why, and this file does not restate it.

## Who loads it (ADR-0039)

| Service | `VAULT_DB` binds | Uses |
|---|---|---|
| `auth-service` (`app/tenant/vault/vault.module.ts`) | the cross-tenant pool — its readers resolve a tenant through the vault | every operation, the internal destroy route, and **the only writer of a gateway's secrets** (F-102-a, below) |
| `notification-service` (`campaigns/campaigns.module.ts`, F-018-a, F-035-i-a) | the cross-tenant pool — a delivery run has no request tenant; no `put` | `use` of the `sms_api_key` / `sms_sender_line` of the owner and of each `own_credentials` reseller; `summary` of a reseller's key at the draft |
| `billing-service` (`payment/gateway/gateway.module.ts`) | the app pool, each vault query bound to the request's tenant — **except inside a proved grant**, below; `$transaction` refused, so no `put` | `use` of `gateway_merchant_id` and `webhook_secret` |

**Gateway secrets are written over a seam, not by `billing` (D-31).**
`POST /internal/vault/gateway-credential` (+ `/state`, `/revoke`,
`GatewayCredentialService`) stores `gateway_merchant_id` / `gateway_secret_key`
/ `webhook_secret` (F-104-c: what a webhook provider signs with, served to
`verifyWebhook` by `GatewayMerchant.webhookSecretFor`, missing = `null` = 401)
under `gatewayCredentialLabel(source, gatewayId)` — the one spelling, in
`shared-core`, that `billing`'s `merchantLabel` delegates to. The vault is the
one re-derived from the gateway row (a `tenant_gateway_config`'s `tenantId`; the
platform owner for a `payment_gateway`), never the caller's. It answers
`{configured, version, rotatedAt}` per secret: no value, no fingerprint, and no
value in a refusal.

A loader mounts the same `VAULT_KEK_FILE` and gets `CredentialEnvGuard` with
it. Every rule below holds in either process.

## What it is for

Every third-party secret a tenant owns lives here and nowhere else, encrypted
under **that tenant's own data key**, which is itself wrapped by a KEK held
outside the database. One platform key would mean a leaked ciphertext plus that
key is a takeover of every reseller's payment account at once; catalog 20.2's
layer 5 (F-1207) asks for the opposite, and the per-tenant DEK is what delivers
it.

## Provides

| Operation | Input | Output | Errors |
|---|---|---|---|
| `put` | ref, plaintext, `{createdBy?, expiresAt?}` | `CredentialSummary` | — |
| `use` | ref, `{caller, actorId?}` | **the plaintext** | `CredentialUnavailable` (missing / expired / revoked), `VaultDecryptionError`, whatever the audit write throws |
| `verify` | ref, candidate | `boolean` — accepts a superseded version inside its grace window | — |
| `matches` | ref, candidate | `boolean` — "is this the value you already have?" | — |
| `summary` / `list` | ref / tenantId | `CredentialSummary`(`[]`) | — |
| `revoke` | ref | — | — |
| `destroyExpiredVersions` | `now?` | how many rows were destroyed | — |

A **ref** is `{tenantId, kind, label?}`. `kind` is `TenantCredentialKind` —
catalog 20.4's list verbatim. `label` distinguishes several of a kind (a second
SMS sender line, a second bot) and defaults to the singular `''`.

## The rules a caller has to know

1. **`use` is the only operation that returns a plaintext**, and it takes the
   exact credential the caller is about to use plus a `CredentialAccess`
   — `{caller, actorId?}`. There is no operation that returns several
   plaintexts, and none that returns one without naming it.

   **Every `use` writes a `tenant_credential_access` row before it returns**
   (F-1215): tenant, credential, kind, label, version, caller, and the actor
   when there is one. Never the value, and never the fingerprint. The write is
   awaited and is *not* caught — an unaudited decryption fails. That is the
   opposite of `lastUsedAt`, which is fire-and-forget on purpose, and the
   difference is which of the two is a guarantee: losing a `lastUsedAt` must
   not take a bot down, losing an audit row must.

   `verify` and `matches` write no row. They compare fingerprints and decrypt
   nothing, so recording them would change the trail's meaning from *someone
   held this value* to *someone asked about it*.

   The row deliberately carries **no foreign key**, to the credential or to the
   tenant: `RESTRICT` would stop `destroyExpiredVersions` doing the one thing
   rule 4 requires of it, and `CASCADE` would erase a credential's usage
   history exactly when it is removed. `audit.admin_audit_log` holds its
   `tenantId` the same unconstrained way.
2. **An admin surface sees `CredentialSummary` and never a value** — at *every*
   role, including the highest (ADR-0026 guarantee 1). That is a property of
   this class's shape, not of its callers' discipline: there is no `select` for
   anyone to get wrong.
3. **`put` is also rotate.** Storing a value that is already the active one is a
   no-op — the fingerprint says so — so a provisioning job that re-applies its
   configuration does not burn a version and a grace window on every run.
   Storing a *different* value supersedes the old version in the same
   transaction as it writes the new one.
4. **A superseded version stays verifiable for `ROTATION_GRACE_SEC` (6h), then
   is destroyed.** `verify` honours the window, and since F-031-c something
   ends it: `automation`'s `vault_credential_retention` job sweeps on its
   schedule. The obligation was always the scheduler's, and the shape it took
   is a **seam, not a method call** — the job runs in `worker-service`, which
   cannot import this code, so it asks over
   `POST /api/internal/vault/destroy-expired` (`interfaces/auth-api/contract.md`),
   guarded by `ServiceOnlyGuard`. What crosses is a count and never a
   credential. The sweep is the only caller of `destroyExpiredVersions`; how
   long a version actually survives is therefore the grace window plus one
   tick interval, not the window exactly, and a worker switched off
   (invariant #1 in `domains/automation`) means it is not swept at all.
5. **Expiry is checked on read, not swept** (F-1217). A credential that expired
   a second ago fails the next `use`; a sweeper would keep it working until its
   next tick.
6. **Nothing logs a value, and nothing logs a fingerprint either.** The kind,
   the tenant and the version are what a log line may say. A log is the one
   place a short secret and unlimited guesses meet.
7. **No tenant-owned credential is read from an environment variable, and a
   service holding one refuses to start** (F-1216, ADR-0026 rule 6).
   `CredentialEnvGuard` scans `process.env` at boot against
   `CREDENTIAL_ENV_VARS` — an explicit, *total* `Record<TenantCredentialKind,
   string[]>`, so adding a kind fails the build until someone says which
   variables would have carried it. A name is deliberately not a pattern:
   `*_SECRET` cannot tell `JWT_ACCESS_SECRET`, which is the platform's, from
   `TELEGRAM_BOT_TOKEN`, which is a tenant's, and the distinction this rule
   turns on is ownership. A variable naming a *location* — `VAULT_KEK_FILE`,
   `TELEGRAM_API_BASE` — is not a credential and is not listed. An empty value
   is not set: compose passes an unfilled `FOO=` through as `''`.

   **`GRACED_ENV_VARS` is empty** since F-018-a. It carried `SMS_API_KEY` /
   `SMS_SENDER` until an SMS line had a vault row to live in; emptying an
   entry was part of the row that gave it one, not a follow-up.
8. **An SMS line is `sms_api_key` + `sms_sender_line`, singular label**
   (F-018-a), read through `shared-core`'s `smsLineCredentials(vault,
   tenantId, caller)` — `null` when there is no usable key, a missing sender
   `''`, anything else thrown. `smsLineConfigured` answers from the summary and
   audits nothing. The platform's own gateway account is the owner tenant's
   credential like any reseller's. `SmsOtpSender` reads it for the owner's
   users and a reseller's owner, and since F-018-b a reseller's own
   (`tenant_sms_config` `own_credentials`, active) for everyone else under it
   (`identity` invariant 16); the campaign `SmsLineSource` reads both since
   F-035-i-a. The
   gateway's URL is a location and stays `SMS_API_URL`. `seed-sms-line`
   (`scripts/seed-sms-line.sh`, the `seed-bot-integration` shape) writes one;
   for a tenant other than the owner it also records `tenant_sms_config` as
   `own_credentials`, one row per tenant.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| — | the KEK, from the file `VAULT_KEK_FILE` names | the service boots, logs a warning, and refuses every credential operation |

`VAULT_KEK_FILE` holds a **path**, never a key. ADR-0026 rule 6 forbids reading
a credential's *value* from the environment; a path is not one, and the
distinction is the reason the file exists at all — an environment variable is
readable from `docker inspect`, from `/proc/<pid>/environ` and from every child
process this service spawns. In Swarm the file is a mounted secret; the dev
stack bind-mounts `dev-docker/secrets/vault-kek` read-only to the same path.

**A deployment with no KEK still boots.** Nothing writes a tenant credential
until F-066-i, so requiring the key today would stop every deployment from
starting over a feature none of them use. `available` is how a caller asks.

## Why these tables are not `TENANT_SCOPED_MODELS`

`tenant_credential`, `tenant_dek` and `tenant_credential_access` are
deliberately **not** registered with the `withTenant` extension
(`platform/tenant-context`), and this is the exception worth knowing about, so
it is written here rather than left to be rediscovered.

The ambient scope is opened from a *resolved* request. The vault's first real
consumer, F-066-i, looks a `BotIntegration` up **by its webhook path in order to
discover which tenant the request belongs to** — before any tenant is resolved.
Registering these models would make that lookup throw, and the workaround would
be `runAcrossTenants()`, which is a strictly worse answer: it disables scoping
for everything inside it.

What confines a credential to its tenant here is stronger than the extension
anyway: **the DEK**. A `tenantId` is a required argument on every method, and
every row is sealed under a key only that tenant's rows use, so a query that
somehow escaped its tenant returns ciphertext it cannot open.

## Guarantees

- One `active` version per `(tenantId, kind, label)`, enforced by a **partial
  unique index** in `20260909000000_credential_vault` — Prisma cannot express
  it, and the vault reads "the active version" as a single row.
- A ciphertext edited directly in the database fails to decrypt rather than
  yielding an attacker-chosen value (AES-256-GCM, auth tag stored).
- A fresh IV per record, never derived and never reused.
- A fingerprint is truncated to 64 bits and domain-separated, so it identifies a
  value without being reversible into a short one.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `tenant_gateway_config.merchantIdEncrypted` / `.apiKeyEncrypted` | 2026-09-09 | F-018 |
| `tenant_sms_config.ownApiKeyEncrypted` | 2026-09-09 | **removed 2026-09-17** (F-018-a, `20260917000800_tenant_sms_config_vault`) | a `tenant_credential` row of the matching `kind` |
| `tenant_bot_integration.botTokenEncrypted` | 2026-09-09 | **removed 2026-09-09** | `automation.bot_integration.credentialRef`, naming a `telegram_bot_token` / `bale_bot_token` row |

Those four columns have **never been written** — no code has ever read or set
them — so nothing is migrated and none was dropped here. F-066-h has since
dropped `tenant_bot_integration` outright, in
`20260909000200_bot_integration`, and F-018-a the SMS one; F-018 owns the gateway two.

The bot is therefore the vault's first real consumer, and it uses the label as
the join: `automation.bot_integration.credentialRef` is the `label` half of a
`CredentialRef`, with the tenant and the kind coming from that row's own
`tenantId` and `platform`. The webhook secret takes the **same** label under
kind `webhook_secret`, which is what puts rule 4's grace window to work — an
update signed against the previous secret still verifies while it rotates.

## The one crossing (ADR-0041 §3, F-096-c)

`billing-service`'s binding is the request's tenant, and a granted gateway is
the one case that has to read past it: the gateway is charged with its
**owner's** merchant id (D-26), so a payment inside the borrowing tenant reads a
credential of the lending one.

| Rule | Why |
|---|---|
| The bind target is overridden **for the duration of one call**, by `GrantedVaultAccess.along(...)`, and by nothing else | a second connection would let every vault read in that service reach every tenant's credentials, for ever, to serve one case. The narrow path is revocable by deleting a row |
| The grant is **proved first**, on the application pool, inside the borrower's own scope — so the RLS policy on `payment_gateway_grant` is what refuses a grant made to somebody else | the caller cannot assert a grant; it can only name one that answers |
| It must be live **and name the gateway being charged** | otherwise one grant is a key to every gateway that lender owns |
| The owner is **re-derived** from the grant (the platform owner tenant, or the lender's own row read for that one id) and never taken from the caller | a ref carrying somebody else's tenant id then changes nothing |
| The access row lands in the **owner's** scope, with a caller tag naming the grant (`billing:<provider>:grant:<id>`) | a lender can see every use of its own account and under which grant. Nothing has to remember to log: the vault writes it |

Proof: `payment/gateway/granted-vault-access.spec.ts` for the refusals,
`payment/gateway/gateway-merchant.int.spec.ts` for the crossing itself against
a real policy — the same borrower and credential that are refused without a
grant.
