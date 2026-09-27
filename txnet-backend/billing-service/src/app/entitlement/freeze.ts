import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigStatus, DesiredRemote, EnforcementState, GrantStatus, Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementRefused } from './grant';
import { ADMIN_FROZEN } from './suspension';

export { ADMIN_FROZEN };

export type Freeze = { frozenUntil: Date | null; configsDisabled: number };
export type Unfreeze = { endsAt: Date | null; configsRestored: number };

/**
 * An admin freezes an `active` Grant (F-311-h), in the caller's transaction:
 * `suspended` with `statusReason = admin_frozen`, `suspendedAt = at` — the
 * instant the clock stopped — and every config `desiredEnabled = false`, the
 * same desired state an exhaustion writes (`suspension.ts`).
 *
 * **Kept, never purged** (user, 2026-09-27): the purge scan and its day-ahead
 * notice skip `admin_frozen`, so the panel keeps each client, turned off, and
 * an unfreeze turns on the very lines the user holds.
 *
 * `until`, when given, is when the hourly sweep unfreezes it by itself
 * (`GrantUnfreezeService`); without it the Grant waits for the admin.
 * A Grant already stopped for quota is `grant_not_active`: the top-up that
 * would revive it must not find it frozen instead.
 */
export async function freezeGrant(tx: Prisma.TransactionClient, grantId: string, input: { at: Date; until?: Date | null }): Promise<Freeze> {
  const { at } = input;
  const until = input.until ?? null;
  if (until && until.getTime() <= at.getTime()) throw new EntitlementRefused('freeze_until_not_future');

  const grant = await tx.grant.findFirst({ where: { id: grantId }, select: { status: true } });
  if (!grant) throw new EntitlementRefused('grant_not_found');
  if (grant.status !== GrantStatus.active) throw new EntitlementRefused('grant_not_active', grant.status);

  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.active },
    data: { status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: at, frozenUntil: until },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_not_active');

  const disabled = await tx.config.updateMany({
    where: { grantId, desiredEnabled: true },
    data: { desiredEnabled: false },
  });
  return { frozenUntil: until, configsDisabled: disabled.count };
}

/**
 * Unfreezes a frozen Grant (F-311-h), in the caller's transaction. **The clock
 * stopped** (user, 2026-09-26): `endsAt` moves forward by the frozen span,
 * `at - suspendedAt`; a permanent Grant stays permanent. The moved end is what
 * the lease planner reopens a standing close on (network `contract.lease.md`
 * rule 25), and what the time-threshold clock starts over from (invariant 19).
 *
 * Configs come back as `reviveOnTopUp` brings them (`purge.ts`): every `active`
 * one enabled and `present`; a retired one stays gone and one an admin
 * disabled waits for its admin.
 *
 * The write is conditional on the reason and on the clock and end it read, so
 * a renewal that moved the end in between is `grant_moved` — retry — and never
 * an end shifted twice.
 */
export async function unfreezeGrant(tx: Prisma.TransactionClient, grantId: string, at: Date): Promise<Unfreeze> {
  const grant = await tx.grant.findFirst({
    where: { id: grantId },
    select: { status: true, statusReason: true, suspendedAt: true, endsAt: true },
  });
  if (!grant) throw new EntitlementRefused('grant_not_found');
  if (grant.status !== GrantStatus.suspended || grant.statusReason !== ADMIN_FROZEN || !grant.suspendedAt) {
    throw new EntitlementRefused('grant_not_frozen', grant.status);
  }

  const frozenMs = Math.max(0, at.getTime() - grant.suspendedAt.getTime());
  const endsAt = grant.endsAt ? new Date(grant.endsAt.getTime() + frozenMs) : null;

  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: grant.suspendedAt, endsAt: grant.endsAt },
    data: { status: GrantStatus.active, statusReason: null, suspendedAt: null, frozenUntil: null, endsAt },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved');

  const restored = await tx.config.updateMany({
    where: { grantId, status: ConfigStatus.active },
    data: { desiredEnabled: true, desiredRemote: DesiredRemote.present, enforcementState: EnforcementState.pending },
  });
  return { endsAt, configsRestored: restored.count };
}

export type UnfreezeDueResult = { scanned: number; unfrozen: number };

/**
 * A timed freeze ends by itself (F-311-h, user 2026-09-27): every frozen Grant
 * whose `frozenUntil` has come is unfrozen at `now` — the span it really stood
 * still, so an hourly tick costs the user nothing. Asked by the purge tick
 * (`purge-due`), before the purge. The scan is cross-tenant and each unfreeze
 * runs in its own tenant (`purge.ts` gives the argument); one an admin
 * unfroze or renewed in between is skipped, and the next tick finds it again
 * only if it is still frozen and due.
 */
@Injectable()
export class GrantUnfreezeService {
  private readonly logger = new Logger(GrantUnfreezeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async unfreezeDue(now: Date = new Date()): Promise<UnfreezeDueResult> {
    const take = this.config.get('GRANT_PURGE_BATCH_SIZE', { infer: true });

    const due = await this.crossTenant.$queryRaw<Array<{ id: string; tenantId: string }>>`
      SELECT g."id", g."tenantId"
        FROM "entitlement"."grant" g
       WHERE g."status" = ${GrantStatus.suspended}::"entitlement"."GrantStatus"
         AND g."statusReason" = ${ADMIN_FROZEN}
         AND g."frozenUntil" <= ${now}
       ORDER BY g."frozenUntil" ASC
       LIMIT ${take}`;

    let unfrozen = 0;
    for (const grant of due) {
      try {
        await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => unfreezeGrant(tx, grant.id, now)));
        unfrozen += 1;
      } catch (e) {
        if (!(e instanceof EntitlementRefused)) throw e;
      }
    }
    if (unfrozen > 0) this.logger.log(`unfroze ${unfrozen} of ${due.length} Grant(s) whose freeze ran out`);
    return { scanned: due.length, unfrozen };
  }
}
