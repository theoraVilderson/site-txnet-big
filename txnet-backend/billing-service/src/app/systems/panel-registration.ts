import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConnectionTestFault, CounterSemantics, DriverType, PanelReviewState, PanelRole, PanelTransport } from '@prisma/client';
import { panelCredentialRef } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

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

/** Why a re-submitted login is refused, beyond the scope's own refusals. */
export type ResubmitRejection = 'panel_refused';

export class PanelResubmitRefused extends Error {
  constructor(readonly reason: ResubmitRejection) {
    super(reason);
    this.name = 'PanelResubmitRefused';
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
 * 9). Opening this to a reseller is a change to {@link panelScopeOf} and a decision
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
    const owner = await panelScopeOf(this.prisma, actor);
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
   * Re-submitting a panel's login (F-027-au): rotated in the vault (`put` is
   * also rotate, `tenant/contract.vault.md` rule 3), then — only on a panel
   * still `pending` — the last connection test is cleared, so the next tick
   * tests the corrected login instead of waiting out its retry
   * (`network/contract.registration.md` rule 4).
   *
   * - An **accepted** panel is rotated and nothing else: collection reads only
   *   an accepted panel (invariant 44), and a password change must not stop it.
   * - A **refused** panel is 409 `panel_refused`: it was refused on its answers,
   *   and a new login changes none of them. Nothing is written.
   * - A **`rate_limited`** fault keeps its time. It is not a bad login, and
   *   retrying through a ban is what makes it permanent.
   *
   * Vault first, row second: a vault that fails leaves the row as it was. The
   * clear is conditional on `pending`, so a verdict the tick wrote meanwhile
   * stands, and `retest` says whether the clear landed.
   */
  async resubmitCredentials(actor: SystemsActor, panelId: string, credentials: string) {
    const scope = await panelScopeOf(this.prisma, actor);
    const where = { id: panelId, ...scope };
    const panel = await this.prisma.panel.findFirst({ where, select: { reviewState: true, connectionTestFault: true } });
    if (!panel) throw new SystemsRefused('not_found');
    if (panel.reviewState === PanelReviewState.refused) throw new PanelResubmitRefused('panel_refused');

    const stored = await this.vault.set({ tenantId: actor.tenantId, panelId }, credentials, actor.adminId);

    let reviewState: PanelReviewState = panel.reviewState;
    let retest = false;
    if (panel.reviewState === PanelReviewState.pending && panel.connectionTestFault !== ConnectionTestFault.rate_limited) {
      const cleared = await this.prisma.panel.updateMany({
        where: { ...where, reviewState: PanelReviewState.pending },
        data: { connectionTestedAt: null, connectionTestFault: null, connectionTestDetail: null },
      });
      retest = cleared.count > 0;
      if (!retest) reviewState = (await this.prisma.panel.findFirst({ where, select: { reviewState: true } }))?.reviewState ?? reviewState;
    }

    this.logger.log(`panel ${panelId}: login re-submitted by ${actor.adminId}${retest ? '; re-tested on the next tick' : ''}`);
    return { id: panelId, reviewState, retest, credentials: stored };
  }
}
