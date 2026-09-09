---
id: adr-0026
status: accepted
updated: 2026-09-09
---

# ADR 0026 — Tenant secrets are envelope-encrypted, one key per tenant

- **Status:** accepted
- **Date:** 2026-09-09
- **Supersedes:** ADR-0022
- **Affects units:** tenant, network, bot-app, messenger, identity, audit

## Context

ADR-0022 answered D-4 one day earlier: AES-256-GCM in the application, a single
key from a Docker Swarm secret, each ciphertext stamped with its key version. It
explicitly rejected envelope encryption, on the grounds that "Vault or a cloud
KMS" is **new infrastructure** not present in the compose stack.

Catalog block 20.4 specifies the vault in detail, and — like 20.3 — carried no
feature id, so no session here could read it. It requires one **DEK per tenant**,
wrapped by a **KEK held outside the database**; `TenantCredential` and
`TenantDek` tables; a truncated-hash **fingerprint** so the admin UI can answer
"is this the same value?" without revealing it; **versioned rotation with a grace
window** so an in-flight webhook can still verify; an **audit row on every
decryption**; expiry dates; and two hard guarantees — no plaintext in any
response, log or audit row even for the highest role, and **no tenant-owned
credential read from an environment variable**, with a service refusing to boot
when one matches a credential type.

The conflict is narrower than it looks. ADR-0022 rejected a *managed key
service*, not the envelope shape. The Swarm secret it already chose is a KEK: it
lives outside Postgres, it is not an environment variable, and wrapping a
per-tenant DEK with it adds no infrastructure whatsoever. The cipher, the
per-record IV and the stored auth tag are unchanged from ADR-0022.

What ADR-0022 genuinely lacks is the blast radius. With one key for the
platform, a leak of any ciphertext plus the key is a leak of every reseller's
bot token and payment credential at once. Catalog 20.2's layer 5 asks for the
opposite: "a tenant's credentials are its own; a failure stays confined to that
tenant."

## Decision

**Envelope encryption, one DEK per tenant.**

1. `TenantDek(tenantId, wrappedKey, kekId, createdAt, retiredAt)` — one data
   key per tenant, wrapped by a KEK read from the Docker Swarm secret file
   ADR-0022 already established. Never an environment variable.
2. `TenantCredential(tenantId, kind, label, ciphertext, iv, authTag, dekId,
   fingerprint, status, version, createdBy, rotatedAt, lastUsedAt, expiresAt)`
   — AES-256-GCM, a per-record IV, the auth tag stored, as before.
3. **Fingerprint** is a truncated hash of the plaintext. It is the only thing an
   admin surface ever sees alongside `{configured, status, lastUsedAt}`.
4. **Rotation is versioned with a grace window**: the previous version stays
   readable long enough for an in-flight webhook to verify, then is destroyed.
5. **Every decryption writes an audit row** — who, which tenant, which kind,
   which caller. Never the value.
6. **No tenant-owned credential comes from an environment variable.** A service
   refuses to boot when an env var matches a tenant credential type.

Rule 6 is the one with teeth today: `TELEGRAM_BOT_TOKEN` and `BALE_BOT_TOKEN`
are exactly the leftovers the catalog names, and they are how a bot silently
keeps working for one tenant after multi-bot ships. It is therefore why the
vault is sequenced **before** multiple bots per tenant, not after.

## Consequences

- Positive: a compromise is scoped to one tenant's DEK rather than to every
  credential the platform holds.
- Positive: rotating one reseller's credentials never touches another's.
- Positive: "is this the same token you already have?" is answerable without
  decrypting, which is what makes the admin UI's no-plaintext rule liveable.
- Positive: the audit trail ADR-0022 listed as a cost of not using a KMS is
  recovered, at the application layer.
- Negative / accepted cost: two tables, a wrap/unwrap step and a DEK cache
  instead of one key in memory. More moving parts than ADR-0022 chose.
- Negative / accepted cost: the KEK is still in application memory, so a
  compromised process can unwrap any DEK it can read. The blast radius is the
  service, not one tenant — unchanged from ADR-0022 and not solved here.
- Negative / accepted cost: losing the Swarm secret still makes everything
  unrecoverable, and now a lost or corrupted `TenantDek` row loses one tenant.
  Backup is an operational requirement for both.
- Negative / accepted cost: rule 6 will refuse to boot a currently working
  deployment. That is deliberate, and it is sequenced with F-066-i so the tokens
  have somewhere to live first.
- Forecloses: a single platform-wide credential key; reading any tenant secret
  from `.env`; showing a stored credential back to anyone, at any role.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep ADR-0022's flat single key; treat the vault as a later epic | ships sooner and moves bot tokens out of env earlier — but the tokens then get written twice, and 20.2's layer-5 confinement does not hold in between. The migration is cheaper now, while there are no real tenants |
| A managed KMS / Vault for the KEK | ADR-0022's rejection still stands: new infrastructure, unseal handling, and a new failure point in every provisioning call. The Swarm secret is a sufficient KEK and is already there |
| `pgcrypto` | unchanged from ADR-0022: the key reaches Postgres, which is the threat |

## Revisit trigger

Unchanged from ADR-0022: a compliance requirement demands an audit trail of KEK
use, or the platform moves onto infrastructure where a managed KMS already
exists. The envelope shape decided here is what makes that migration a change of
KEK holder rather than a re-encryption of every row.
