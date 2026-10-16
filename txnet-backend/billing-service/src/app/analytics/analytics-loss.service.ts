import { Injectable, Logger } from '@nestjs/common';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { tellLosses } from './analytics-loss';

/** What one daily run did: tenants judged, users newly told about, tenants whose pass failed. */
export type LossAlertResult = { tenants: number; told: number; failed: number };

/**
 * The daily run of F-1003 (`analytics-loss.ts`): every live tenant with a
 * finished rollup, each in its own scope and transaction, so one tenant's
 * failure is logged and counted and never stops the rest. The worker owns
 * *when* (`analytics-loss-alert.job.ts`); a run twice in a month tells no one
 * twice — the claim does that, not the clock.
 */
@Injectable()
export class AnalyticsLossService {
  private readonly logger = new Logger(AnalyticsLossService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** Which tenants have a rollup — the one cross-tenant read; every pass is scoped. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  async run(now = new Date()): Promise<LossAlertResult> {
    const tenants = await this.all.$queryRaw<{ id: string }[]>`
      SELECT s."tenantId"::text AS "id" FROM billing.analytics_rollup_state s
      JOIN tenant.tenant t ON t."id" = s."tenantId" AND t."deletedAt" IS NULL
      WHERE s."rebuildingSince" IS NULL
      ORDER BY 1`;
    const result: LossAlertResult = { tenants: tenants.length, told: 0, failed: 0 };
    for (const { id } of tenants) {
      try {
        result.told += await runWithTenant({ id }, () => tenantTransaction(this.prisma, (tx) => tellLosses(tx, id, now)));
      } catch (e) {
        result.failed++;
        this.logger.error(`loss alert for tenant ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (result.told > 0) this.logger.log(`loss alert: ${result.told} user(s) told about across ${result.tenants} tenant(s)`);
    return result;
  }
}
