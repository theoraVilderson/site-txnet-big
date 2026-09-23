import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DesiredRemote, EnforcementState, GrantStatus, Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { QUOTA_EXHAUSTED } from './suspension';

/**
 * The second and third stages of ADR-0075 (F-027-y): the clock a suspension
 * started, and the top-up that undoes it.
 *
 * `suspendForExhaustion` (F-027-x) turns a spent Grant off — `desiredEnabled =
 * false` on every config — and writes `suspendedAt`. That frees nothing: the
 * client still occupies a seat and a licence on the customer's panel. After
 * `purgeAfterDays` the seat is released, and the way it is released is the
 * same one the disable used: **desired state, never a command.** The loop
 * compares what a config is supposed to be against what the panel reports, so
 * a top-up that lands while the panel is unreachable rebuilds the client
 * instead of racing a queued delete (ADR-0075, the 10:00/11:00/12:00 case).
 *
 * **Our rows are never deleted.** The purge writes `desiredRemote = absent`
 * and nothing else. `remoteId` is cleared by the convergence loop once the
 * panel confirms the delete (F-027-z) — that is what "the row stays, with
 * `remoteId` cleared" means, and it is why a rebuild is a button.
 */

/** What one sweep did. */
export type PurgeResult = {
  /** Grants the cross-tenant scan found due, at most one batch. */
  scanned: number;
  /** Due Grants this sweep wrote for. */
  grantsPurged: number;
  /** Configs whose desired state moved to `absent`. Below `grantsPurged` where the loop got there first. */
  configsPurged: number;
};

/** One due Grant, and the tenant its write has to run inside. */
type DueGrant = { id: string; tenantId: string };

@Injectable()
export class GrantPurgeService {
  private readonly logger = new Logger(GrantPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  /**
   * Release the panel seats of every suspended Grant whose clock has run out.
   *
   * **Due-ness is one SQL question, not a filter applied afterwards.** The
   * window is `coalesce(grant.purgeAfterDays, tenant.purgeAfterDays)`, read as
   * it is now rather than copied at suspension, and `0` means never. A Grant
   * that resolves to `0` has to be excluded by the scan itself: the batch is
   * bounded and ordered oldest-first, so a tenant with `purgeAfterDays = 0`
   * would otherwise fill every batch with rows that can never be purged and
   * starve the ones behind them for ever.
   *
   * The `EXISTS` clause is the same argument once more. Without it a Grant
   * already purged stays due for the rest of its life and occupies a slot in
   * every batch; with it the scan drains itself, and a second call inside the
   * same minute finds nothing — which is what makes the job **safe to run
   * twice**, as an at-least-once tick requires (ADR-0027).
   *
   * **The scan is cross-tenant and the writes are not**, for the reason
   * `deposit-expiry.service.ts` gives at length: which tenants have a due
   * Grant *is* the question, and on the application pool `entitlement."grant"`
   * shows a connection with no `app.tenant_id` zero rows.
   */
  async purgeDue(now: Date = new Date()): Promise<PurgeResult> {
    const take = this.config.get('GRANT_PURGE_BATCH_SIZE', { infer: true });

    const due = await this.crossTenant.$queryRaw<DueGrant[]>`
      SELECT g."id", g."tenantId"
        FROM "entitlement"."grant" g
        JOIN "tenant"."tenant" t ON t."id" = g."tenantId"
       WHERE g."status" = ${GrantStatus.suspended}::"entitlement"."GrantStatus"
         AND g."suspendedAt" IS NOT NULL
         AND COALESCE(g."purgeAfterDays", t."purgeAfterDays") > 0
         AND g."suspendedAt" + make_interval(days => COALESCE(g."purgeAfterDays", t."purgeAfterDays")) <= ${now}
         AND EXISTS (
               SELECT 1 FROM "network"."config" c
                WHERE c."grantId" = g."id"
                  AND c."desiredRemote" = ${DesiredRemote.present}::"network"."DesiredRemote")
       ORDER BY g."suspendedAt" ASC
       LIMIT ${take}`;

    if (due.length === 0) return { scanned: 0, grantsPurged: 0, configsPurged: 0 };

    const byTenant = new Map<string, string[]>();
    for (const grant of due) {
      const ids = byTenant.get(grant.tenantId);
      if (ids) ids.push(grant.id);
      else byTenant.set(grant.tenantId, [grant.id]);
    }

    let configsPurged = 0;
    for (const [tenantId, grantIds] of byTenant) {
      configsPurged += await runWithTenant({ id: tenantId }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          const purged = await tx.config.updateMany({
            where: { grantId: { in: grantIds }, desiredRemote: DesiredRemote.present },
            // `enforcementState` is a report of how far the loop got, and the
            // desired state it had got that far with has just changed. Leaving
            // it `complete` would describe work that has not started.
            data: { desiredRemote: DesiredRemote.absent, enforcementState: EnforcementState.pending },
          });
          return purged.count;
        }),
      );
    }

    this.logger.log(`purged ${configsPurged} config(s) of ${due.length} suspended Grant(s) past their window`);
    return { scanned: due.length, grantsPurged: due.length, configsPurged };
  }
}

/** What a revive did. `revived: false` means nothing was written. */
export type Revival = {
  revived: boolean;
  /** Configs put back to enabled and present. Zero unless `revived`. */
  configsRestored: number;
};

/**
 * Returns a Grant suspended for quota exhaustion to `active`, from **either**
 * stage — merely disabled, or already purged — in the caller's transaction.
 *
 * **Only this reason.** `suspended` carries two meanings (ADR-0075): out of
 * quota, and suspended by an admin or a tenant status change. A top-up buys
 * traffic, not an amnesty, so the guard is `statusReason = quota_exhausted`
 * and it sits in the write's own `where` rather than in a read before it —
 * which is also what makes a second call a no-op instead of a second revive.
 *
 * **`suspendedAt` is cleared with the status**, because it is the purge clock
 * and the Grant is no longer waiting on it. `grant_suspended_has_a_clock`
 * refuses the pair the other way round.
 *
 * **The configs go back to `present` as well as `enabled`.** A Grant purged
 * before the top-up has no remote client left, and the loop rebuilds it from
 * exactly this desired state — a fresh `uuid`, with the subscription link
 * following it automatically. `remoteId` is not written here for the same
 * reason the purge does not write it: it is the loop's record of what the
 * panel holds, and inventing one would make the next comparison lie.
 *
 * It does not decide that a top-up happened — that is money, and the caller
 * answers it. `suspendForExhaustion` is the mirror of this (`suspension.ts`).
 */
export async function reviveOnTopUp(tx: Prisma.TransactionClient, grantId: string): Promise<Revival> {
  const moved = await tx.grant.updateMany({
    where: { id: grantId, status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED },
    data: { status: GrantStatus.active, statusReason: null, suspendedAt: null },
  });
  if (moved.count === 0) return { revived: false, configsRestored: 0 };

  const restored = await tx.config.updateMany({
    where: { grantId },
    data: {
      desiredEnabled: true,
      desiredRemote: DesiredRemote.present,
      enforcementState: EnforcementState.pending,
    },
  });
  return { revived: true, configsRestored: restored.count };
}
