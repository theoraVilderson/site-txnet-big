---
id: adr-0039
status: accepted
updated: 2026-09-11
---

# ADR 0039 — The vault is a library each reader loads with its own KEK

- **Status:** accepted
- **Date:** 2026-09-11
- **Affects units:** tenant, billing

## Context

ADR-0026 put every tenant credential in one vault, and F-066-f built it
inside `auth-service`. Its readers so far lived there too, or reached it over
a service-only route that returns a count and never a value (the retention
sweep, F-031-c).

F-092-f needs a reseller gateway's merchant id inside `billing-service`, which
is a different Nx application and cannot import `auth-service`. Something had
to change: a plaintext crossing a process boundary on an internal route, or
the vault's code moving to where both services can load it.

## Decision

We move the vault — `vault.crypto`, `KekService`, `CredentialVaultService`,
`CredentialEnvGuard` — into `shared-core/src/lib/tenant/vault/`. A service that
reads a credential loads the vault itself, mounts the **same KEK file**, and
binds the vault's connection (`VAULT_DB`) to the pool that fits its callers:
`auth-service` its cross-tenant pool, because it resolves a tenant through the
vault; `billing-service` its app pool, with every vault query bound to the
request's tenant, so Row-Level Security hides any other tenant's credential.
Writing a credential stays with `auth-service`; `billing-service`'s binding
refuses a transaction, which is what `put` needs.

## Consequences

- Positive: no plaintext credential ever travels between our services, and
  ADR-0026's audit rule holds unchanged — every `use` writes its
  `tenant_credential_access` row, whichever process decrypted.
- Positive: in `billing-service` a credential ref naming another tenant is
  refused by the database, not only by the vault's own `where`.
- Accepted cost: the KEK is mounted into two containers instead of one. A
  compromise of either now holds the key. It already held a database role
  that can read ciphertext, so that one process is the whole breach.
- Accepted cost: rotating the KEK means redeploying every reader with the new
  file, not only `auth-service`.
- Forecloses: nothing. The internal-route option stays open for a reader that
  should never hold the key.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| A service-only `auth-service` route returning the plaintext to `billing-service` | The first secret on the internal network, on every payment. The value lives in two processes anyway, and the network gains a route that hands out any tenant's merchant id to whoever holds `SERVICE_AUTH_TOKEN` |
| Driver takes the merchant as an argument, and the vault question becomes its own row | Proposed as the recommendation; the user chose to settle the boundary in F-092-f |

## Revisit trigger

A third service needs a credential, or the KEK moves to a KMS. With a KMS, a
reader asks the KMS to unwrap and never holds a file at all. That removes
the cost above and may change which option is cheaper.
