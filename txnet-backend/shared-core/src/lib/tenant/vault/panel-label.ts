/**
 * The vault label of one panel's login: `panel:<panelId>` (F-027-ar, kind
 * `panel_credentials`).
 *
 * Spelled once, here, for `gatewayCredentialLabel`'s reason: `tenant-service`
 * writes the login under it and the driver opener (F-027-ae) will read it back
 * under it. A copy that drifted stores a login no connection test ever finds,
 * and the panel stays `pending` with fault `unopenable` for a reason nobody
 * can see.
 */
export const panelCredentialLabel = (panelId: string) => `panel:${panelId}`;

/**
 * What `network.panel.panelApiCredentials` holds: where the login is, never
 * the login — `vault:<tenantId>:panel_credentials:<label>`.
 *
 * The tenant is the vault's owner (the platform owner for a `platform` panel,
 * whose `tenantId` column is null — network invariant 9), so the reference is
 * enough to find the one row without re-deriving an owner. A column is read by
 * every `select *`; a vault row only by an audited `use`.
 */
export const panelCredentialRef = (vaultTenantId: string, panelId: string) =>
  `vault:${vaultTenantId}:panel_credentials:${panelCredentialLabel(panelId)}`;
