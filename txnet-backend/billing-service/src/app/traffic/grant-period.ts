import { Injectable } from '@nestjs/common';
import { LedgerDirection, Prisma, RateCardMode, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { periodBounds, SpendingCaps } from '../usage/cap-funding';
import { vpnMeterOf } from './vpn-meter';

const ZERO = new Prisma.Decimal(0);
const NO_BYTES = BigInt(0);

/** What a Grant's usage is charged as, and what gives it back (ADR-0072, contract.usage-rating.md). */
const USAGE_REASONS: WalletReasonType[] = [
  WalletReasonType.traffic_consumption,
  WalletReasonType.traffic_refund,
  WalletReasonType.usage_charge,
  WalletReasonType.usage_refund,
];

export type GrantPeriodRejection = 'grant_not_found' | 'grant_not_metered';

export class GrantPeriodRefused extends Error {
  constructor(
    readonly reason: GrantPeriodRejection,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'GrantPeriodRefused';
  }
}

/** One billing period: instants, bytes as a decimal string, money in the wallet's currency to two places. */
export type GrantPeriod = { from: string; to: string; consumedBytes: string; spent: string };

export type GrantPeriodView = {
  current: GrantPeriod;
  /** Null in the Grant's first period. */
  previous: GrantPeriod | null;
  /** The wallet's; null with no wallet, and then nothing is spent. */
  currencyCode: string | null;
  /** Roughly how many more bytes are paid for or payable; null when the rate is in another currency than the wallet. */
  coversBytes: string | null;
};

/** `YYYY-MM-DD` midnight of an instant's UTC day — the key `traffic_daily_aggregate.date` is. */
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * A metered Grant's billing period (F-118-ai), what the service card shows in
 * place of `purchasedBytes`, a bag that read as a limit, and `consumedBytes`,
 * a lifetime total that only grows (user, 2026-09-30).
 *
 * The period is the Grant's own month: anniversaries of `startsAt`, clamped
 * like a monthly cap's (`periodBounds`). This period's bytes are the live
 * `consumedBytes` less what `traffic_daily_aggregate` holds before the
 * period's UTC day: the rollup runs nightly (network `contract.rollup.md`), so
 * a sum of the period's own days would miss today until tomorrow night. The
 * last period is the difference of two such sums, all rolled days. The
 * aggregate is fenced as the 30-day chart's is (`grant-usage.ts`). Money is
 * the ledger's: this Grant's usage debits less their refunds.
 *
 * `coversBytes` is an estimate, never a promise: the bag left, plus what the
 * money this Grant may still spend buys in whole units at its rate — the free
 * balance and, prepaid, its own reserve, bounded by its cap
 * (`SpendingCaps.within`). A sibling's share of the wallet (F-118-ag) and a
 * reseller's wholesale leg are not taken off.
 */
@Injectable()
export class GrantPeriodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly caps: SpendingCaps,
  ) {}

  forGrant(userId: string, grantId: string, now: Date = new Date()): Promise<GrantPeriodView> {
    return tenantTransaction(this.prisma, async (tx) => {
      const grant = await tx.grant.findFirst({ where: { id: grantId, userId } });
      if (!grant) throw new GrantPeriodRefused('grant_not_found', grantId);
      const meter = grant.billingMode === VariantBillingMode.metered && !grant.trafficUnlimited ? await vpnMeterOf(tx, grant.id) : null;
      if (!meter) throw new GrantPeriodRefused('grant_not_metered', grantId);

      const wallet = await tx.wallet.findUnique({ where: { ownerUserId: userId } });
      const configs = await tx.config.findMany({ where: { grantId, userId }, select: { id: true } });
      const configIds = configs.map((c) => c.id);

      const period = async (from: Date, to: Date, bytes: bigint): Promise<GrantPeriod> => ({
        from: from.toISOString(),
        to: to.toISOString(),
        consumedBytes: (bytes > NO_BYTES ? bytes : NO_BYTES).toString(),
        spent: (wallet ? await spentIn(tx, wallet, grantId, from, to) : ZERO).toFixed(2),
      });

      const cur = periodBounds(grant.startsAt, now);
      const beforeCurrent = await bytesBefore(tx, configIds, cur.from);
      const current = await period(cur.from, cur.to, grant.consumedBytes - beforeCurrent);
      let previous: GrantPeriod | null = null;
      if (cur.from.getTime() > grant.startsAt.getTime()) {
        const from = periodBounds(grant.startsAt, new Date(cur.from.getTime() - 1)).from;
        previous = await period(from, cur.from, beforeCurrent - (await bytesBefore(tx, configIds, from)));
      }

      const bagLeft = grant.purchasedBytes > grant.consumedBytes ? grant.purchasedBytes - grant.consumedBytes : NO_BYTES;
      let coversBytes: string | null = bagLeft.toString();
      if (wallet && meter.currencyCode !== wallet.currencyCode) coversBytes = null;
      else if (wallet && meter.unitPrice.gt(0)) {
        const free = wallet.cachedBalance.minus(wallet.heldAmount);
        // Prepaid, its reserve is money set aside for its next blocks; a postpaid hold is for bytes already served.
        const own = meter.mode === RateCardMode.prepaid ? await this.caps.heldFor(tx, grant) : ZERO;
        const room = await this.caps.within(tx, grant, free.plus(own), own, now);
        const units = BigInt(room.dividedToIntegerBy(meter.unitPrice).toFixed(0));
        coversBytes = (bagLeft + (units > NO_BYTES ? units * meter.unitSize : NO_BYTES)).toString();
      }

      return { current, previous, currencyCode: wallet?.currencyCode ?? null, coversBytes };
    });
  }
}

/** The Grant's rolled bytes on every UTC day before `at`'s — whole days, never today. */
async function bytesBefore(tx: Prisma.TransactionClient, configIds: string[], at: Date): Promise<bigint> {
  if (configIds.length === 0) return NO_BYTES;
  const sum = await tx.trafficDailyAggregate.aggregate({
    where: { configId: { in: configIds }, date: { lt: utcDay(at) } },
    _sum: { totalUploadBytes: true, totalDownloadBytes: true },
  });
  return (sum._sum.totalUploadBytes ?? NO_BYTES) + (sum._sum.totalDownloadBytes ?? NO_BYTES);
}

async function spentIn(
  tx: Prisma.TransactionClient,
  wallet: { id: string; currencyCode: string },
  grantId: string,
  from: Date,
  to: Date,
): Promise<Prisma.Decimal> {
  const rows = await tx.walletTransaction.findMany({
    where: {
      walletId: wallet.id,
      referenceId: grantId,
      currencyCode: wallet.currencyCode,
      reasonType: { in: USAGE_REASONS },
      createdAt: { gte: from, lt: to },
    },
    select: { amount: true, direction: true },
  });
  const net = rows.reduce((sum, r) => (r.direction === LedgerDirection.debit ? sum.plus(r.amount) : sum.minus(r.amount)), ZERO);
  return net.lt(0) ? ZERO : net;
}
