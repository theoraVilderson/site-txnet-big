import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigStatus, DesiredRemote, EnforcementState, FreezeMode, GrantStatus, Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { releaseVpnReserveOf, topVpnReserve } from '../traffic/vpn-reserve';
import { EntitlementRefused } from './grant';
import { ADMIN_FROZEN } from './suspension';

export { ADMIN_FROZEN };

export type Freeze = { frozenUntil: Date | null; configsDisabled: number };
export type Unfreeze = { endsAt: Date | null; configsRestored: number };

/** Hard beats soft beats self (F-0401-a): a freeze replaces one in place only by beating it. */
const FREEZE_MODE_RANK: Record<FreezeMode, number> = { [FreezeMode.self]: 1, [FreezeMode.soft]: 2, [FreezeMode.hard]: 3 };

/** The freezes a user lifts themselves (F-0401-a): an admin's soft one, and their own. */
const USER_LIFTED: readonly FreezeMode[] = [FreezeMode.soft, FreezeMode.self];

/** Whether a freeze of `mode` overrides one of `held` (F-0401-a). */
export function freezeModeBeats(mode: FreezeMode, held: FreezeMode): boolean {
  return FREEZE_MODE_RANK[mode] > FREEZE_MODE_RANK[held];
}

/** Whether the user may lift this freeze (F-0401-a): soft or self, never one an evict left waiting for a panel. */
export function userMayUnfreeze(grant: { freezeMode: FreezeMode | null; awaitingPanel: boolean }): boolean {
  return !grant.awaitingPanel && grant.freezeMode !== null && USER_LIFTED.includes(grant.freezeMode);
}

export type FreezeInput = {
  at: Date;
  until?: Date | null;
  /** Who may lift it (F-0401-a); an admin's freeze without one is `hard`. */
  mode?: FreezeMode;
  /** Whether the clock stops, fixed on the Grant now; default yes, as every admin freeze. */
  stopsClock?: boolean;
};

/**
 * Freezes an `active` Grant (F-311-h), in the caller's transaction:
 * `suspended` with `statusReason = admin_frozen`, `suspendedAt = at` — the
 * instant the clock stopped — and every config `desiredEnabled = false`, the
 * same desired state an exhaustion writes (`suspension.ts`). The mode and
 * whether the clock stops are fixed on the Grant here (F-0401-a), so a later
 * change of the tenant's setting never moves a frozen Grant.
 *
 * **Kept, never purged** (user, 2026-09-27): the purge scan and its day-ahead
 * notice skip `admin_frozen`, so the panel keeps each client, turned off, and
 * an unfreeze turns on the very lines the user holds.
 *
 * `until`, when given, is when the hourly sweep unfreezes it by itself
 * (`GrantUnfreezeService`); without it the Grant waits for its lifter.
 * A frozen Grant takes a freeze that beats its mode in place (`raiseFreeze`);
 * any other stopped Grant is `grant_not_active` — one stopped for quota is
 * the top-up's to revive, and must not find it frozen instead.
 */
export async function freezeGrant(tx: Prisma.TransactionClient, grantId: string, input: FreezeInput): Promise<Freeze> {
  const { at } = input;
  const until = input.until ?? null;
  const mode = input.mode ?? FreezeMode.hard;
  if (until && until.getTime() <= at.getTime()) throw new EntitlementRefused('freeze_until_not_future');

  const grant = await tx.grant.findFirst({ where: { id: grantId }, select: { status: true, statusReason: true, freezeMode: true } });
  if (!grant) throw new EntitlementRefused('grant_not_found');
  if (isFrozen(grant) && grant.freezeMode && freezeModeBeats(mode, grant.freezeMode)) return raiseFreeze(tx, grantId, { held: grant.freezeMode, mode, until });
  if (grant.status !== GrantStatus.active) throw new EntitlementRefused('grant_not_active', grant.status);

  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.active },
    data: {
      status: GrantStatus.suspended,
      statusReason: ADMIN_FROZEN,
      suspendedAt: at,
      frozenUntil: until,
      freezeMode: mode,
      freezeStopsClock: input.stopsClock ?? true,
    },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_not_active');
  // A frozen Grant is not planned: its reserve is free until the unfreeze (F-118-b).
  await releaseVpnReserveOf(tx, grantId);

  const disabled = await tx.config.updateMany({
    where: { grantId, desiredEnabled: true },
    data: { desiredEnabled: false },
  });
  return { frozenUntil: until, configsDisabled: disabled.count };
}

/**
 * A stronger freeze over a weaker one (F-0401-a): only the mode and the timed
 * end change. The clock keeps what it was fixed to at the first freeze and the
 * configs are already off. Conditional on the mode read, so two raises at once
 * land one and the other is `grant_moved`.
 */
async function raiseFreeze(
  tx: Prisma.TransactionClient,
  grantId: string,
  raise: { held: FreezeMode; mode: FreezeMode; until: Date | null },
): Promise<Freeze> {
  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, freezeMode: raise.held },
    data: { freezeMode: raise.mode, frozenUntil: raise.until },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved');
  return { frozenUntil: raise.until, configsDisabled: 0 };
}

function isFrozen(grant: { status: GrantStatus; statusReason: string | null }): boolean {
  return grant.status === GrantStatus.suspended && grant.statusReason === ADMIN_FROZEN;
}

type FrozenRead = {
  status: GrantStatus;
  statusReason: string | null;
  suspendedAt: Date | null;
  endsAt: Date | null;
  freezeMode: FreezeMode | null;
  freezeStopsClock: boolean | null;
  awaitingPanel: boolean;
};

/**
 * An admin's unfreeze (F-311-h): lifts any freeze — hard, soft, self, or one
 * an evict left waiting for a panel. See `lift`.
 */
export function unfreezeGrant(tx: Prisma.TransactionClient, grantId: string, at: Date): Promise<Unfreeze> {
  return lift(tx, grantId, at, () => ({}));
}

/**
 * The user's own unfreeze (F-0401-a): only a soft or self freeze, never a hard
 * or a system one (`freeze_not_users`). The write is conditional on the mode
 * read and on no evict, so an admin who hardened it in between wins.
 * codeshape: spec-only — its caller is the user's route, F-0401-c; drop this line there.
 */
export function unfreezeOwnGrant(tx: Prisma.TransactionClient, grantId: string, at: Date): Promise<Unfreeze> {
  return lift(tx, grantId, at, (grant) => {
    if (!userMayUnfreeze(grant)) throw new EntitlementRefused('freeze_not_users', grant.freezeMode ?? undefined);
    return { freezeMode: grant.freezeMode, awaitingPanel: false };
  });
}

/**
 * Unfreezes a frozen Grant, in the caller's transaction. **A stopped clock
 * gives the time back** (user, 2026-09-26): `endsAt` moves forward by the
 * frozen span, `at - suspendedAt`, only when the freeze stopped the clock
 * (F-0401-a); a permanent Grant stays permanent. The moved end is what the
 * lease planner reopens a standing close on (network `contract.lease.md`
 * rule 25), and what the time-threshold clock starts over from (invariant 19).
 *
 * Configs come back as `reviveOnTopUp` brings them (`purge.ts`): every `active`
 * one enabled and `present`; a retired one stays gone and one an admin
 * disabled waits for its admin.
 *
 * The write is conditional on the reason, on the clock and end it read and on
 * the lifter's `fence`, so a renewal that moved the end in between is
 * `grant_moved` — retry — and never an end shifted twice.
 */
async function lift(
  tx: Prisma.TransactionClient,
  grantId: string,
  at: Date,
  fence: (grant: FrozenRead) => Prisma.GrantWhereInput,
): Promise<Unfreeze> {
  const grant = await tx.grant.findFirst({
    where: { id: grantId },
    select: { status: true, statusReason: true, suspendedAt: true, endsAt: true, freezeMode: true, freezeStopsClock: true, awaitingPanel: true },
  });
  if (!grant) throw new EntitlementRefused('grant_not_found');
  if (!isFrozen(grant) || !grant.suspendedAt) throw new EntitlementRefused('grant_not_frozen', grant.status);
  const fenced = fence(grant);

  // A freeze from before F-0401-a with no value read stopped the clock, as every admin freeze did.
  const frozenMs = grant.freezeStopsClock === false ? 0 : Math.max(0, at.getTime() - grant.suspendedAt.getTime());
  const endsAt = grant.endsAt ? new Date(grant.endsAt.getTime() + frozenMs) : null;

  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: grant.suspendedAt, endsAt: grant.endsAt, ...fenced },
    data: { status: GrantStatus.active, statusReason: null, suspendedAt: null, frozenUntil: null, freezeMode: null, freezeStopsClock: null, endsAt },
  });
  if (moved.count === 0) throw new EntitlementRefused('grant_moved');

  const restored = await tx.config.updateMany({
    where: { grantId, status: ConfigStatus.active },
    data: { desiredEnabled: true, desiredRemote: DesiredRemote.present, enforcementState: EnforcementState.pending },
  });
  // The reserve the freeze gave back, held again with the unfreeze (F-118-b).
  await topVpnReserve(tx, grantId);
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
