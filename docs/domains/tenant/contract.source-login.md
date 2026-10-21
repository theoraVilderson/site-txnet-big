---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-10-21
---

# Contract — tenant / an import's source login (F-201-d)

A topic file of `contract.md` (§10), beside [contract.vault.md](contract.vault.md),
whose rules all hold here. A reseller leaving another panel brings its users
with it (D-63). To read that panel once, `network-service` needs its address
and login. This file says where they are kept, who may store them, who reads
them, and when they are destroyed. The run they belong to is entitlement's
(`migration_run`, F-201-a). The read is network's
([../network/contract.source.md](../network/contract.source.md)).

Code: `tenant-service/src/app/vault/source-credential.{service,controller,schema}.ts`;
`shared-core/src/lib/tenant/vault/source-credential.ts` (the label, the
lifetime, the sealed shape).

## Rules

1. **One value per run, in the reseller's own vault.** Kind
   `source_panel_credentials`, label `sourceCredentialLabel(runId)` =
   `source:<runId>`. The value is `{apiBaseUrl, clientBaseUrl, login}`, sealed
   as one. The address is a secret too: 3x-ui and S-UI hide their panel
   behind a web path, so it is never a column and never a request body.
   `login` is in the family's form; `network-service` checks it.
2. **Stored by the reseller, behind the door.** `ResellerAccess` with
   `migration.manage` (`staffWrite`): the owner, a seat holding the key, or
   the platform's staff, as on every reseller route. It is stored only for a
   run of that tenant (looked up by id **and** tenant on the cross-tenant
   pool), of kind `panel`, still reading its source (`draft`, `previewing`,
   `previewed`). This is not a registered panel: ADR-0095 stands, and the
   source is dialed through the bare guard.
3. **Never answered back.** The reseller is told `{configured, expiresAt}`.
   The address and login leave the vault only through `use`, to
   `network-service`, audited as `network:SourceRead`.
4. **7 days unused.** `expiresAt` is 7 days after it is stored
   (`SOURCE_CREDENTIAL_TTL_MS`), and each `use` moves it to 7 days after that
   read (the same value again moves only the expiry, vault rule 3). Once past
   it, `use` refuses it on read (vault rule 5), and the retention sweep
   (`destroy-expired`) **deletes** it: `source_panel_credentials` is in
   `DESTROYED_ON_EXPIRY`, so it is not kept for the trail as other kinds are.
5. **Destroyed, not revoked, when the run ends.** The engine calls `destroy`
   at commit or cancel. Any `use` for a run that no longer reads its source
   (from `committing` on, or no such run in that tenant) destroys the login
   and refuses. So a commit the engine failed to report still ends it on the
   next read. `CredentialVaultService.destroy` deletes every version, the
   ciphertext with it. The access log keeps its rows, since it has no foreign key.

## Routes

| Route | Body | Answers |
|---|---|---|
| `PUT /api/tenants/:id/migration-runs/:runId/source-login` | `apiBaseUrl`, `clientBaseUrl?` (absolute http(s), ≤ 2048), `login` (1–4096), strict | `{configured: true, expiresAt}` |
| `DELETE` the same | — | 204, idempotent: the reseller withdraws it |
| `POST /api/internal/vault/source-credential/use` (service-only) | `tenantId`, `credentialRef` (the run id) | `{credentials, apiBaseUrl, clientBaseUrl}`: the only answer that carries them |
| `POST /api/internal/vault/source-credential/destroy` (service-only) | the same | `{destroyed}`, a count; idempotent |

## Refusals

| Reason | Status | Meaning |
|---|---|---|
| `not_allowed`, `reseller_suspended` | 403 | the door refused (`ResellerAccess`) |
| `reseller_not_found` / `reseller_terminated` | 404 / 409 | as on every reseller route |
| `run_not_found` | 404 | no run with that id in this tenant |
| `not_a_panel_run` | 422 | a `link` or `csv` run reads no panel |
| `run_closed` | 409 | the run is committing, committed, rolled back, cancelled or expired |
| `credential_unavailable` | 404 | `use` only: none stored, expired, destroyed, or the run no longer reads its source |

A 400 is a body that is not the shape above; an internal route answers 404
to a caller without the service token, as every internal vault route.
