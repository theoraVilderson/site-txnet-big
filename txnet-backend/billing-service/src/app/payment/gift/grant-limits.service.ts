import { Injectable } from '@nestjs/common';
import { Prisma, VariantBillingMode } from '@prisma/client';
import { ResellerAccess, ResellerAccessRefused, ResellerActor, ResellerLimitReached, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { meteredCapOf, meteredCeilingOf, OPEN_GRANT_STATUSES, PLATFORM_METERED_CAP, underCeiling } from '../../entitlement/metered-cap';
import { auditLimit } from '../../grant-audit/grant-audit';
import { PrismaService } from '../../prisma/prisma.service';
import { ResellerUserGrantsRefused } from './reseller-user-grants.service';
import type { AdminActor } from './reseller-user-grants.service';

export type TenantGrantLimit = {
  platformDefault: number;
  tenantDefault: number | null;
  effective: number;
  /** The reseller's ceiling (F-019-n): no number here is in effect above it. `null`: none. */
  ceiling: number | null;
};

export type UserGrantLimitView = {
  userId: string;
  /** The number staff set for this user, or `null` when the defaults apply. */
  own: { meteredOpenCap: number; reason: string | null; setByUserId: string; updatedAt: string } | null;
  tenantDefault: number | null;
  platformDefault: number;
  /** What a sale is refused by: `meteredCapOf`, the same function. */
  effective: number;
  /** The reseller's ceiling (F-019-n); `null`: none. */
  ceiling: number | null;
  /** Open metered Grants the user holds now. */
  open: number;
};

/**
 * Staff's half of the metered cap (F-118-ap, `entitlement/contract.limits.md`):
 * a tenant's default and one user's own number, read and set.
 *
 * **The tenant is the path's**, admitted by the users-admin door
 * (`ResellerAccess.runIncludingPlatform`): the platform's staff on any tenant
 * and on the platform's own, a reseller's owner and its staff on theirs. Reads
 * pass `read`, so a suspended reseller still sees its numbers; writes pass
 * `staffWrite`, so it changes none. Every write is audited in its transaction,
 * and a write that changes nothing writes no audit row.
 */
@Injectable()
export class GrantLimitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  tenantLimit(actor: ResellerActor, tenantId: string): Promise<TenantGrantLimit> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, (tx) => this.tenantView(tx)));
  }

  /** `null` goes back to the platform's default. */
  setTenantLimit(actor: AdminActor, tenantId: string, cap: number | null): Promise<TenantGrantLimit> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const scoped = TenantContext.current('grant limits').id;
        await aboveNoCeiling(tx, cap);
        const before = await tx.grantLimitSetting.findUnique({ where: { tenantId: scoped }, select: { meteredOpenCap: true } });
        const was = before?.meteredOpenCap ?? null;
        if (was !== cap) {
          if (cap === null) await tx.grantLimitSetting.deleteMany({ where: { tenantId: scoped } });
          else {
            await tx.grantLimitSetting.upsert({
              where: { tenantId: scoped },
              create: { tenantId: scoped, meteredOpenCap: cap, updatedByUserId: actor.userId },
              update: { meteredOpenCap: cap, updatedByUserId: actor.userId },
            });
          }
          await auditLimit(tx, actor, scoped, 'grant_limit_tenant_set', { type: 'tenant', id: scoped }, was, cap, null);
        }
        return this.tenantView(tx);
      }),
    );
  }

  userLimit(actor: ResellerActor, tenantId: string, userId: string): Promise<UserGrantLimitView> {
    return this.onUser(actor, tenantId, userId, 'read', (tx) => this.userView(tx, userId));
  }

  /** The answer to a ticket: replaces the tenant's default for this user, higher or lower. */
  setUserLimit(actor: AdminActor, tenantId: string, userId: string, cap: number, reason: string): Promise<UserGrantLimitView> {
    return this.onUser(actor, tenantId, userId, 'staffWrite', async (tx) => {
      const scoped = TenantContext.current('grant limits').id;
      await aboveNoCeiling(tx, cap);
      const where = { tenantId_userId: { tenantId: scoped, userId } };
      const before = await tx.userGrantLimit.findUnique({ where, select: { meteredOpenCap: true, reason: true } });
      if (before?.meteredOpenCap !== cap || before?.reason !== reason) {
        await tx.userGrantLimit.upsert({
          where,
          create: { tenantId: scoped, userId, meteredOpenCap: cap, reason, setByUserId: actor.userId },
          update: { meteredOpenCap: cap, reason, setByUserId: actor.userId },
        });
        await auditLimit(tx, actor, scoped, 'grant_limit_user_set', { type: 'user', id: userId }, before?.meteredOpenCap ?? null, cap, reason);
      }
      return this.userView(tx, userId);
    });
  }

  /** Back to the tenant's default. Nothing to remove is an answer, not a refusal. */
  removeUserLimit(actor: AdminActor, tenantId: string, userId: string): Promise<UserGrantLimitView> {
    return this.onUser(actor, tenantId, userId, 'staffWrite', async (tx) => {
      const scoped = TenantContext.current('grant limits').id;
      const before = await tx.userGrantLimit.findUnique({ where: { tenantId_userId: { tenantId: scoped, userId } }, select: { meteredOpenCap: true } });
      if (before) {
        await tx.userGrantLimit.deleteMany({ where: { tenantId: scoped, userId } });
        await auditLimit(tx, actor, scoped, 'grant_limit_user_remove', { type: 'user', id: userId }, before.meteredOpenCap, null, null);
      }
      return this.userView(tx, userId);
    });
  }

  private async tenantView(tx: Prisma.TransactionClient): Promise<TenantGrantLimit> {
    const tenantId = TenantContext.current('grant limits').id;
    const row = await tx.grantLimitSetting.findUnique({ where: { tenantId }, select: { meteredOpenCap: true } });
    const tenantDefault = row?.meteredOpenCap ?? null;
    const ceiling = await meteredCeilingOf(tx);
    return { platformDefault: PLATFORM_METERED_CAP, tenantDefault, effective: underCeiling(tenantDefault ?? PLATFORM_METERED_CAP, ceiling), ceiling };
  }

  private async userView(tx: Prisma.TransactionClient, userId: string): Promise<UserGrantLimitView> {
    const tenantId = TenantContext.current('grant limits').id;
    const own = await tx.userGrantLimit.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { meteredOpenCap: true, reason: true, setByUserId: true, updatedAt: true },
    });
    const { tenantDefault, platformDefault, ceiling } = await this.tenantView(tx);
    const open = await tx.grant.count({
      where: { userId, billingMode: VariantBillingMode.metered, status: { in: [...OPEN_GRANT_STATUSES] } },
    });
    return {
      userId,
      own: own && { meteredOpenCap: own.meteredOpenCap, reason: own.reason, setByUserId: own.setByUserId, updatedAt: own.updatedAt.toISOString() },
      tenantDefault,
      platformDefault,
      effective: await meteredCapOf(tx, userId),
      ceiling,
      open,
    };
  }

  /** The door, then the user fence in the tenant's scope, then `work` — one transaction. */
  private onUser<T>(
    actor: ResellerActor,
    tenantId: string,
    userId: string,
    capability: 'read' | 'staffWrite',
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.admitted(actor, tenantId, capability, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const user = await tx.user.findFirst({ where: { id: userId }, select: { id: true } });
        if (!user) throw new ResellerUserGrantsRefused('user_not_found', userId);
        return work(tx);
      }),
    );
  }

  private async admitted<T>(actor: ResellerActor, tenantId: string, capability: 'read' | 'staffWrite', work: () => Promise<T>): Promise<T> {
    try {
      return await this.access.runIncludingPlatform(actor, tenantId, capability, work);
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerUserGrantsRefused(e.reason, tenantId);
      throw e;
    }
  }
}

/**
 * A number above the reseller's ceiling is refused, whoever asks (F-019-n):
 * the ceiling bounds the number in effect anyway, so one stored above it
 * would read as something it is not. The platform's staff raise the ceiling
 * itself (`/api/tenants/limits/…`) — one row. `null` (back to a default) is
 * never above it.
 */
async function aboveNoCeiling(tx: Prisma.TransactionClient, cap: number | null): Promise<void> {
  if (cap === null) return;
  const ceiling = await meteredCeilingOf(tx);
  if (ceiling !== null && cap > ceiling) throw new ResellerLimitReached('user_metered_cap_max', ceiling, cap);
}
