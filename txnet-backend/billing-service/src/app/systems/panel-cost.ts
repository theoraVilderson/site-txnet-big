import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { platformTenantIdOf, MONEY_PATTERN, finerThanCurrency } from '@txnet-backend/shared-core';

import { restateCostsFrom } from '../analytics/analytics-rollup-own-cost';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { calendarDaySchema as day } from '../request/calendar-day.schema';
import { PANEL_CURRENCY, costOn, dayOf, viewOf, type PanelCostView } from './panel-cost-on';
import { SystemsActor, panelScopeOf } from './panel-scope';
import { SystemsRefused } from './systems-read';

/**
 * `POST /api/billing/systems/panels/:id/cost` (F-1002-a): what the panel costs
 * a month, in USD, from `effectiveFrom` (a UTC day, default today). A decimal
 * string, never a float (C-02); `0` is a free panel, not an unset one.
 * `monthlyTrafficBytes` (F-1005-a): the month's traffic that price buys, whole
 * bytes as a string; left out = none set.
 */
export const panelCostSchema = z
  .object({
    monthlyCostUsd: z.string().regex(MONEY_PATTERN),
    monthlyTrafficBytes: z.string().regex(/^[1-9]\d{0,18}$/).optional(),
    effectiveFrom: day.optional(),
  })
  .strict();
export type PanelCostBody = z.infer<typeof panelCostSchema>;

/** The first day of `now`'s UTC month: the earliest a new price may take effect. */
const openMonthOf = (now: Date) => `${dayOf(now).slice(0, 8)}01`;

/**
 * A panel's monthly cost (F-1002-a, network `contract.md` "A panel's cost") —
 * what analytics spreads over a month's days (F-1002-b). **History, not a
 * setting**: a change adds a row and never edits one (a trigger refuses
 * an edit), and takes effect no earlier than the current UTC month, so a closed
 * month's margin never moves. Set by the panel's owner over the systems
 * surface — its door (`node.manage`) and scope (ADR-0080 decision 2); written
 * on the platform owner's pool, as every panel write is.
 */
@Injectable()
export class PanelCostService {
  private readonly logger = new Logger(PanelCostService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** The platform owner's pool, for the write only. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /** The price in effect today and every row, newest first. */
  async history(actor: SystemsActor, panelId: string, now = new Date()) {
    await this.panelOf(actor, panelId);
    return this.view(panelId, now);
  }

  async set(actor: SystemsActor, panelId: string, body: PanelCostBody, now = new Date()) {
    const panel = await this.panelOf(actor, panelId);
    if (panel.retiredAt !== null) throw new SystemsRefused('panel_retired');
    const effectiveFrom = body.effectiveFrom ?? dayOf(now);
    if (effectiveFrom < openMonthOf(now)) throw new SystemsRefused('cost_in_closed_month');
    const from = new Date(`${effectiveFrom}T00:00:00Z`);
    await this.all.$transaction(async (tx) => {
      if (await finerThanCurrency(tx, PANEL_CURRENCY, { monthlyCostUsd: new Prisma.Decimal(body.monthlyCostUsd) })) throw new SystemsRefused('cost_finer_than_currency');
      await tx.panelCost.create({
        data: {
          panelId,
          monthlyCostUsd: body.monthlyCostUsd,
          monthlyTrafficBytes: body.monthlyTrafficBytes === undefined ? null : BigInt(body.monthlyTrafficBytes),
          effectiveFrom: from,
          createdByUserId: actor.adminId,
        },
      });
      // A price from an earlier day restates the platform's cost rows from it (F-1002-e): only its rows carry panel costs.
      await restateCostsFrom(tx, await platformTenantIdOf(tx), from);
    });
    this.logger.log(`panel ${panelId} costs ${body.monthlyCostUsd} USD a month from ${effectiveFrom}, set by ${actor.adminId}`);
    return this.view(panelId, now);
  }

  private async panelOf(actor: SystemsActor, panelId: string) {
    const scope = await panelScopeOf(this.prisma, actor);
    const panel = await this.prisma.panel.findFirst({ where: { id: panelId, ...scope }, select: { id: true, retiredAt: true } });
    if (!panel) throw new SystemsRefused('not_found');
    return panel;
  }

  private async view(panelId: string, now: Date): Promise<{ current: PanelCostView | null; history: PanelCostView[] }> {
    const rows = await this.prisma.panelCost.findMany({ where: { panelId }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
    const current = costOn(rows, dayOf(now));
    return { current: current && viewOf(current), history: rows.map(viewOf) };
  }
}
