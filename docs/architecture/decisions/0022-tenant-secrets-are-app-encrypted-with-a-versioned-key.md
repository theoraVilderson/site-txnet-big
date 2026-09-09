---
id: adr-0022
status: superseded
updated: 2026-09-09
---

# ADR 0022 — Tenant and panel secrets are app-encrypted with a versioned key

- **Status:** superseded by [ADR-0026](0026-tenant-secrets-are-envelope-encrypted-per-tenant.md)
- **Date:** 2026-09-09
- **Affects units:** tenant, network, bot-app, identity

> **Superseded 2026-09-09 by ADR-0026: catalog 20.4 requires one DEK per tenant
wrapped by a KEK. The cipher, the per-record IV and the Swarm-secret key
store below are unchanged — the KEK is that same secret.**

## Context

The schema already assumes these values are encrypted at rest and says so in its
own comments — `TenantPaymentGateway.merchantIdEncrypted` and `.apiKeyEncrypted`,
`TenantBot.botTokenEncrypted`, the reseller's `ownApiKeyEncrypted`, and
`network`'s `panelApiCredentials`, each marked `SENSITIVE — never
default-select`. What was never decided (`D-4`, open since 2026-09-04) is the
mechanism, which blocks F-018 and F-027.

These are live third-party credentials: a payment merchant key, a bot token, a
panel login. A database dump that leaks them is not an information disclosure,
it is a takeover of every reseller's payment account and bot. The platform is
self-hosted on Docker Swarm with no cloud KMS and no secret manager in the
compose stack.

## Decision

We will encrypt these fields in the **application, with AES-256-GCM**, using a
key read from a **Docker Swarm secret** (a mounted file, never an environment
variable). Every ciphertext is stored with the **version of the key that
produced it**, so keys can be rotated by writing new values under a new version
while old ones stay readable.

GCM is chosen over an unauthenticated mode deliberately: it authenticates the
ciphertext, so a row edited directly in the database fails to decrypt instead of
silently yielding an attacker-chosen credential. Decryption happens only where a
credential is used; these columns are never in a default select, never logged,
and never returned by an API.

## Consequences

- Positive: a stolen database dump is inert without the Swarm secret, which
  lives outside Postgres.
- Positive: no new infrastructure, no new dependency in the provisioning path.
- Positive: key rotation is possible without downtime and without a bulk
  re-encryption, because each value carries its key version.
- Negative / accepted cost: the key is in the application's memory, so a
  compromise of a service process is a compromise of every credential it can
  read. The blast radius is the service, not one tenant.
- Negative / accepted cost: rotation is real work someone has to run and no
  audit trail of key use exists, which a managed KMS would give for free.
- Negative / accepted cost: losing the Swarm secret with no backup makes every
  stored credential unrecoverable. The key's backup is an operational
  requirement, not a nice-to-have.
- Forecloses: querying, sorting or indexing on these columns; putting a
  credential anywhere a log line can reach.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Vault or a cloud KMS (envelope encryption) | better auditing and rotation, and the key never leaves the store — but it is a new infrastructure service not in the compose stack, with unseal handling, and it puts a new point of failure in the path of every provisioning call |
| `pgcrypto` inside Postgres | no application crypto code, but the key reaches Postgres, so whoever holds the database holds the plaintext — which is exactly the threat being defended against |

## Revisit trigger

A compliance requirement demands an audit trail of key use, or the platform
moves onto infrastructure where a managed KMS is already present.
