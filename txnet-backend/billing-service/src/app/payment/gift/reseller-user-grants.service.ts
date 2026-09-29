import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import { AdminIssued, issueGrantByAdmin } from '../../entitlement/admin-issue';
import { AdminRenew, AdminRenewed, renewGrantByAdmin } from '../../entitlement/admin-renewal';
import { deleteGrant, Deletion } from '../../entitlement/delete';
import { DeviceLimitChange, setGrantDeviceLimit } from '../../entitlement/devices';
import { changeGrantDuration, DurationChange, DurationMove } from '../../entitlement/duration';
import { Freeze, freezeGrant, Unfreeze, unfreezeGrant } from '../../entitlement/freeze';
import { EntitlementRefused, GrantPage, GrantService, TenantGrantView } from '../../entitlement/grant';
import { adjustGrantTraffic, resetGrantTraffic, TrafficChange, TrafficReset } from '../../entitlement/traffic';
import { giftGrantBytes } from '../../traffic/gift-bytes';
import { setGrantSpeed, SpeedChange } from '../../traffic/grant-speed';
import { AuditSpec, auditedConfigAct, auditedGrantAct, grantHistory } from '../../grant-audit/grant-audit';
import { PrismaService } from '../../prisma/prisma.service';
import { GrantUsageService, GrantUsageView } from '../../traffic/grant-usage';
import { RemainderCreditService } from '../../traffic/remainder-credit';
import { AdminConfigCommand, UserConfigOutcome, UserConfigsService, UserConfigView } from '../../traffic/user-configs';
import { GrantBulkBody } from './grant-bulk.schema';
import { GrantListQuery, GrantsByLinesBody } from './grant-list.schema';
import { actOnEach, GrantBulkOutcome } from './reseller-grants-bulk';
import { SubscriptionLinkService } from './subscription-link.service';
import { UsersCatalogProduct, usersCatalogOf } from './reseller-users-catalog';

/** The door's refusals, and the one this surface adds: the path's user is not the reseller's. */
export type ResellerUserGrantsRejection = ResellerAccessRejection | 'user_not_found';

/** The door's actor and the address the request came from: every write here is audited (F-311-r). */
export type AdminActor = ResellerActor & { ip: string };

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
/** A panel a config may move to (F-311-v1); `own` is the reseller's dedicated one, else shared. */
export interface MoveTarget {
  id: string;
  name: string;
  region: string;
  own: boolean;
}

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
   * The panels an admin may move one of this user's configs to (F-311-v1):
   * shared (`tenantId` null) or this reseller's own, not retired — the rule
   * `ConfigActionsService.move` holds — and accepted by review, since a move
   * to a panel nothing provisions strands the config. **`network.panel` has no
   * RLS**, so the path's tenant is written into the filter; the reseller's
   * scope would hide nothing. No address and no credential is selected.
   */
  moveTargets(actor: ResellerActor, tenantId: string, userId: string): Promise<MoveTarget[]> {
    return this.run(actor, tenantId, userId, async () => {
      const panels = await tenantTransaction(this.prisma, (tx) =>
        tx.panel.findMany({
          where: { retiredAt: null, reviewState: { in: ['accepted', 'accepted_low_trust'] }, OR: [{ tenantId: null }, { tenantId }] },
          select: { id: true, name: true, region: true, tenantId: true },
          orderBy: [{ region: 'asc' }, { name: 'asc' }],
        }),
      );
      return panels.map((p) => ({ id: p.id, name: p.name, region: p.region, own: p.tenantId !== null }));
    });
  }

  /**
   * The products and plans the users pages name — issue, bulk by product
   * (F-311-ab1, D-57): `read` on this door, so managing users never needs
   * `catalog.manage`. The platform's own are `tenantId` null (`platform`).
   */
  catalog(actor: ResellerActor, tenantId: string): Promise<UsersCatalogProduct[]> {
    return this.admitted(actor, tenantId, 'read', (admitted) =>
      tenantTransaction(this.prisma, (tx) => usersCatalogOf(tx, admitted.platform ? null : tenantId)),
    );
  }

  /**
   * An admin finds a service by a pasted config line or `/sub` link across the
   * reseller's users (F-311-t): the owner's matcher (F-307-p, F-307-r) over the
   * reseller's tenant, each row naming its user. `read`, as the user reads:
   * there is no path user to check — the paste is what names them.
   */
  findByLines(actor: ResellerActor, tenantId: string, body: GrantsByLinesBody): Promise<GrantPage<TenantGrantView>> {
    return this.admitted(actor, tenantId, 'read', () => this.grantService.listByLinesInScope(body));
  }

  /**
   * An admin resets this user's `/sub` link (F-311-n): the owner's own reset,
   * asked as the path's user in the reseller's scope — its host, one
   * transaction, the old link dead as the new one exists. `staffWrite`: a
   * suspended reseller reads the link but destroys none.
   */
  rotateLink(actor: AdminActor, tenantId: string, userId: string, grantId: string, reason: string | null): Promise<string> {
    const spec: AuditSpec<string> = { action: 'grant_link_rotate', reason };
    return this.run(
      actor,
      tenantId,
      userId,
      () => this.links.reset(grantId, userId, (tx, rotate) => auditedGrantAct(tx, actor, tenantId, grantId, spec, rotate)),
      'staffWrite',
    );
  }

  /**
   * An admin's config action on this user's configs (F-311-g): the door is
   * `staffWrite`, so a suspended reseller reads its users' services but
   * changes none. One outcome per config; the fence to this user's configs is
   * `actAsAdmin`'s.
   */
  act(actor: AdminActor, tenantId: string, userId: string, command: AdminConfigCommand): Promise<UserConfigOutcome[]> {
    const audit = <T extends string | void>(tx: Prisma.TransactionClient, configId: string, step: () => Promise<T>) =>
      auditedConfigAct(tx, actor, tenantId, configId, `config_${command.action}`, command.reason ?? null, step);
    return this.run(actor, tenantId, userId, () => this.configService.actAsAdmin(actor.userId, userId, command, audit), 'staffWrite');
  }

  /**
   * An admin freezes this user's Grant (F-311-h), until `until` or until
   * unfrozen: `staffWrite`, as for a config action. A Grant of another user
   * is `grant_not_found`, never frozen.
   */
  freeze(actor: AdminActor, tenantId: string, userId: string, grantId: string, until: Date | null, reason: string | null): Promise<Freeze> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_freeze', reason, outcome: (r) => r }, (tx) => freezeGrant(tx, grantId, { at: new Date(), until }));
  }

  /** An admin unfreezes it: the frozen time is added to its end (F-311-h). */
  unfreeze(actor: AdminActor, tenantId: string, userId: string, grantId: string, reason: string | null): Promise<Unfreeze> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_unfreeze', reason, outcome: (r) => r }, (tx) => unfreezeGrant(tx, grantId, new Date()));
  }

  /**
   * An admin moves this user's Grant's end by ±N days or to a date (F-311-i),
   * written down with the admin and the reason: `staffWrite`, as for a freeze.
   */
  changeDuration(actor: AdminActor, tenantId: string, userId: string, grantId: string, change: DurationMove, reason: string): Promise<DurationChange> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_duration_change', reason, outcome: (r) => r }, (tx) =>
      changeGrantDuration(tx, grantId, { at: new Date(), actorUserId: actor.userId, change, reason }),
    );
  }

  /**
   * An admin moves this user's prepaid Grant's traffic by ±bytes (F-311-j),
   * written down with the admin and the reason: `staffWrite`, as for a freeze.
   */
  changeTraffic(actor: AdminActor, tenantId: string, userId: string, grantId: string, deltaBytes: bigint, reason: string): Promise<TrafficChange> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_traffic_change', reason, outcome: (r) => r }, (tx) =>
      adjustGrantTraffic(tx, grantId, { at: new Date(), actorUserId: actor.userId, deltaBytes, reason }),
    );
  }

  /**
   * An admin resets this user's prepaid Grant's traffic (F-311-k): Quota rises
   * by what was used since the last reset, the meter untouched. `staffWrite`.
   */
  resetTraffic(actor: AdminActor, tenantId: string, userId: string, grantId: string, reason: string): Promise<TrafficReset> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_traffic_reset', reason, outcome: (r) => r }, (tx) =>
      resetGrantTraffic(tx, grantId, { at: new Date(), actorUserId: actor.userId, reason }),
    );
  }

  /**
   * An admin gifts bytes to this user's metered Grant (F-311-l): the bag rises,
   * nothing is debited, and the remainder credit never pays them out. `staffWrite`.
   */
  giftTraffic(actor: AdminActor, tenantId: string, userId: string, grantId: string, bytes: bigint, reason: string): Promise<TrafficChange> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_traffic_gift', reason, outcome: (r) => r }, (tx) =>
      giftGrantBytes(tx, grantId, { at: new Date(), actorUserId: actor.userId, bytes, reason }),
    );
  }

  /**
   * An admin sets or lifts this user's Grant's speed cap (F-311-p): written to
   * its panels' clients by the convergence pass, refused by name where a panel
   * cannot hold one. `staffWrite`, as for a gift.
   */
  setSpeed(actor: AdminActor, tenantId: string, userId: string, grantId: string, mbps: number | null, reason: string): Promise<SpeedChange> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_speed_set', reason, outcome: (r) => r }, (tx) =>
      setGrantSpeed(tx, grantId, { mbps, reason, actorUserId: actor.userId, at: new Date() }),
    );
  }

  /**
   * An admin sets or lifts this user's Grant's device limit (F-311-q): the
   * Grant's `concurrent_devices` quota, written to its panels' clients by the
   * convergence pass where they hold one. `staffWrite`, as for a speed cap.
   */
  setDevices(actor: AdminActor, tenantId: string, userId: string, grantId: string, limit: number | null, reason: string): Promise<DeviceLimitChange> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_devices_set', reason, outcome: (r) => r }, (tx) =>
      setGrantDeviceLimit(tx, grantId, { limit, reason, actorUserId: actor.userId, at: new Date() }),
    );
  }

  /**
   * An admin deletes this user's Grant (F-311-m): cancelled, its configs
   * released now, the remainder refunded or not as the admin answered, and the
   * choice written down with the reason. `staffWrite`, as for a freeze.
   */
  deleteGrant(actor: AdminActor, tenantId: string, userId: string, grantId: string, refund: boolean, reason: string): Promise<Deletion> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_delete', reason, outcome: (r) => r }, async (tx) => {
      const done = await deleteGrant(tx, grantId, { at: new Date(), actorUserId: actor.userId, reason, refund }, (t, id, clock) => this.remainders.settle(t, { grantId: id, ...clock }));
      // The reseller's unserved wholesale comes back whatever the admin answered (F-118-n3).
      await this.remainders.wholesaleBack(tx, grantId);
      return done;
    });
  }

  /**
   * An admin issues this user a service by hand (F-311-o): an `admin_grant`
   * Grant of the variant, active at once and placed like a purchase, no
   * invoice. `staffWrite`, as for a freeze; the user is the reseller's (`run`).
   */
  issue(actor: AdminActor, tenantId: string, userId: string, variantId: string, requestId: string, reason: string | null): Promise<AdminIssued> {
    const spec: AuditSpec<AdminIssued> & { targetOf: (r: AdminIssued) => string } = {
      action: 'grant_issue',
      reason,
      changed: (r) => r.issued,
      targetOf: (r) => r.grantId,
      outcome: (r) => ({ variantId: r.variantId, requestId }),
    };
    return this.run(
      actor,
      tenantId,
      userId,
      () =>
        tenantTransaction(this.prisma, (tx) =>
          auditedGrantAct(tx, actor, tenantId, null, spec, () =>
            issueGrantByAdmin(tx, this.grantService, { userId, variantId, requestId, actorUserId: actor.userId, at: new Date() }),
          ),
        ),
      'staffWrite',
    );
  }

  /**
   * An admin renews this user's Grant in place (F-311-d): one period of the
   * plan the user bought, or the amount typed; `admin_grant`, no money.
   * `staffWrite`, as for a freeze; a Grant of another user is `grant_not_found`.
   */
  renew(
    actor: AdminActor,
    tenantId: string,
    userId: string,
    grantId: string,
    input: Pick<AdminRenew, 'requestId' | 'reason' | 'amount'>,
  ): Promise<AdminRenewed> {
    return this.audited(actor, tenantId, userId, grantId, { action: 'grant_renew', reason: input.reason, changed: (r) => r.renewed, outcome: (r) => r }, (tx) =>
      renewGrantByAdmin(tx, { ...input, grantId, actorUserId: actor.userId, at: new Date() }),
    );
  }

  /**
   * An admin acts on many of the reseller's Grants at once (F-311-u), across
   * users — e.g. +3 days to everyone after an outage: `staffWrite`, admitted
   * once; each Grant fenced by the reseller's tenant, acted on and audited in
   * its own transaction, one outcome each (`reseller-grants-bulk.ts`).
   */
  bulk(actor: AdminActor, tenantId: string, command: GrantBulkBody): Promise<GrantBulkOutcome[]> {
    return this.admitted(actor, tenantId, 'staffWrite', () => actOnEach(this.prisma, actor, tenantId, command));
  }

  /**
   * This user's Grant's history (F-311-r): every audited act on it and its
   * configs, newest first. `read`, as for the Grant itself: a suspended
   * reseller still sees who did what.
   */
  history(actor: ResellerActor, tenantId: string, userId: string, grantId: string, page: { page: number; pageSize: number }) {
    return this.run(actor, tenantId, userId, () => this.onGrant(userId, grantId, (tx) => grantHistory(tx, grantId, page)));
  }

  /** `work` on this user's Grant as a `staffWrite`, written down in its transaction (F-311-r). */
  private audited<T>(
    actor: AdminActor,
    tenantId: string,
    userId: string,
    grantId: string,
    spec: AuditSpec<T>,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.run(actor, tenantId, userId, () => this.onGrant(userId, grantId, (tx) => auditedGrantAct(tx, actor, tenantId, grantId, spec, () => work(tx))), 'staffWrite');
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
    return this.admitted(actor, tenantId, capability, async () => {
      const user = await tenantTransaction(this.prisma, (tx) => tx.user.findFirst({ where: { id: userId }, select: { id: true } }));
      if (!user) throw new ResellerUserGrantsRefused('user_not_found', userId);
      return await work();
    });
  }

  /** The door, then `work` in the reseller's scope; the door's refusal becomes this surface's one type. */
  private async admitted<T>(actor: ResellerActor, tenantId: string, capability: 'read' | 'staffWrite', work: (admitted: AdmittedReseller) => Promise<T>): Promise<T> {
    try {
      return await this.access.runIncludingPlatform(actor, tenantId, capability, work);
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerUserGrantsRefused(e.reason, tenantId);
      throw e;
    }
  }
}
