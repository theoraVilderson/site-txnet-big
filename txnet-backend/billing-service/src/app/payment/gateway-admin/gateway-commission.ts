import { GatewayCommission } from '@prisma/client';
import { MONEY_PATTERN, moneyText } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { calendarDaySchema } from '../../request/calendar-day.schema';
import type { GatewayRef } from './gateway-admin.service';
import { GatewayAdminRefused } from './gateway-admin.refusal';

/** A provider's percent: 0..100 at the column's four places (`DECIMAL(9,4)`), never rounded on write (F-104-ad). */
const PERCENT_PATTERN = /^(0|[1-9]\d{0,2})(\.\d{1,4})?$/;
const PERCENT_MAX = 100;
/** The most rows one history answers, newest first: years of changes for one gateway. */
export const COMMISSIONS_SHOWN = 50;

/**
 * `POST /api/billing/gateways/:source/:id/commission` (F-1001-v,
 * contract.analytics-expenses.md "Gateway commission"): what the provider
 * deducts from the merchant — a percent of what was charged and a fixed amount
 * in the gateway's currency, decimal strings (C-02) — from a tenant day on.
 * There is no edit: a change is a new row, 0 and 0 to stop counting one.
 */
export const commissionSchema = z
  .object({
    percent: z.string().regex(PERCENT_PATTERN).refine((p) => Number(p) <= PERCENT_MAX, 'over_100'),
    fixedAmount: z.string().regex(MONEY_PATTERN),
    effectiveFrom: calendarDaySchema,
  })
  .strict();
export type CommissionBody = z.infer<typeof commissionSchema>;

/** One commission row as answered: ratios and money as decimal strings. */
export type CommissionView = {
  id: string;
  percent: string;
  fixedAmount: string;
  currencyCode: string;
  effectiveFrom: string;
  createdByUserId: string | null;
  createdAt: string;
};

/** A gateway's history, newest day first; `inEffect` the row a payment made today is costed by, `null` before the first. */
export type CommissionHistory = { commissions: CommissionView[]; inEffect: string | null; currencyCode: string };

export const commissionView = (c: GatewayCommission): CommissionView => ({
  id: c.id,
  percent: c.percent.toFixed(),
  fixedAmount: moneyText(c.fixedAmount),
  currencyCode: c.currencyCode,
  effectiveFrom: c.effectiveFrom.toISOString().slice(0, 10),
  createdByUserId: c.createdByUserId,
  createdAt: c.createdAt.toISOString(),
});

/**
 * The tenant a gateway's commission belongs to — its owner's — or not found.
 * A platform gateway is the platform owner's; a tenant gateway the tenant's
 * that owns it, **even to the platform owner**, who manages every gateway but
 * whom a reseller's costs are not a report for (as its expenses, F-1001-t).
 */
export function ownGatewayOnly(ref: GatewayRef, row: { tenantId: string } | null, caller: { tenantId: string; owner: boolean }): string {
  if (ref.source === 'platform' && caller.owner) return caller.tenantId;
  if (ref.source === 'tenant' && row?.tenantId === caller.tenantId) return caller.tenantId;
  throw new GatewayAdminRefused('gateway_not_found', ref.id);
}
