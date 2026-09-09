---
id: tenant
layer: domain
status: active
updated: 2026-09-09
---

# Invariants — tenant

Rows 1-7 were extracted from schema comments during onboarding and none of them
is enforced in code yet. **Rows 8-12 are** — they are the Credential Vault's
(F-066-f and F-066-g, ADR-0026), and the `Enforced by` column names the code
that holds each one.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Exactly one `tenant` row has `tenantType = platform_owner` | planned CHECK/trigger (schema "section 99") — NOT applied | ambiguous platform identity, billing routing errors |
| 2 | Tenant end-user money never enters a platform wallet; there is no platform->tenant settlement wallet (ADR-0006) | design / absence of such a table | platform becomes a money transmitter |
| 3 | `tenant_billing_wallet` balance is never written directly — only via append-only `tenant_billing_transaction` + `balanceAfter` (ADR-0002) | planned service layer | silent money drift |
| 4 | Encrypted credential fields (`merchantIdEncrypted`, `apiKeyEncrypted`, `ownApiKeyEncrypted`) are never default-selected or logged | planned service `select`/`omit` | tenant gateway/bot takeover |
| 5 | A `custom_domain` only routes after `verificationStatus = verified` | planned domain-verifier worker | domain hijack / cert misissue |
| 6 | A feature runs for a tenant only if `tenant_feature_entitlement.isEnabled` (and not expired) for that `featureKey` | planned central guard | unpaid feature usage |
| 7 | `tenant_usage_meter` rows are billed exactly once (`isBilled` + `billedTransactionId`) | planned metering worker | double / missed charges |
| 8 | **No vault plaintext ever reaches a user-facing API response, a log line or an audit row — at any role, including the highest.** One exception, below | `CredentialVaultService`: `use()` is the only method returning one, and it takes the single credential the caller will use. Everything else returns `CredentialSummary`. `tenant_credential_access` has no column a value could be written into | one leaked response or log line is a takeover of that tenant's payment account or bot. The strongest role is the one most likely to have a debugging surface pointed at it |
| 9 | **A credential is encrypted under its own tenant's DEK, never a platform-wide key** | `CredentialVaultService.activeDek` — one `tenant_dek` row per tenant, wrapped by the KEK; `tenantId` is a required argument on every method | catalog 20.2's layer 5 collapses: one leaked ciphertext plus the key becomes every reseller's credentials at once (ADR-0026) |
| 10 | **At most one `active` version per `(tenantId, kind, label)`** | partial unique index `tenant_credential_one_active_per_kind_label`, migration `20260909000000_credential_vault` | the vault reads "the active version" as one row; two makes it whichever the planner found first, so a rotation that half-failed silently un-rotates |
| 11 | **Every decryption of a credential is recorded before its plaintext is returned** | `CredentialVaultService.use()` awaits the `tenant_credential_access` insert and does not catch it, so an unaudited decryption throws instead of handing a value back (F-1215) | a trail that is complete only in appearance is worse than none: the one decryption nobody can explain is the one that was not written |
| 12 | **No tenant-owned credential is read from an environment variable; a service holding one refuses to start** | `CredentialEnvGuard.onModuleInit` against the total `CREDENTIAL_ENV_VARS` map, minus the dated `GRACED_ENV_VARS` exceptions (F-1216, ADR-0026 rule 6) | a leftover `TELEGRAM_BOT_TOKEN` keeps one tenant's bot working after multi-bot ships, so nobody notices the vault was never wired up. By the time it is load-bearing it is too late to refuse it |

## How to test

Rows 1-7: to be written when the service exists. Minimum: a test that a second
`platform_owner` insert fails, and that the entitlement guard denies a disabled
feature key.

Rows 8-10 are held by `vault.crypto.spec.ts` for the cryptographic half — a
fresh IV per record, a tampered ciphertext refused, a fingerprint that is
truncated and domain-separated — and by the shape of `CredentialVaultService`
for the rest. Row 8 is the one no test can fully hold: it is a statement about
every method that will ever be added, so it is a review rule, and the way to
keep it true is that the class has no method a reviewer has to check the
`select` of.

Rows 11-12 are held by `vault-enforcement.spec.ts`: that a failed audit insert
fails `use()` rather than being swallowed, that the written row contains
neither the plaintext nor the fingerprint, that an empty variable is not a set
one, that a variable naming a location is not claimed as a credential, and
that the grace list is exactly the six names live code still reads. Both fail
silently if they are wrong, which is what earns them the one spec file
`docs/CODE-LAYOUT.md` budgets per item.

## The one exception to #8, and why it is narrow (2026-09-09, F-066-i)

`POST /internal/bot-integrations/token` and `.../webhook-secret` return a
plaintext in an HTTP response. They are the only two routes on this platform
that do, and they exist because `bot-service` serves the bot webhook while
owning no database and no vault (ADR-0011).

The wording of #8 was written for the surface it was defending: "at any role,
including the highest" is about *people* — ADR-0026 guarantee 1 is that nobody
who can see the panel can read a credential back, whatever their role. These
two routes have no role at all. They are reachable only with
`SERVICE_AUTH_TOKEN`, which already buys its holder a captcha bypass and the
rate-limit subject for every chat on the platform: strictly more than one
tenant's bot token.

What still holds, and is what makes this an exception rather than a hole:

- both routes are behind `ServiceOnlyGuard`; anything else is a 404;
- both are addressed by an integration's own `webhookPath`, so a caller must
  already hold the credential that proves it serves that bot's door;
- both write a `tenant_credential_access` row naming `bot-service` and the
  remote caller **before** the value is returned (#11 is untouched);
- no admin or tenant surface gained anything: `CredentialSummary` is still all
  a panel can ever be shown.

**If this widens, it is wrong.** A third route returning a plaintext is the
signal to build the alternative instead: every outbound send routed through
`auth-service`, so no token crosses a process boundary at all. That was weighed
when this was built and is a backlog row of its own, not a licence to keep
adding routes here.
