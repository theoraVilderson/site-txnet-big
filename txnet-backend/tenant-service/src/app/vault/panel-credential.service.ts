import { Injectable, Logger } from '@nestjs/common';
import { PanelOwnershipType, TenantCredentialKind, TenantType } from '@prisma/client';
import { CredentialUnavailable, CredentialVaultService, panelCredentialLabel, panelCredentialRef } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { SecretState } from './gateway-credential.service';

/** One panel, named the way `billing` names it: whose vault, which panel. */
export type PanelCredentialTarget = { tenantId: string; panelId: string };

export type PanelCredentialRejection = 'panel_not_found' | 'not_owner' | 'empty_value' | 'credential_unavailable';

/** How the collector is named in the vault's access log (F-027-aw). */
export const PANEL_OPENER_CALLER = 'network:Opener';

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

  async set(target: PanelCredentialTarget, credentials: string, actorId: string | null): Promise<SecretState> {
    if (credentials.trim() === '') throw new PanelCredentialRefused('empty_value', target.panelId);
    await this.assertOwner(target);

    const ref = { tenantId: target.tenantId, kind: TenantCredentialKind.panel_credentials, label: panelCredentialLabel(target.panelId) };
    await this.vault.put(ref, credentials, { createdBy: actorId ?? undefined });
    this.logger.log(`panel ${target.panelId} login set`);

    const s = await this.vault.summary(ref);
    // Picked field by field, never spread: `CredentialSummary` carries the fingerprint.
    return s?.configured ? { configured: true, version: s.version, rotatedAt: s.rotatedAt } : { configured: false, version: null, rotatedAt: null };
  }

  /**
   * The login, for `network-service`'s Opener (F-027-aw) — the one place a
   * panel's plaintext leaves the vault. The vault is the one the row's
   * reference names **and** the owner's, checked as `set` checks it: a
   * reference edited to name another tenant is refused before anything is
   * decrypted. Every read is logged by the vault under {@link PANEL_OPENER_CALLER}.
   */
  async use(panelId: string): Promise<string> {
    const panel = await this.prisma.panel.findUnique({
      where: { id: panelId },
      select: { ownershipType: true, tenantId: true, panelApiCredentials: true },
    });
    if (!panel) throw new PanelCredentialRefused('panel_not_found', panelId);
    const tenantId = panel.panelApiCredentials.split(':')[1] ?? '';
    if (panel.panelApiCredentials !== panelCredentialRef(tenantId, panelId)) {
      throw new PanelCredentialRefused('credential_unavailable', `${panelId}: the row holds no vault reference`);
    }
    await this.assertOwner({ tenantId, panelId }, panel);

    const ref = { tenantId, kind: TenantCredentialKind.panel_credentials, label: panelCredentialLabel(panelId) };
    try {
      return await this.vault.use(ref, { caller: PANEL_OPENER_CALLER });
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
