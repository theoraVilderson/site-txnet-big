import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { deleteGrant, Deletion } from '../../entitlement/delete';
import { changeGrantDuration, DurationChange, DurationMove } from '../../entitlement/duration';
import { Freeze, freezeGrant, Unfreeze, unfreezeGrant } from '../../entitlement/freeze';
import { EntitlementRefused, GrantService } from '../../entitlement/grant';
import { adjustGrantTraffic, resetGrantTraffic, TrafficChange, TrafficReset } from '../../entitlement/traffic';
import { giftGrantBytes } from '../../traffic/gift-bytes';
import { PrismaService } from '../../prisma/prisma.service';
import { GrantUsageService, GrantUsageView } from '../../traffic/grant-usage';
import { RemainderCreditService } from '../../traffic/remainder-credit';
import { AdminConfigCommand, UserConfigOutcome, UserConfigsService, UserConfigView } from '../../traffic/user-configs';
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
 * An admin reads one user's services (F-311-f, spec F-311) and acts on their
 * configs (F-311-g, spec F-307):
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
    private readonly remainders: RemainderCreditService,
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

  /**
   * An admin resets this user's `/sub` link (F-311-n): the owner's own reset,
   * asked as the path's user in the reseller's scope — its host, one
   * transaction, the old link dead as the new one exists. `staffWrite`: a
   * suspended reseller reads the link but destroys none.
   */
  rotateLink(actor: ResellerActor, tenantId: string, userId: string, grantId: string): Promise<string> {
    return this.run(actor, tenantId, userId, () => this.links.reset(grantId, userId), 'staffWrite');
  }

  /**
   * An admin's config action on this user's configs (F-311-g): the door is
   * `staffWrite`, so a suspended reseller reads its users' services but
   * changes none. One outcome per config; the fence to this user's configs is
   * `actAsAdmin`'s.
   */
  act(actor: ResellerActor, tenantId: string, userId: string, command: AdminConfigCommand): Promise<UserConfigOutcome[]> {
    return this.run(actor, tenantId, userId, () => this.configService.actAsAdmin(actor.userId, userId, command), 'staffWrite');
  }

  /**
   * An admin freezes this user's Grant (F-311-h), until `until` or until
   * unfrozen: `staffWrite`, as for a config action. A Grant of another user
   * is `grant_not_found`, never frozen.
   */
  freeze(actor: ResellerActor, tenantId: string, userId: string, grantId: string, until: Date | null): Promise<Freeze> {
    return this.run(actor, tenantId, userId, () => this.onGrant(userId, grantId, (tx) => freezeGrant(tx, grantId, { at: new Date(), until })), 'staffWrite');
  }

  /** An admin unfreezes it: the frozen time is added to its end (F-311-h). */
  unfreeze(actor: ResellerActor, tenantId: string, userId: string, grantId: string): Promise<Unfreeze> {
    return this.run(actor, tenantId, userId, () => this.onGrant(userId, grantId, (tx) => unfreezeGrant(tx, grantId, new Date())), 'staffWrite');
  }

  /**
   * An admin moves this user's Grant's end by ±N days or to a date (F-311-i),
   * written down with the admin and the reason: `staffWrite`, as for a freeze.
   */
  changeDuration(actor: ResellerActor, tenantId: string, userId: string, grantId: string, change: DurationMove, reason: string): Promise<DurationChange> {
    return this.run(
      actor,
      tenantId,
      userId,
      () => this.onGrant(userId, grantId, (tx) => changeGrantDuration(tx, grantId, { at: new Date(), actorUserId: actor.userId, change, reason })),
      'staffWrite',
    );
  }

  /**
   * An admin moves this user's prepaid Grant's traffic by ±bytes (F-311-j),
   * written down with the admin and the reason: `staffWrite`, as for a freeze.
   */
  changeTraffic(actor: ResellerActor, tenantId: string, userId: string, grantId: string, deltaBytes: bigint, reason: string): Promise<TrafficChange> {
    return this.run(
      actor,
      tenantId,
      userId,
      () => this.onGrant(userId, grantId, (tx) => adjustGrantTraffic(tx, grantId, { at: new Date(), actorUserId: actor.userId, deltaBytes, reason })),
      'staffWrite',
    );
  }

  /**
   * An admin resets this user's prepaid Grant's traffic (F-311-k): Quota rises
   * by what was used since the last reset, the meter untouched. `staffWrite`.
   */
  resetTraffic(actor: ResellerActor, tenantId: string, userId: string, grantId: string, reason: string): Promise<TrafficReset> {
    return this.run(
      actor,
      tenantId,
      userId,
      () => this.onGrant(userId, grantId, (tx) => resetGrantTraffic(tx, grantId, { at: new Date(), actorUserId: actor.userId, reason })),
      'staffWrite',
    );
  }

  /**
   * An admin gifts bytes to this user's metered Grant (F-311-l): the bag rises,
   * nothing is debited, and the remainder credit never pays them out. `staffWrite`.
   */
  giftTraffic(actor: ResellerActor, tenantId: string, userId: string, grantId: string, bytes: bigint, reason: string): Promise<TrafficChange> {
    return this.run(
      actor,
      tenantId,
      userId,
      () => this.onGrant(userId, grantId, (tx) => giftGrantBytes(tx, grantId, { at: new Date(), actorUserId: actor.userId, bytes, reason })),
      'staffWrite',
    );
  }

  /**
   * An admin deletes this user's Grant (F-311-m): cancelled, its configs
   * released now, the remainder refunded or not as the admin answered, and the
   * choice written down with the reason. `staffWrite`, as for a freeze.
   */
  deleteGrant(actor: ResellerActor, tenantId: string, userId: string, grantId: string, refund: boolean, reason: string): Promise<Deletion> {
    return this.run(
      actor,
      tenantId,
      userId,
      () =>
        this.onGrant(userId, grantId, (tx) =>
          deleteGrant(tx, grantId, { at: new Date(), actorUserId: actor.userId, reason, refund }, (t, id, clock) => this.remainders.settle(t, { grantId: id, ...clock })),
        ),
      'staffWrite',
    );
  }

  /** `work` on the Grant, in one transaction, only if it is the path's user's. */
  private onGrant<T>(userId: string, grantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return tenantTransaction(this.prisma, async (tx) => {
      const mine = await tx.grant.findFirst({ where: { id: grantId, userId }, select: { id: true } });
      if (!mine) throw new EntitlementRefused('grant_not_found');
      return work(tx);
    });
  }

  /** Admit, run in the reseller's scope, check the user is its own, then `work`; the door's refusal becomes this surface's one type. */
  private async run<T>(
    actor: ResellerActor,
    tenantId: string,
    userId: string,
    work: () => Promise<T>,
    capability: 'read' | 'staffWrite' = 'read',
  ): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, capability, async () => {
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
