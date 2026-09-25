import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvoiceStatus, RedemptionStatus } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CouponReservationService } from '../payment/coupon/coupon-reservation';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The 30-minute clock on an invoice nobody paid (F-111-a), and the coupon
 * holds it took.
 *
 * The same shape as the top-up sweep (`deposit-expiry.service.ts`, F-092-k):
 * the scan is cross-tenant, every write runs in the invoice's own
 * `tenantTransaction` (the coupon functions scope by it), and the flip is
 * guarded by the row's status — an invoice paid between the scan and the write
 * matches nothing and keeps its holds, which by then are uses.
 *
 * **Unlike a top-up, the holds go back at once.** A top-up's bank may still
 * charge after its clock (ADR-0047 decision 2), so its holds outlive it. An
 * invoice is paid from the wallet under a lock on the invoice itself (F-111-b):
 * once this flip commits, no payment of it can follow, so there is nothing to
 * wait for. A hold is released `expired`, never `cancelled` — the clock ran out.
 */
export type InvoiceExpiryResult = {
  /** Rows the scan found due, at most one batch. */
  scanned: number;
  /** Rows still `pending` when the guarded flip ran. */
  expired: number;
  /** Of those, the ones that held coupons and gave them back. */
  holdsReleased: number;
};

@Injectable()
export class InvoiceExpiryService {
  private readonly logger = new Logger(InvoiceExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly reservations: CouponReservationService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async expirePending(): Promise<InvoiceExpiryResult> {
    // One `now` for the scan and every guard, so a row due when read cannot be spared mid-sweep.
    const now = new Date();
    const due = await this.crossTenant.invoice.findMany({
      where: { status: InvoiceStatus.pending, expiresAt: { lte: now } },
      select: { id: true, tenantId: true },
      // Oldest first, so a backlog larger than one batch drains in order.
      orderBy: { expiresAt: 'asc' },
      take: this.config.get('PAYMENT_EXPIRY_BATCH_SIZE', { infer: true }),
    });

    let expired = 0;
    let holdsReleased = 0;
    for (const { id, tenantId } of due) {
      const released = await runWithTenant({ id: tenantId }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          const { count } = await tx.invoice.updateMany({
            where: { id, status: InvoiceStatus.pending, expiresAt: { lte: now } },
            data: { status: InvoiceStatus.expired },
          });
          if (count !== 1) return null;
          return this.reservations.release(tx, id, RedemptionStatus.expired);
        }),
      );
      if (released === null) continue;
      expired++;
      if (released > 0) holdsReleased++;
    }

    if (expired > 0) this.logger.log(`expired ${expired} pending invoice(s) and gave their coupon holds back`);
    return { scanned: due.length, expired, holdsReleased };
  }
}
