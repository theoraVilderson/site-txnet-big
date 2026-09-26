import { Injectable } from '@nestjs/common';
import {
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { GrantService } from '../../entitlement/grant';
import { PrismaService } from '../../prisma/prisma.service';
import { GrantUsageService, GrantUsageView } from '../../traffic/grant-usage';
import { UserConfigsService, UserConfigView } from '../../traffic/user-configs';
import { GrantListQuery } from './grant-list.schema';
import { SubscriptionLinkService } from './subscription-link.service';

/** The door's refusals, and the one this surface adds: the path's user is not the reseller's. */
export type ResellerUserGrantsRejection = ResellerAccessRejection | 'user_not_found';

export class ResellerUserGrantsRefused extends Error {
  constructor(
    readonly reason: ResellerUserGrantsRejection,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ResellerUserGrantsRefused';
  }
}

/**
 * An admin reads one user's services (F-311-f, spec F-311):
 * `/api/billing/tenants/:tenantId/users/:userId/grants...` — the user's
 * Grants, one Grant's configs, its 30-day usage and its `/sub` link.
 *
 * **The four reads are the owner's own**, unchanged (F-502-r, F-027-ac,
 * F-307-b, F-114-e-b): each takes the user as an argument and checks the Grant
 * is theirs, so it is asked here with the **path's** user. What this adds is
 * the door and the scope — `ResellerAccess.run` (`read`, so a suspended
 * reseller still sees its users' services) opens the reseller's tenant, and
 * only then is anything read.
 *
 * **Only that reseller's users** (C-15). The user is looked up first, in the
 * reseller's scope, where RLS and `TENANT_SCOPED_MODELS` hide every other
 * tenant's user: another reseller's user, the platform's, or none at all is
 * `user_not_found`, and no Grant is read for them. A Grant of another user of
 * the same reseller is then the owner read's own 404, as it is for the owner.
 */
@Injectable()
export class ResellerUserGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly grantService: GrantService,
    private readonly configService: UserConfigsService,
    private readonly usageService: GrantUsageService,
    private readonly links: SubscriptionLinkService,
  ) {}

  grants(actor: ResellerActor, tenantId: string, userId: string, query: GrantListQuery) {
    return this.run(actor, tenantId, userId, () => this.grantService.listForUser(userId, query));
  }

  configs(actor: ResellerActor, tenantId: string, userId: string, grantId: string): Promise<UserConfigView[]> {
    return this.run(actor, tenantId, userId, () => this.configService.listForGrant(userId, grantId));
  }

  usage(actor: ResellerActor, tenantId: string, userId: string, grantId: string): Promise<GrantUsageView> {
    return this.run(actor, tenantId, userId, () => this.usageService.dailyForGrant(userId, grantId));
  }

  subscriptionLink(actor: ResellerActor, tenantId: string, userId: string, grantId: string): Promise<string> {
    return this.run(actor, tenantId, userId, () => this.links.linkFor(grantId, userId));
  }

  /** Admit, run in the reseller's scope, check the user is its own, then `work`; the door's refusal becomes this surface's one type. */
  private async run<T>(actor: ResellerActor, tenantId: string, userId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, 'read', async () => {
        const user = await tenantTransaction(this.prisma, (tx) => tx.user.findFirst({ where: { id: userId }, select: { id: true } }));
        if (!user) throw new ResellerUserGrantsRefused('user_not_found', userId);
        return await work();
      });
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerUserGrantsRefused(e.reason, tenantId);
      throw e;
    }
  }
}
