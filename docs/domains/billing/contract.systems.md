---
id: billing
layer: domain
status: active
version: 33
updated: 2026-09-24
---

# Systems — the platform owner's panel routes

A topic file of `contract.md` (§10). What governs
`billing-service/src/app/systems/`: the routes behind the systems page
(F-027-ad). The *why* is **ADR-0080**; what `network-service` does with a
registered panel is `network/contract.registration.md`.

Nothing here calls `network-service`. Every route writes desired state or
reads observations in the database (ADR-0071: the Go service has no route).

## Who may call

| Door | Boundary |
|---|---|
| `PanelPermissionGuard`: `panel.manage` (migration `20260924000100`; granted to no role, so SuperAdmin via `*`) | `PanelRegistrationService`: the caller's tenant is `platform_owner`, else 403 `not_platform_owner` |

Every route is scoped by the gate's `tenantId` from its first line, so opening
one to a reseller with a dedicated panel is a permission change, not a rewrite
(ADR-0080 decision 2). **Registering** stays owner-only: the collector would
dial an address a tenant chose (`network/open-questions.md`).

## Routes

| Route | Body | Answers | Errors |
|---|---|---|---|
| `POST /api/billing/systems/panels` | `name`, `ipAddress`, `apiBaseUrl` (required for `pull`), `driverType`, `counterSemantics`, `transport`, `role`, `region`, `maxRequestsPerMinute?`, `credentials` (≤4096); `.strict()` | `201 {id, reviewState: 'pending', credentials: {configured, version, rotatedAt}}` | 400 validation; 403 `panel.manage` / `not_platform_owner`; 400/403/404 relayed from the vault seam; 502 `credentials_unavailable` |

Rate limit: `SYSTEMS_ADMIN_WRITE`, per user, 30 per 15 minutes.

## Registering a panel — the rules

1. **A desired-state write, nothing more.** The row lands with
   `reviewState = pending`, `ownershipType = platform`, `tenantId` null
   (network invariant 9). The verdict arrives on `network-service`'s next tick;
   the response never carries one.
2. **The login goes to the vault and nowhere else.** It is relayed to
   `tenant-service`'s `POST /api/internal/vault/panel-credential`
   (`tenant/contract.vault.md`), stored as kind `panel_credentials` under
   `panelCredentialLabel(panelId)` in the **owner's** vault.
   `panel.panelApiCredentials` holds `panelCredentialRef(tenantId, panelId)`
   — `vault:<tenantId>:panel_credentials:panel:<panelId>` — never the login.
   Both spellings are in `shared-core` (`tenant/vault/panel-label.ts`).
3. **No half-registration.** Row first (the seam checks the row exists), vault
   second; a vault that refuses or does not answer deletes the row, so no tick
   tests a panel whose login was never stored.
4. **Nothing reads a login back.** The answer is `{configured, version,
   rotatedAt}`, picked field by field from the seam's reply.

`panel-registration.spec.ts` pins rules 1–3 and the owner refusal.

## Not here yet

- The read routes — capability matrix, health, request budget, drift report —
  and acknowledging a drift event: F-027-as.
- The holds queue, release through the meter and write-off: F-027-at
  (ADR-0080 decision 3).
- Re-submitting a panel's login (which clears `connectionTestedAt`, network
  contract.registration.md rule 4): no route yet.
