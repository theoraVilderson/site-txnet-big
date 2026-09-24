import { Injectable, Logger } from '@nestjs/common';
import { PanelOwnershipType, TenantCredentialKind, TenantType } from '@prisma/client';
import { CredentialUnavailable, CredentialVaultService, PanelSecret, panelSecretLabel, panelSecretRef } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { SecretState } from './gateway-credential.service';

/** One panel, named the way `billing` names it: whose vault, which panel. */
export type PanelCredentialTarget = { tenantId: string; panelId: string };

export type PanelCredentialRejection = 'panel_not_found' | 'not_owner' | 'empty_value' | 'credential_unavailable';

/** How the collector is named in the vault's access log (F-027-aw). */
export const PANEL_OPENER_CALLER = 'network:Opener';

/**
 * Who reads each secret, as the vault's access log names it. The login is the
 * Opener's; the RADIUS secret is the allowlist's (F-027-az), read once a
 * minute for every accepted push panel, so the log tells the two apart.
 */
export const PANEL_SECRET_CALLER: Record<PanelSecret, string> = {
  login: PANEL_OPENER_CALLER,
  radius_secret: 'network:RadiusDirectory',
};

/** The column each secret's reference lives in. */
const REF_COLUMN = { login: 'panelApiCredentials', radius_secret: 'panelRadiusSecret' } as const satisfies Record<PanelSecret, string>;

/** A refusal. Its message names the rule and the panel, never a value. */
export class PanelCredentialRefused extends Error {
  constructor(readonly reason: PanelCredentialRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'PanelCredentialRefused';
  }
}

/**
 * The only writer of a panel's login (F-027-ar): `GatewayCredentialService`'s
 * shape for kind `panel_credentials`, under `panelCredentialLabel`.
 *
 * **The vault it lands in is re-derived, never trusted.** A `platform` panel's
 * login lands only in the platform owner's vault; a `tenant` panel's only in
 * the vault of the tenant its row names. A login stored behind somebody else's
 * panel is the collector signing in to a server with credentials a tenant
 * chose — the SSRF ADR-0080 decision 2 keeps closed.
 */
@Injectable()
export class PanelCredentialService {
  private readonly logger = new Logger(PanelCredentialService.name);

  constructor(
    private readonly vault: CredentialVaultService,
    private readonly prisma: CrossTenantPrismaService,
  ) {}

  async set(target: PanelCredentialTarget, credentials: string, actorId: string | null, secret: PanelSecret = 'login'): Promise<SecretState> {
    if (credentials.trim() === '') throw new PanelCredentialRefused('empty_value', target.panelId);
    await this.assertOwner(target);

    const ref = { tenantId: target.tenantId, kind: TenantCredentialKind.panel_credentials, label: panelSecretLabel[secret](target.panelId) };
    await this.vault.put(ref, credentials, { createdBy: actorId ?? undefined });
    this.logger.log(`panel ${target.panelId} ${secret} set`);

    const s = await this.vault.summary(ref);
    // Picked field by field, never spread: `CredentialSummary` carries the fingerprint.
    return s?.configured ? { configured: true, version: s.version, rotatedAt: s.rotatedAt } : { configured: false, version: null, rotatedAt: null };
  }

  /**
   * The login, for `network-service`'s Opener (F-027-aw) — the one place a
   * panel's plaintext leaves the vault. The vault is the one the row's
   * reference names **and** the owner's, checked as `set` checks it: a
   * reference edited to name another tenant is refused before anything is
   * decrypted. Every read is logged by the vault under {@link PANEL_SECRET_CALLER}.
   *
   * `radius_secret` reads `panelRadiusSecret` and only that (F-027-az): a push
   * panel with no secret reference is refused, never answered with its login.
   */
  async use(panelId: string, secret: PanelSecret = 'login'): Promise<string> {
    const panel = await this.prisma.panel.findUnique({
      where: { id: panelId },
      select: { ownershipType: true, tenantId: true, panelApiCredentials: true, panelRadiusSecret: true },
    });
    if (!panel) throw new PanelCredentialRefused('panel_not_found', panelId);
    const stored = panel[REF_COLUMN[secret]] ?? '';
    const tenantId = stored.split(':')[1] ?? '';
    if (stored !== panelSecretRef[secret](tenantId, panelId)) {
      throw new PanelCredentialRefused('credential_unavailable', `${panelId}: the row holds no ${secret} reference`);
    }
    await this.assertOwner({ tenantId, panelId }, panel);

    const ref = { tenantId, kind: TenantCredentialKind.panel_credentials, label: panelSecretLabel[secret](panelId) };
    try {
      return await this.vault.use(ref, { caller: PANEL_SECRET_CALLER[secret] });
    } catch (e) {
      if (e instanceof CredentialUnavailable) throw new PanelCredentialRefused('credential_unavailable', `${panelId}: ${e.reason}`);
      throw e;
    }
  }

  private async assertOwner(
    target: PanelCredentialTarget,
    loaded?: { ownershipType: PanelOwnershipType; tenantId: string | null },
  ): Promise<void> {
    const panel =
      loaded ??
      (await this.prisma.panel.findUnique({
        where: { id: target.panelId },
        select: { ownershipType: true, tenantId: true },
      }));
    if (!panel) throw new PanelCredentialRefused('panel_not_found', target.panelId);
    if (panel.ownershipType === PanelOwnershipType.tenant) {
      if (panel.tenantId !== target.tenantId) throw new PanelCredentialRefused('not_owner', target.panelId);
      return;
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: target.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) throw new PanelCredentialRefused('not_owner', target.panelId);
  }
}
