import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  TenantCapabilityName,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import type { AudienceFilter } from './campaign-admin.schema';
import {
  CampaignAdminRefused,
  CampaignAdminRejection,
  CampaignAdminService,
  CampaignView,
  CreateCampaignInput,
} from './campaign-admin.service';
import { audienceWhere } from './campaign-fan-out.service';
import type { ResellerListCampaignsQuery } from './reseller-campaign.schema';

/** Two doors close here: the reseller's, and the campaign rules behind it. */
export type ResellerCampaignRejection = ResellerAccessRejection | CampaignAdminRejection;

export class ResellerCampaignRefused extends Error {
  constructor(
    readonly reason: ResellerCampaignRejection,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ResellerCampaignRefused';
  }
}

export type AudienceCount = { count: number };

/**
 * A reseller's own campaigns (F-313-d, spec F-313):
 * `/api/notifications/tenants/:tenantId/campaigns…` — drafting, sizing,
 * listing and starting a broadcast for the reseller the **path** names. The
 * data half of the bot's bulk-send flow (F-313-b), built here once so F-312,
 * F-1531 and a future panel page share it, the way F-066-w3 serves F-066-w4.
 *
 * **Why it is not `CampaignAdminService`.** That service scopes a campaign to
 * the *caller's* tenant, with anything else the platform owner's alone. A
 * reseller's owner signs in to the platform owner's tenant (ADR-0059 (6),
 * F-061-i), so their session never names the reseller whose campaign this is:
 * the reseller's id is `not_platform_owner`, and no id at all drafts for the
 * platform — an audience of every tenant's users. That is the same gap F-311-e
 * was split out for, answered the same way (ADR-0064 (1)-(2)).
 *
 * **It delegates rather than copies.** `ResellerAccess.run` admits the caller
 * and opens the reseller's scope; the work inside it is `CampaignAdminService`
 * called with an actor that names the **reseller**. Every campaign rule —
 * draft-only writes, whether an SMS line exists, the `campaign_send` audit row,
 * which pool serves the caller — is then the one already written and tested for
 * F-035-c/d, rather than a second copy that drifts from it. `notificationCampaign`
 * and `user` are both in `TENANT_SCOPED_MODELS`, so inside the scope no query
 * below names a tenant: a filter written by hand is a filter that can be
 * written wrong, and the mistake this surface exists to prevent is one
 * reseller broadcasting to another's users.
 *
 * **No permission guard**, as on every other reseller-named surface (F-311-a,
 * F-311-b): a reseller's owner holds no operator permission — `campaign.manage`
 * is the platform's staff door — so `ResellerAccess` is the door.
 */
@Injectable()
export class ResellerCampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly admin: CampaignAdminService,
  ) {}

  /** This reseller's campaigns, newest first. `read`, so a suspended reseller still sees what it sent. */
  async list(actor: ResellerActor, tenantId: string, query: ResellerListCampaignsQuery) {
    return this.run(actor, tenantId, 'read', (as) =>
      this.admin.list(as, { page: query.page, pageSize: query.pageSize, status: query.status }),
    );
  }

  /** One of them, by id. A campaign outside this reseller is `campaign_not_found`, never a 403. */
  async get(actor: ResellerActor, tenantId: string, id: string): Promise<CampaignView> {
    return this.run(actor, tenantId, 'read', (as) => this.admin.get(as, id));
  }

  /**
   * How many users a segment reaches, **before** anything is drafted or sent.
   * `read`: it counts and writes nothing.
   *
   * The `where` is `audienceWhere` — the fan-out's own function (F-035-d), not
   * a second query that agrees with it today. The number a reseller confirms is
   * therefore the number of recipient rows that will be written, up to the
   * users who sign up between the two moments: `sendStartedAt` is `now` here
   * and the send's own start there, which is the one difference and is the
   * reason the count is called an estimate on screen.
   */
  async audienceCount(
    actor: ResellerActor,
    tenantId: string,
    audience: AudienceFilter,
    now = new Date(),
  ): Promise<AudienceCount> {
    return this.run(actor, tenantId, 'read', async (as) => ({
      count: await this.prisma.user.count({
        where: audienceWhere({ tenantId: as.tenantId, sendStartedAt: now }, audience) as Prisma.UserWhereInput,
      }),
    }));
  }

  /** Drafts one. `staffWrite`: a suspended reseller does not start new work (`tenant/rules.md`). */
  async create(actor: ResellerActor, tenantId: string, body: Omit<CreateCampaignInput, 'tenantId'>): Promise<CampaignView> {
    // No `tenantId` is passed on: absent means "the actor's", and the actor is
    // the reseller. The schema refuses a body that names one, so the path is
    // the only place the scope is written.
    return this.run(actor, tenantId, 'staffWrite', (as) => this.admin.create(as, body));
  }

  /** Starts the send (F-035-d): `draft -> sending`, audited, the worker fans it out. `staffWrite`. */
  async send(actor: ResellerActor, tenantId: string, id: string, ip: string): Promise<CampaignView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.admin.send(as, id, ip));
  }

  /**
   * Admit, run in the admitted reseller's scope, and translate both doors'
   * refusals into this surface's one type. The delegated actor is the whole
   * point: `adminId` is who acted, and `tenantId` is the **reseller**, which is
   * what makes the campaign row, its audit row and the pool that serves it the
   * reseller's rather than the session's.
   */
  private async run<T>(
    actor: ResellerActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (as: { adminId: string; tenantId: string }) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, capability, (reseller) =>
        work({ adminId: actor.userId, tenantId: reseller.id }),
      );
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerCampaignRefused(e.reason, tenantId);
      if (e instanceof CampaignAdminRefused) throw new ResellerCampaignRefused(e.reason, e.message);
      throw e;
    }
  }
}
