import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { finerThanCurrency, isPlatformTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { dayOf } from '../../analytics/analytics-days';
import { restateCostsFrom } from '../../analytics/analytics-rollup-own-cost';
import { PrismaService } from '../../prisma/prisma.service';
import { GatewayAdminRefused } from './gateway-admin.refusal';
import type { GatewayActor, GatewayRef } from './gateway-admin.service';
import { COMMISSIONS_SHOWN, CommissionBody, CommissionHistory, CommissionView, commissionView, ownGatewayOnly } from './gateway-commission';

type Tx = Prisma.TransactionClient;
type Owned = { tenantId: string; currencyCode: string; column: { gatewayId: string } | { tenantGatewayConfigId: string } };

/**
 * What a gateway's provider deducts (F-1001-v, contract.analytics-expenses.md
 * "Gateway commission"), on `/api/billing/gateways/:source/:id/commission`
 * behind `gateway.manage`. The caller's own gateways only (`ownGatewayOnly`),
 * in its own tenant transaction — strict RLS stands behind it. History: an
 * add is a new row and asks the next rollup pass to restate the tenant's cost
 * rows from its day, which re-announces the figures (C-14).
 */
@Injectable()
export class GatewayCommissionService {
  private readonly logger = new Logger(GatewayCommissionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The gateway's commissions, the newest day first, and which one costs a payment made today. */
  history(actor: GatewayActor, ref: GatewayRef, now = new Date()): Promise<CommissionHistory> {
    return tenantTransaction(this.prisma, async (tx) => {
      const gateway = await this.owned(tx, actor, ref);
      const rows = await tx.gatewayCommission.findMany({
        where: gateway.column,
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: COMMISSIONS_SHOWN,
      });
      const today = await this.todayOf(tx, gateway.tenantId, now);
      const commissions = rows.map(commissionView);
      return { commissions, inEffect: commissions.find((c) => c.effectiveFrom <= today)?.id ?? null, currencyCode: gateway.currencyCode };
    });
  }

  /** A commission from `effectiveFrom` on, its fixed amount at the gateway currency's places; audited as a gateway update. */
  add(actor: GatewayActor, ref: GatewayRef, body: CommissionBody): Promise<CommissionView> {
    return tenantTransaction(this.prisma, async (tx) => {
      const gateway = await this.owned(tx, actor, ref);
      const fixedAmount = new Prisma.Decimal(body.fixedAmount);
      if (await finerThanCurrency(tx, gateway.currencyCode, { fixedAmount })) {
        throw new GatewayAdminRefused('invalid_range', `fixedAmount is finer than ${gateway.currencyCode}'s places`);
      }
      const effectiveFrom = new Date(`${body.effectiveFrom}T00:00:00Z`);
      const row = await tx.gatewayCommission.create({
        data: { tenantId: gateway.tenantId, ...gateway.column, percent: new Prisma.Decimal(body.percent), fixedAmount, currencyCode: gateway.currencyCode, effectiveFrom, createdByUserId: actor.adminId },
      });
      const view = commissionView(row);
      await tx.adminAuditLog.create({
        data: {
          tenantId: gateway.tenantId,
          adminId: actor.adminId,
          action: 'gateway_update',
          targetEntityType: 'gateway',
          targetEntityId: ref.id,
          newValue: { source: ref.source, commission: { percent: view.percent, fixedAmount: view.fixedAmount, currencyCode: view.currencyCode, effectiveFrom: view.effectiveFrom } },
          adminIpAddress: actor.ip,
        },
      });
      await restateCostsFrom(tx, gateway.tenantId, effectiveFrom);
      this.logger.log(`gateway ${ref.source}:${ref.id}: commission ${view.percent}% + ${view.fixedAmount} ${view.currencyCode} from ${view.effectiveFrom}, by ${actor.adminId}`);
      return view;
    });
  }

  /** The gateway, if it is the caller's own; its currency is the fixed amount's. */
  private async owned(tx: Tx, actor: GatewayActor, ref: GatewayRef): Promise<Owned> {
    const tenant = await tx.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    const caller = { tenantId: actor.tenantId, owner: isPlatformTenant(tenant?.tenantType) };
    if (ref.source === 'platform') {
      const row = caller.owner ? await tx.paymentGateway.findUnique({ where: { id: ref.id }, select: { currencyCode: true } }) : null;
      const tenantId = ownGatewayOnly(ref, null, caller);
      if (!row) throw new GatewayAdminRefused('gateway_not_found', ref.id);
      return { tenantId, currencyCode: row.currencyCode, column: { gatewayId: ref.id } };
    }
    const row = await tx.tenantGatewayConfig.findUnique({ where: { id: ref.id }, select: { tenantId: true, currencyCode: true } });
    return { tenantId: ownGatewayOnly(ref, row, caller), currencyCode: row?.currencyCode ?? '', column: { tenantGatewayConfigId: ref.id } };
  }

  private async todayOf(tx: Tx, tenantId: string, now: Date): Promise<string> {
    const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    return dayOf(now, timezone);
  }
}
