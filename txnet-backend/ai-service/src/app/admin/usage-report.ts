import { Injectable } from '@nestjs/common';
import { TenantType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { refusal } from '../envelope';
import { PrismaService } from '../prisma/prisma.service';
import { ResellerReader } from '../profile/reseller-reader';
import { FORECAST_RATE_DAYS, usageForecast, walletRunOut, type MeterForecast } from '../profile/usage-forecast';

const DAY_MS = 86_400_000;

type HourRow = { meterKey: string; hour: Date; delta: bigint };

export type WalletForecast = { balance: string; perDay: string; runsOutAt: string; topUp: string; currencyCode: string; observedDays: number };

/**
 * F-1525-a (ADR-0109 point 7, §24.3): forecasts a person reads — never a
 * meter or money moved.
 *
 * - `forecast` — the caller's own tenant: its users' total use per meter over
 *   the next 30 days, from `ai.meter_reading` (sampled only while its engine
 *   runs, F-1550), and its billing wallet at its wholesale rate.
 * - `capacity` — the platform owner only: every tenant's meters summed, each
 *   tenant's readings read in its own scope, and how many tenants had any —
 *   a tenant whose engine does not run is not measured, and the answer says so.
 */
@Injectable()
export class UsageReport {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resellers: ResellerReader,
  ) {}

  async forecast(tenantId: string, now: Date): Promise<{ meters: MeterForecast[]; wallet: WalletForecast | null }> {
    const meters = usageForecast(await this.hours(tenantId, now), now);
    const wallet = await this.resellers.wholesale(tenantId);
    const r = wallet && walletRunOut(wallet, now);
    return {
      meters,
      wallet: r
        ? { balance: r.balance.toFixed(2), perDay: r.perDay.toFixed(2), runsOutAt: r.runsOutAt.toISOString(), topUp: r.topUp.toFixed(2), currencyCode: r.currencyCode, observedDays: r.observedDays }
        : null,
    };
  }

  async capacity(tenantId: string, now: Date): Promise<{ meters: MeterForecast[]; tenantsMeasured: number; tenants: number }> {
    // `tenant.tenant` has no RLS; the app pool reads it as every service does.
    const caller = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    if (caller?.tenantType !== TenantType.platform_owner) throw refusal(403, 'not_platform_owner');
    const tenants = await this.prisma.tenant.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } });
    const total = new Map<string, HourRow>();
    let measured = 0;
    for (const { id } of tenants) {
      const rows = await this.hours(id, now);
      if (rows.length > 0) measured += 1;
      for (const r of rows) {
        const key = `${r.meterKey}|${r.hour.getTime()}`;
        const sum = total.get(key);
        total.set(key, sum ? { ...sum, delta: sum.delta + r.delta } : r);
      }
    }
    return { meters: usageForecast([...total.values()], now), tenantsMeasured: measured, tenants: tenants.length };
  }

  /**
   * One tenant's readings summed per meter and UTC hour, a day past the rate's
   * window — `ai`'s own table, in that tenant's scope. An hour that grew
   * nothing has no row, so each meter is also dated from the tenant's first
   * reading (a zero row): a meter idle for days is not read as a young one.
   */
  private hours(tenantId: string, now: Date): Promise<HourRow[]> {
    const since = new Date(now.getTime() - (FORECAST_RATE_DAYS + 1) * DAY_MS);
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const rows = await tx.$queryRaw<HourRow[]>`
          SELECT "meterKey", "hour", SUM("delta")::bigint AS "delta"
          FROM ai.meter_reading
          WHERE "tenantId" = ${tenantId}::uuid AND "hour" > ${since}
          GROUP BY "meterKey", "hour"`;
        if (rows.length === 0) return rows;
        const [first] = await tx.$queryRaw<Array<{ hour: Date | null }>>`
          SELECT MIN("hour") AS "hour" FROM ai.meter_reading WHERE "tenantId" = ${tenantId}::uuid`;
        if (!first?.hour) return rows;
        const meters = [...new Set(rows.map((r) => r.meterKey))];
        return [...rows, ...meters.map((meterKey) => ({ meterKey, hour: first.hour as Date, delta: BigInt(0) }))];
      }),
    );
  }
}
