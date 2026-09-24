import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CounterSemantics,
  DriverType,
  PanelOwnershipType,
  PanelReviewState,
  PanelRole,
  PanelTransport,
  TenantType,
} from '@prisma/client';
import { panelCredentialRef } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

/** Who is registering: the gate's user and tenant, never a body field. */
export type SystemsActor = { adminId: string; tenantId: string };

/** A panel as its owner declares it. The questionnaire is the connection test's to answer, not this. */
export type RegisterPanelInput = {
  name: string;
  ipAddress: string;
  apiBaseUrl?: string | null;
  driverType: DriverType;
  counterSemantics: CounterSemantics;
  transport: PanelTransport;
  role: PanelRole;
  region: string;
  maxRequestsPerMinute?: number;
  /** The panel's login, opaque to us. Relayed to the vault once and kept nowhere. */
  credentials: string;
};

/** What the vault says about a stored login: no value, no fingerprint. */
export type PanelCredentialState = { configured: boolean; version: number | null; rotatedAt: string | null };

/** The write seam on `tenant-service` (`/internal/vault/panel-credential`), as this service sees it. */
export interface PanelCredentialWriter {
  set(target: { tenantId: string; panelId: string }, credentials: string, actorId: string): Promise<PanelCredentialState>;
}

export const PANEL_CREDENTIAL_WRITER = Symbol('PANEL_CREDENTIAL_WRITER');

export type PanelRegistrationRejection = 'not_platform_owner';

export class PanelRegistrationRefused extends Error {
  constructor(readonly reason: PanelRegistrationRejection) {
    super(reason);
    this.name = 'PanelRegistrationRefused';
  }
}

/**
 * Registering a panel (F-027-ar, ADR-0080 decision 1): a desired-state write.
 *
 * The row lands `pending` and this is all that happens here. `network-service`
 * finds it on its next tick, runs the connection test and writes the verdict
 * (`network/contract.registration.md`); nothing calls the Go service, which by
 * ADR-0071 has no route to call.
 *
 * **Owner-only, scoped by tenant from the first line** (decision 2). The
 * caller's tenant must be the platform owner, and the panel is written as the
 * platform's (`ownershipType = platform`, `tenantId` null — network invariant
 * 9). Opening this to a reseller is a change to {@link ownerOf} and a decision
 * (`network/open-questions.md`: the collector would dial an address a tenant
 * chose), not a rewrite.
 *
 * **The login goes to the vault and nowhere else.** `panelApiCredentials`
 * holds {@link panelCredentialRef}; the login itself is relayed to
 * `tenant-service`'s writer, which re-derives that the named tenant owns the
 * panel before storing it (the gateway seam's shape, D-31). Row first, vault
 * second, because the writer checks the row exists; a vault that fails
 * deletes the row again, so no tick ever tests a panel whose login was never
 * stored.
 *
 * `network.panel` has no RLS policy, so the app pool writes it directly.
 */
@Injectable()
export class PanelRegistrationService {
  private readonly logger = new Logger(PanelRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PANEL_CREDENTIAL_WRITER) private readonly vault: PanelCredentialWriter,
  ) {}

  async register(actor: SystemsActor, input: RegisterPanelInput) {
    const owner = await this.ownerOf(actor);
    const id = randomUUID();

    await this.prisma.panel.create({
      data: {
        id,
        ...owner,
        name: input.name,
        ipAddress: input.ipAddress,
        apiBaseUrl: input.apiBaseUrl ?? null,
        driverType: input.driverType,
        counterSemantics: input.counterSemantics,
        transport: input.transport,
        role: input.role,
        region: input.region,
        ...(input.maxRequestsPerMinute !== undefined ? { maxRequestsPerMinute: input.maxRequestsPerMinute } : {}),
        reviewState: PanelReviewState.pending,
        panelApiCredentials: panelCredentialRef(actor.tenantId, id),
      },
    });

    let credentials: PanelCredentialState;
    try {
      credentials = await this.vault.set({ tenantId: actor.tenantId, panelId: id }, input.credentials, actor.adminId);
    } catch (err) {
      await this.prisma.panel.delete({ where: { id } });
      throw err;
    }

    this.logger.log(`panel ${id} (${input.driverType}) registered by ${actor.adminId}; pending its connection test`);
    return { id, reviewState: PanelReviewState.pending, credentials };
  }

  /**
   * The door and the scope in one place. Read on the app pool: `tenant.tenant`
   * has no RLS policy (as in `GatewayAdminService.isOwner`).
   */
  private async ownerOf(actor: SystemsActor) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) throw new PanelRegistrationRefused('not_platform_owner');
    return { ownershipType: PanelOwnershipType.platform, tenantId: null };
  }
}
