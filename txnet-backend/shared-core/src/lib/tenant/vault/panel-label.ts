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

/**
 * Which of a panel's secrets a vault call means (F-027-az). A push panel has
 * two: the `login` its driver speaks the REST API with, and the
 * `radius_secret` its NAS signs accounting with. One value cannot be both, and
 * a secret read that fell back to the login would put a value no NAS holds on
 * the allowlist, so every packet from it is dropped as forged.
 */
export const PANEL_SECRETS = ['login', 'radius_secret'] as const;
export type PanelSecret = (typeof PANEL_SECRETS)[number];

/** The vault label of a push panel's RADIUS secret: `panel:<panelId>:radius`. */
export const panelRadiusSecretLabel = (panelId: string) => `${panelCredentialLabel(panelId)}:radius`;

/**
 * What `network.panel.panelRadiusSecret` holds: where the NAS's shared secret
 * is, never the secret. Same kind as the login and the same owner's vault; a
 * label of its own.
 */
export const panelRadiusSecretRef = (vaultTenantId: string, panelId: string) =>
  `vault:${vaultTenantId}:panel_credentials:${panelRadiusSecretLabel(panelId)}`;

/** The label of either secret, picked from an exhaustive record (C-07's shape). */
export const panelSecretLabel: Record<PanelSecret, (panelId: string) => string> = {
  login: panelCredentialLabel,
  radius_secret: panelRadiusSecretLabel,
};

/** The reference of either secret. */
export const panelSecretRef: Record<PanelSecret, (vaultTenantId: string, panelId: string) => string> = {
  login: panelCredentialRef,
  radius_secret: panelRadiusSecretRef,
};
