import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DesiredRemote, EnforcementState, GrantStatus, Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { RemainderCreditRefused, RemainderCreditService } from '../traffic/remainder-credit';
import { UsageSettlementService } from '../usage/usage-settlement';
import { ADMIN_FROZEN } from './suspension';

/**
 * `grant.statusReason` for a Grant the close stage ended (F-118-x): suspended
 * past its purge and its close window. `expired` is terminal
 * (`grant_status_one_way`), so a renewal or a top-up after this reaches
 * nothing — the user buys a new Grant, with the remainder already in the wallet.
 */
export const CLOSED_AFTER_PURGE = 'closed_after_purge';

/** What one sweep did. */
export type CloseResult = {
  /** Grants the cross-tenant scan found due, at most one batch. */
  scanned: number;
  /** Due Grants this sweep expired and settled. Below `scanned` where one was revived meanwhile. */
  closed: number;
  /** Due Grants whose close rolled back (a block bought meanwhile, or an error); the next tick asks again. */
  failed: number;
};

type DueGrant = { id: string; tenantId: string; statusReason: string | null; suspendedAt: Date };

/** The remainder refusals that are not "nothing to give back": the close cannot stand on them. */
const FATAL: readonly RemainderCreditRefused['reason'][] = ['cursor_moved', 'grant_not_found', 'grant_not_closed', 'grant_not_prepaid'];

/**
 * The third stage after ADR-0075's suspension and purge (F-118-x, D-59 (b)).
 * The purge freed the panel seat but kept the Grant revivable; its money —
 * the VPN remainder, every other meter's balance or hold, a reseller's
 * wholesale bytes — stays tied up until something closes it. This closes it,
 * the admin delete's settle (F-118-u) with `refund` always true: the user did
 * nothing wrong, their service simply ran out and was not renewed.
 *
 * **Its window is its own setting** (`closeAfterDays`, grant override else
 * tenant, default 30), counted from the purge, because a renewal or top-up
 * still revives a purged Grant (ADR-0075) and this is where that ends. Either
 * window at `0` means never: a tenant that keeps dead clients keeps the Grant.
 * A frozen Grant is never closed, as it is never purged.
 */
@Injectable()
export class GrantCloseStageService {
  private readonly logger = new Logger(GrantCloseStageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly remainders: RemainderCreditService,
    private readonly meters: UsageSettlementService,
  ) {}

  /**
   * Close every suspended Grant past its purge and close windows, one batch.
   * Due-ness is resolved in the scan (`purge.ts` says why a never row must not
   * reach a bounded batch), and a closed Grant is `expired`, so the scan drains
   * itself. One transaction per Grant: each one moves money, and one Grant's
   * rollback must not undo another's close.
   */
  async closeDue(now: Date = new Date()): Promise<CloseResult> {
    const take = this.config.get('GRANT_PURGE_BATCH_SIZE', { infer: true });

    const due = await this.crossTenant.$queryRaw<DueGrant[]>`
      SELECT g."id", g."tenantId", g."statusReason", g."suspendedAt"
        FROM "entitlement"."grant" g
        JOIN "tenant"."tenant" t ON t."id" = g."tenantId"
       WHERE g."status" = ${GrantStatus.suspended}::"entitlement"."GrantStatus"
         AND g."suspendedAt" IS NOT NULL
         AND g."statusReason" IS DISTINCT FROM ${ADMIN_FROZEN}
         AND COALESCE(g."purgeAfterDays", t."purgeAfterDays") > 0
         AND COALESCE(g."closeAfterDays", t."closeAfterDays") > 0
         AND g."suspendedAt" + make_interval(days => COALESCE(g."purgeAfterDays", t."purgeAfterDays") + COALESCE(g."closeAfterDays", t."closeAfterDays")) <= ${now}
       ORDER BY g."suspendedAt" ASC
       LIMIT ${take}`;

    let closed = 0;
    let failed = 0;
    for (const grant of due) {
      try {
        const done = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.closeOne(tx, grant, now)));
        if (done) closed++;
      } catch (e) {
        failed++;
        this.logger.warn(`close of Grant ${grant.id} rolled back: ${(e as Error).message}`);
      }
    }
    if (due.length > 0) this.logger.log(`closed ${closed} of ${due.length} suspended Grant(s) past their close window (${failed} rolled back)`);
    return { scanned: due.length, closed, failed };
  }

  private async closeOne(tx: Prisma.TransactionClient, grant: DueGrant, at: Date): Promise<boolean> {
    // Guarded on what the scan read: a renewal or top-up since then wins.
    const moved = await tx.grant.updateMany({
      where: { id: grant.id, status: GrantStatus.suspended, statusReason: grant.statusReason, suspendedAt: grant.suspendedAt },
      data: { status: GrantStatus.expired, statusReason: CLOSED_AFTER_PURGE },
    });
    if (moved.count === 0) return false;

    // Normally purged already; a Grant whose purge had not run yet is released here, as the delete does.
    await tx.config.updateMany({
      where: { grantId: grant.id, desiredRemote: DesiredRemote.present },
      data: { desiredRemote: DesiredRemote.absent, desiredEnabled: false, enforcementState: EnforcementState.pending },
    });

    try {
      await this.remainders.settle(tx, { grantId: grant.id, at, stoppedAt: null });
    } catch (e) {
      if (!(e instanceof RemainderCreditRefused) || FATAL.includes(e.reason)) throw e;
    }
    await this.meters.settleAtClose(tx, { grantId: grant.id, refund: true });
    await this.remainders.wholesaleAtClose(tx, grant.id);
    return true;
  }
}
