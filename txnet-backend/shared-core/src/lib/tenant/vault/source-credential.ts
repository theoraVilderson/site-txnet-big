import { TenantCredentialKind } from '@prisma/client';

/**
 * An import's source login (F-201-d, D-63): the address and login of the panel
 * a reseller is leaving, kept in that reseller's own vault for one run, as kind
 * `source_panel_credentials` under {@link sourceCredentialLabel}.
 *
 * Spelled once, here, for `panelCredentialLabel`'s reason: `tenant-service`
 * writes it and reads it back for `network-service`'s source read (F-201-b),
 * and a copy that drifted stores a login no read ever finds.
 */

/**
 * Kinds whose expired versions the vault's retention sweep destroys, not only
 * refuses on read: a source login must not outlive its import as ciphertext.
 * Every other kind keeps its expired row for the trail, as `revoke` does.
 */
export const DESTROYED_ON_EXPIRY = [TenantCredentialKind.source_panel_credentials] as const;

/** The label of one run's source login: `source:<runId>`. The run id is the reference a caller names. */
export const sourceCredentialLabel = (runId: string) => `source:${runId}`;

/**
 * How long a source login lives unused (D-63: 7 days). Each read starts it
 * again, so a dry run retried over a week keeps its login and an abandoned one
 * does not; once past it the retention sweep destroys the row.
 */
export const SOURCE_CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What the vault holds for a run, sealed as one value: the address is a secret
 * too — 3x-ui and S-UI hide their panel behind a web path — so it is never a
 * column. `login` is in the family's form (`username:password`, Hiddify's API
 * key alone), which `network-service` checks, not this.
 */
export type SourcePanelLogin = { apiBaseUrl: string; clientBaseUrl: string | null; login: string };

/** The sealed form of a {@link SourcePanelLogin}. */
export const sealSourceLogin = (value: SourcePanelLogin): string => JSON.stringify(value);

/** A stored value read back; `null` when it is not one this module wrote. */
export function openSourceLogin(stored: string): SourcePanelLogin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { apiBaseUrl, clientBaseUrl, login } = parsed as Record<string, unknown>;
  if (typeof apiBaseUrl !== 'string' || typeof login !== 'string') return null;
  return { apiBaseUrl, clientBaseUrl: typeof clientBaseUrl === 'string' ? clientBaseUrl : null, login };
}
