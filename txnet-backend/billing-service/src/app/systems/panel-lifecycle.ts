import { Injectable, Logger } from '@nestjs/common';
import { PanelReviewState, PanelTransport } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

/** A panel's own settings, as the owner edits them (F-027-by). Any of them, at least one. */
export type PanelSettingsInput = {
  name?: string;
  region?: string;
  ipAddress?: string | null;
  apiBaseUrl?: string;
  clientBaseUrl?: string | null;
  maxRequestsPerMinute?: number;
};

/** The addresses the connection test reached: changing one may point at another server. */
const TESTED_ADDRESSES = ['apiBaseUrl', 'clientBaseUrl'] as const;

/**
 * A registered panel's life after registration, on the systems surface
 * (`billing/contract.panel-lifecycle.md`): editing its settings.
 *
 * Desired state, as every route here: nothing calls `network-service`
 * (ADR-0071). A changed address sends the panel back to `pending` with its
 * last test cleared, and the next tick tests the new one
 * (`network/contract.registration.md` rule 4). Writes go through the
 * cross-tenant pool after `panelScopeOf`, as in `PanelRegistrationService`: a
 * platform panel's `tenantId` is null, and the app pool's `WITH CHECK` refuses it.
 */
@Injectable()
export class PanelLifecycleService {
  private readonly logger = new Logger(PanelLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** The platform owner's pool, for the panel writes only. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /**
   * Only what the body names is written. An address that differs from the
   * stored one is a re-test — of an accepted panel too, since its verdict was
   * about the old server, and of a refused one, since the new server has not
   * been asked. A push panel is never called: it takes no API or link address
   * and cannot drop the IP its NAS is allowlisted by (`not_for_transport`).
   */
  async update(actor: SystemsActor, panelId: string, input: PanelSettingsInput) {
    const scope = await panelScopeOf(this.prisma, actor);
    const where = { id: panelId, ...scope };
    const panel = await this.prisma.panel.findFirst({
      where,
      select: { transport: true, reviewState: true, apiBaseUrl: true, clientBaseUrl: true },
    });
    if (!panel) throw new SystemsRefused('not_found');

    if (panel.transport === PanelTransport.push) {
      const pullOnly = input.apiBaseUrl !== undefined || (input.clientBaseUrl !== undefined && input.clientBaseUrl !== null);
      if (pullOnly || input.ipAddress === null) throw new SystemsRefused('not_for_transport');
    }

    const retest = TESTED_ADDRESSES.some((k) => input[k] !== undefined && input[k] !== panel[k]);
    const data = {
      ...input,
      ...(retest
        ? { reviewState: PanelReviewState.pending, connectionTestedAt: null, connectionTestFault: null, connectionTestDetail: null }
        : {}),
    };
    const { count } = await this.all.panel.updateMany({ where, data });
    if (count === 0) throw new SystemsRefused('not_found');

    this.logger.log(`panel ${panelId} edited by ${actor.adminId}${retest ? '; address changed, re-tested on the next tick' : ''}`);
    return { id: panelId, reviewState: retest ? PanelReviewState.pending : panel.reviewState, retest };
  }
}
