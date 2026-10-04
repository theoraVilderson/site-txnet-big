import { Injectable } from '@nestjs/common';
import { GrantStatus, InvoiceStatus } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { GrantService } from '../entitlement/grant';
import { PrismaService } from '../prisma/prisma.service';

/** How far back "last connection" looks: the raw log's hot months, partition-pruned. */
const CONNECTION_WINDOW_DAYS = 90;
const RECENT = 5;

/** One Grant, as the agent needs it: what it is, whether it serves, how much is left. No token, no link. */
export type SupportGrantFact = {
  id: string;
  label: string | null;
  nameKey: string | null;
  status: GrantStatus;
  frozen: boolean;
  endsAt: string | null;
  consumedBytes: string;
  purchasedBytes: string;
  trafficCapBytes: string | null;
  trafficUnlimited: boolean;
};

/** What support's sidebar shows of one user (F-033-m, catalog §11.3). Money as decimal strings (C-02). */
export type SupportUserFacts = {
  wallet: { balance: string; held: string; currencyCode: string } | null;
  grants: { items: SupportGrantFact[]; hidden: number };
  invoices: { id: string; total: string; currencyCode: string; status: InvoiceStatus; createdAt: string }[];
  /** The newest raw traffic with bytes in it, within {@link CONNECTION_WINDOW_DAYS}; null = none seen. */
  lastConnectionAt: string | null;
};

/**
 * The billing half of support's user sidebar (F-033-m): billing decides what of
 * its data leaves, support never reads billing's tables (user, 2026-10-04).
 *
 * Runs in the **named tenant's** scope, every read inside a tenant transaction (RLS): the caller is support-service,
 * which found the conversation in that tenant before asking. The Grants are
 * `GrantService.listForUser` — the same rows and `current` filter the user
 * sees — narrowed to what an agent reads.
 */
@Injectable()
export class SupportContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: GrantService,
  ) {}

  of(tenantId: string, userId: string, now = new Date()): Promise<SupportUserFacts> {
    return runWithTenant({ id: tenantId }, async () => {
      const since = new Date(now.getTime() - CONNECTION_WINDOW_DAYS * 86_400_000);
      // listForUser opens its own tenant transaction; the rest share one, so
      // RLS sees the tenant — a bare query on this pool binds none and sees nothing.
      const page = await this.grants.listForUser(userId, { pageSize: RECENT, scope: 'current' });
      const [wallet, invoices, traffic] = await tenantTransaction(this.prisma, (tx) => Promise.all([
        tx.wallet.findUnique({
          where: { ownerUserId: userId },
          select: { cachedBalance: true, heldAmount: true, currencyCode: true },
        }),
        tx.invoice.findMany({
          where: { tenantId, userId },
          orderBy: { createdAt: 'desc' },
          take: RECENT,
          select: { id: true, total: true, currencyCode: true, status: true, createdAt: true },
        }),
        tx.trafficRawLog.findFirst({
          where: {
            tenantId,
            recordedAt: { gte: since },
            config: { grant: { userId } },
            OR: [{ uploadBytes: { gt: 0 } }, { downloadBytes: { gt: 0 } }],
          },
          orderBy: { recordedAt: 'desc' },
          select: { recordedAt: true },
        }),
      ]));
      return {
        wallet: wallet
          ? { balance: wallet.cachedBalance.toString(), held: wallet.heldAmount.toString(), currencyCode: wallet.currencyCode }
          : null,
        grants: {
          hidden: page.hidden,
          items: page.rows.map((g) => ({
            id: g.id,
            label: g.label,
            nameKey: g.variant?.nameKey ?? null,
            status: g.status,
            frozen: g.frozen,
            endsAt: g.endsAt,
            consumedBytes: g.consumedBytes,
            purchasedBytes: g.purchasedBytes,
            trafficCapBytes: g.trafficCapBytes,
            trafficUnlimited: g.trafficUnlimited,
          })),
        },
        invoices: invoices.map((i) => ({
          id: i.id,
          total: i.total.toString(),
          currencyCode: i.currencyCode,
          status: i.status,
          createdAt: i.createdAt.toISOString(),
        })),
        lastConnectionAt: traffic?.recordedAt.toISOString() ?? null,
      };
    });
  }
}
