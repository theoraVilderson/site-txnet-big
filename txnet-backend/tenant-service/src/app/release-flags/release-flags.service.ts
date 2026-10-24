import { Inject, Injectable } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, ReleaseFlagStage } from '@prisma/client';
import { RELEASE_FLAGS, ReleaseFlags, isPlatformTenant, releaseFlagIsOn } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { RedisService } from '../redis/redis.service';

/** The flag keys this service answers for: shared-core's {@link RELEASE_FLAGS}; a spec provides its own. */
export const RELEASE_FLAG_KEYS = Symbol('RELEASE_FLAG_KEYS');
export const releaseFlagKeysProvider = { provide: RELEASE_FLAG_KEYS, useValue: RELEASE_FLAGS };

export type ReleaseFlagsActor = { adminId: string; tenantId: string; ip: string };

export type ReleaseFlagView = {
  key: string;
  stage: ReleaseFlagStage;
  exceptions: { tenantId: string; isOn: boolean }[];
};

export type ReleaseFlagsRejection = 'not_platform_owner' | 'unknown_flag' | 'reseller_not_found';

export class ReleaseFlagsRefused extends Error {
  constructor(
    readonly reason: ReleaseFlagsRejection,
    readonly detail = '',
  ) {
    super(`release flags refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ReleaseFlagsRefused';
  }
}

/** What an audit row says an exception held: on, off, or `'unset'` (no row). */
type Held = boolean | 'unset';

/**
 * Release flags (OPS-1-ag, ADR-0164 point 4, `tenant/contract.release-flags.md`):
 * the platform owner's table of every flag, its stage and each reseller's
 * exception, and the writes that switch them; and any tenant's own answers.
 *
 * Every write is audited in its transaction and drops the flag's cached state
 * there and again after the commit ({@link ReleaseFlags.forget}), so every
 * service sees the switch on its next request — no deploy, no wait.
 */
@Injectable()
export class ReleaseFlagsService {
  private readonly flags: ReleaseFlags;

  constructor(
    private readonly all: CrossTenantPrismaService,
    redis: RedisService,
    @Inject(RELEASE_FLAG_KEYS) private readonly keys: readonly string[],
  ) {
    this.flags = new ReleaseFlags(all, redis);
  }

  async table(actor: ReleaseFlagsActor): Promise<ReleaseFlagView[]> {
    await this.access(actor);
    const [flags, exceptions] = await Promise.all([
      this.all.releaseFlag.findMany({ where: { key: { in: [...this.keys] } }, select: { key: true, stage: true } }),
      this.all.releaseFlagException.findMany({
        where: { key: { in: [...this.keys] } },
        select: { key: true, tenantId: true, isOn: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return this.keys.map((key) => ({
      key,
      stage: flags.find((f) => f.key === key)?.stage ?? ReleaseFlagStage.off,
      exceptions: exceptions.filter((e) => e.key === key).map(({ tenantId, isOn }) => ({ tenantId, isOn })),
    }));
  }

  async setStage(actor: ReleaseFlagsActor, key: string, stage: ReleaseFlagStage): Promise<void> {
    const k = await this.writable(actor, key);
    await this.switching(k, async (tx) => {
      const before = await tx.releaseFlag.findUnique({ where: { key: k }, select: { stage: true } });
      await tx.releaseFlag.upsert({
        where: { key: k },
        create: { key: k, stage, updatedByUserId: actor.adminId },
        update: { stage, updatedByUserId: actor.adminId },
      });
      await tx.adminAuditLog.create({
        data: audit(actor, AdminAction.release_flag_stage_set, { type: AuditTargetType.config, id: actor.tenantId },
          { key: k, stage: before?.stage ?? ReleaseFlagStage.off }, { key: k, stage }),
      });
    });
  }

  async setException(actor: ReleaseFlagsActor, key: string, tenantId: string, isOn: boolean): Promise<void> {
    const k = await this.writable(actor, key);
    await this.reseller(tenantId);
    await this.switching(k, async (tx) => {
      const before = await tx.releaseFlagException.findUnique({ where: { tenantId_key: { tenantId, key: k } }, select: { isOn: true } });
      await tx.releaseFlagException.upsert({
        where: { tenantId_key: { tenantId, key: k } },
        create: { tenantId, key: k, isOn, setByUserId: actor.adminId },
        update: { isOn, setByUserId: actor.adminId },
      });
      await tx.adminAuditLog.create({ data: exceptionAudit(actor, AdminAction.release_flag_exception_set, tenantId, k, before?.isOn ?? 'unset', isOn) });
    });
  }

  async clearException(actor: ReleaseFlagsActor, key: string, tenantId: string): Promise<void> {
    const k = await this.writable(actor, key);
    await this.switching(k, async (tx) => {
      const before = await tx.releaseFlagException.findUnique({ where: { tenantId_key: { tenantId, key: k } }, select: { isOn: true } });
      if (!before) return;
      await tx.releaseFlagException.delete({ where: { tenantId_key: { tenantId, key: k } } });
      await tx.adminAuditLog.create({ data: exceptionAudit(actor, AdminAction.release_flag_exception_clear, tenantId, k, before.isOn, 'unset') });
    });
  }

  /** Every flag's answer for one tenant — the caller's own, for the panel to show or hide what a flag covers. */
  async answersFor(tenantId: string): Promise<Record<string, boolean>> {
    const states = await Promise.all(this.keys.map((key) => this.flags.state(key)));
    return Object.fromEntries(this.keys.map((key, i) => [key, releaseFlagIsOn(states[i], tenantId)]));
  }

  /** A write and the cache it invalidates: inside the transaction (no Redis, no switch) and after the commit. */
  private async switching(key: string, write: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    await this.all.$transaction(async (tx) => {
      await write(tx);
      await this.flags.forget(key);
    });
    await this.flags.forget(key);
  }

  private async writable(actor: ReleaseFlagsActor, key: string): Promise<string> {
    await this.access(actor);
    if (!this.keys.includes(key)) throw new ReleaseFlagsRefused('unknown_flag', key);
    return key;
  }

  /** An exception is a reseller's: the platform's own tenant answers by the stage. */
  private async reseller(tenantId: string): Promise<void> {
    const tenant = await this.all.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true, deletedAt: true } });
    if (!tenant || tenant.deletedAt || isPlatformTenant(tenant.tenantType)) throw new ReleaseFlagsRefused('reseller_not_found', tenantId);
  }

  private async access(actor: ReleaseFlagsActor): Promise<void> {
    const tenant = await this.all.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (!isPlatformTenant(tenant?.tenantType)) throw new ReleaseFlagsRefused('not_platform_owner', 'release flags');
  }
}

function audit(
  actor: ReleaseFlagsActor,
  action: AdminAction,
  target: { type: AuditTargetType; id: string },
  before: Prisma.InputJsonObject,
  after: Prisma.InputJsonObject,
): Prisma.AdminAuditLogUncheckedCreateInput {
  return {
    tenantId: actor.tenantId,
    adminId: actor.adminId,
    action,
    targetEntityType: target.type,
    targetEntityId: target.id,
    oldValue: before,
    newValue: after,
    adminIpAddress: actor.ip,
  };
}

function exceptionAudit(actor: ReleaseFlagsActor, action: AdminAction, tenantId: string, key: string, before: Held, after: Held) {
  return audit(actor, action, { type: AuditTargetType.tenant, id: tenantId }, { key, isOn: before }, { key, isOn: after });
}
