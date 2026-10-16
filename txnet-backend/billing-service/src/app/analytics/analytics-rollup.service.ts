import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OutboxEventType, isPlatformTenant, platformTenantIdOf, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { Day, addDays, dayBounds, dayOf } from './analytics-days';
import {
  RollupRange,
  clearFlows,
  firstActivity,
  lockTenantRollup,
  rollupFingerprint,
  writePayments,
  writeSales,
  writeStockToday,
  writeTraffic,
  writeUsers,
} from './analytics-rollup';

/**
 * Tenants one refresh tick passes over, oldest refresh first — so a platform
 * with more tenants than this drains round-robin and none is starved (C-28).
 */
export const TENANTS_PER_PASS = 200;

/** A whole rebuild reads a tenant's full history in one transaction; the default 5 s is a single day's budget. */
const REBUILD_TIMEOUT_MS = 120_000;

/** What one refresh tick did. */
export type AnalyticsRefreshResult = { tenants: number; changed: number; rebuilt: number };

/**
 * The analytics rollup worker (F-1001-a, billing/contract.analytics.md "The
 * worker"). `rollup` replaces every row of one tenant and day range in one
 * transaction — idempotent, so a redelivered tick (ADR-0027) changes nothing —
 * and writes `billing.analytics.refreshed` only when a row did change.
 * `refresh` is the 5-minute tick over today and yesterday; a tenant whose zone
 * changed since its days were cut is rebuilt whole instead (principle 5).
 */
/**
 * A changed pass, told to whoever has the page open: the tenant's own
 * `tenant:` channel (its seats, `/analytics`), and — for a reseller (never the
 * platform, which has an owner but no workspace) — that owner's `user:` and the platform's `tenant:` (F-1001-p): the
 * workspace twins are on the platform's panel, where the owner is a platform
 * user and staff are the platform's (RT-1-e's pair). Ids and days only.
 */
async function announce(tx: Prisma.TransactionClient, tenantId: string, from: Day, to: Day): Promise<void> {
  await tx.outboxEvent.create({ data: { aggregate: 'billing.analytics', aggregateId: tenantId, type: OutboxEventType.ANALYTICS_REFRESHED, payload: { tenantId, from, to } } });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { ownerUserId: true, tenantType: true } });
  // The platform has an owner too, but no workspace: its staff hear the first event.
  if (isPlatformTenant(tenant.tenantType) || !tenant.ownerUserId) return;
  const owner = tenant.ownerUserId;
  await tx.outboxEvent.create({
    data: {
      aggregate: 'billing.analytics',
      aggregateId: tenantId,
      type: OutboxEventType.ANALYTICS_RESELLER_REFRESHED,
      payload: { tenantId: await platformTenantIdOf(tx), userId: owner, resellerId: tenantId, from, to },
    },
  });
}

@Injectable()
export class AnalyticsRollupService {
  private readonly logger = new Logger(AnalyticsRollupService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** Which tenants exist and when each was last rolled — the one cross-tenant read; every write is scoped. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /** One tick: today and yesterday of each tenant due, or the whole history of one whose zone moved. */
  async refresh(now = new Date()): Promise<AnalyticsRefreshResult> {
    // Never-rolled tenants first, then the stalest: one bounded page per tick.
    const tenants = await this.all.$queryRaw<{ id: string; timezone: string; rolledIn: string | null; rebuilding: boolean }[]>`
      SELECT t."id", t."timezone", s."timeZone" AS "rolledIn", s."rebuildingSince" IS NOT NULL AS "rebuilding"
      FROM tenant.tenant t
      LEFT JOIN billing.analytics_rollup_state s ON s."tenantId" = t."id"
      ORDER BY s."refreshedAt" ASC NULLS FIRST, t."id"
      LIMIT ${TENANTS_PER_PASS}`;

    const result: AnalyticsRefreshResult = { tenants: tenants.length, changed: 0, rebuilt: 0 };
    for (const tenant of tenants) {
      // A rebuild that died mid-way left its flag up: it is run again, never trusted.
      if (tenant.rolledIn !== tenant.timezone || tenant.rebuilding) {
        result.rebuilt++;
        if (await this.rebuild(tenant.id, now)) result.changed++;
        continue;
      }
      const today = dayOf(now, tenant.timezone);
      if (await this.rollup(tenant.id, addDays(today, -1), today, now)) result.changed++;
    }
    if (result.changed > 0) this.logger.log(`analytics rollup: ${result.changed} of ${result.tenants} tenant(s) changed, ${result.rebuilt} rebuilt`);
    return result;
  }

  /**
   * Every day of one tenant, from its first ledger or payment row to today, in
   * its zone now. Reads say `rebuilding` from the moment it starts (the flag is
   * committed first) until it ends. Answers whether any row changed.
   */
  async rebuild(tenantId: string, now = new Date()): Promise<boolean> {
    return runWithTenant({ id: tenantId }, async () => {
      const { first, zone } = await tenantTransaction(this.prisma, async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
        await tx.analyticsRollupState.upsert({
          where: { tenantId },
          create: { tenantId, timeZone: tenant.timezone, rebuildingSince: now },
          update: { rebuildingSince: now },
        });
        return { first: await firstActivity(tx), zone: tenant.timezone };
      });
      const today = dayOf(now, zone);
      const from = first ? dayOf(first, zone) : today;
      return this.pass(tenantId, from < today ? from : today, today, now, { zone, rebuilt: true });
    });
  }

  /** Replace one tenant's rows for `fromDay`..`toDay` (its zone now); answers whether any row changed. */
  rollup(tenantId: string, fromDay: Day, toDay: Day, now = new Date()): Promise<boolean> {
    return runWithTenant({ id: tenantId }, () => this.pass(tenantId, fromDay, toDay, now, { rebuilt: false }));
  }

  private pass(tenantId: string, fromDay: Day, toDay: Day, now: Date, how: { zone?: string; rebuilt: boolean }): Promise<boolean> {
    return tenantTransaction(
      this.prisma,
      async (tx) => {
        await lockTenantRollup(tx);
        const zone = how.zone ?? (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } })).timezone;
        const range: RollupRange = { fromDay, toDay, zone, ...dayBounds(fromDay, toDay, zone) };
        const today = dayOf(now, zone);

        const before = await rollupFingerprint(tx, range);
        await clearFlows(tx, range);
        await writeSales(tx, range);
        await writeUsers(tx, range);
        await writePayments(tx, range);
        if (fromDay <= today && today <= toDay) await writeStockToday(tx, today);
        await writeTraffic(tx, range);
        const changed = (await rollupFingerprint(tx, range)) !== before;

        // The version is what a read cache is keyed by: a change bumps it, so
        // no answer cached before this commit is served after it.
        await tx.analyticsRollupState.upsert({
          where: { tenantId },
          create: { tenantId, timeZone: zone, version: 1, refreshedAt: now },
          update: {
            refreshedAt: now,
            ...(changed ? { version: { increment: 1 } } : {}),
            ...(how.rebuilt ? { timeZone: zone, rebuildingSince: null } : {}),
          },
        });
        if (changed) await announce(tx, tenantId, fromDay, toDay);
        return changed;
      },
      how.rebuilt ? { timeout: REBUILD_TIMEOUT_MS } : undefined,
    );
  }
}
