/**
 * The writers of a variant's sales counts (F-513-b, catalog F-513): a pending
 * invoice holds a unit, payment sells it, expiry, cancel or refund gives it
 * back; a free path takes one or is refused; staff's issue only counts.
 *
 * Every move is one call of `catalog.move_variant_sales` inside the caller's
 * `tenantTransaction`: the function's UPDATE is the variant's row lock, so two
 * buyers of the last unit queue on it and the second is refused. It is a
 * SECURITY DEFINER function because a reseller's users buy the platform's
 * variants, whose rows a reseller's transaction may read but not write.
 */
import { GrantSource, Prisma } from '@prisma/client';
import { OutboxEventType, TenantContext } from '@txnet-backend/shared-core';

/** The outbox aggregate of a variant's sales event. */
export const VARIANT_SALES_AGGREGATE = 'catalog.variant';

/** No unit of the variant is left to hold or to give away. Nothing was written. */
export class VariantSoldOut extends Error {
  readonly reason = 'sold_out' as const;

  constructor(readonly variantId: string) {
    super(`variant ${variantId} is sold out`);
    this.name = 'VariantSoldOut';
  }
}

/** One move of the counts, and whether it is refused when no unit is left. */
const SALES_MOVES = {
  /** An invoice is made: it holds a unit as a sale does (contract.sales-cap.md rule 4). */
  reserve: { sold: 0, reserved: 1, refusesWhenFull: true },
  /** The invoice is paid: its hold becomes a sale, no new unit taken. */
  sellReserved: { sold: 1, reserved: -1, refusesWhenFull: false },
  /** The invoice expired or was cancelled. */
  release: { sold: 0, reserved: -1, refusesWhenFull: false },
  /** A free path — a free-grant coupon, the wheel — takes a unit or is refused (rule 5). */
  sell: { sold: 1, reserved: 0, refusesWhenFull: true },
  /** Staff's issue, and an invoice made before the counts: counted, never refused. */
  count: { sold: 1, reserved: 0, refusesWhenFull: false },
  /** A paid invoice refunded: the sale is undone. */
  unsell: { sold: -1, reserved: 0, refusesWhenFull: false },
} as const;

export type SalesMove = keyof typeof SALES_MOVES;

type MoveRow = { outcome: string; tenantId: string | null; salesCap: number | null };

/**
 * Moves the variant's counts by one, or throws {@link VariantSoldOut}. A
 * capped variant's move is announced to the seller's members and, when the
 * variant is another tenant's (the platform's), to that tenant's too (C-14).
 */
export async function moveSales(tx: Prisma.TransactionClient, variantId: string, move: SalesMove): Promise<void> {
  const tenant = TenantContext.current('variant sales');
  const m = SALES_MOVES[move];
  const [row] = await tx.$queryRaw<MoveRow[]>`
    SELECT outcome, "tenantId", "salesCap"
      FROM catalog.move_variant_sales(${variantId}::uuid, ${m.sold}::integer, ${m.reserved}::integer, ${m.refusesWhenFull}::boolean)`;
  if (row.outcome === 'sold_out') throw new VariantSoldOut(variantId);
  if (row.outcome !== 'moved') throw new Error(`move_variant_sales(${variantId}, ${move}) answered ${row.outcome}`);
  // An uncapped variant shows nothing as left, so no open page needs the move.
  if (row.salesCap === null) return;
  const tenants = new Set([tenant.id, row.tenantId ?? tenant.id]);
  for (const tenantId of tenants) {
    await tx.outboxEvent.create({
      data: { aggregate: VARIANT_SALES_AGGREGATE, aggregateId: variantId, type: OutboxEventType.CATALOG_VARIANT_SALES_CHANGED, payload: { tenantId, variantId } },
      select: { id: true },
    });
  }
}

/**
 * How an issued Grant of each source meets the cap (user, 2026-10-18): the
 * automatic free paths take a unit or are refused, staff's issue — platform or
 * reseller — counts and is never refused. `null`: not a new sale here — a
 * purchase's unit is its invoice's, a migration or rollover carries one already sold.
 */
export const SALE_COUNTING: Record<GrantSource, SalesMove | null> = {
  [GrantSource.purchase]: null,
  [GrantSource.admin_grant]: 'count',
  // Never a Grant's own source, only a quota row's (entitlement.prisma).
  [GrantSource.admin_gift]: null,
  [GrantSource.coupon]: 'sell',
  [GrantSource.affiliate_reward]: 'sell',
  [GrantSource.migration]: null,
  [GrantSource.trial]: 'sell',
  [GrantSource.rollover]: null,
  [GrantSource.engagement_reward]: 'sell',
};

/** The move {@link SALE_COUNTING} names for an issue of `source`, if any. */
export async function countSaleOf(tx: Prisma.TransactionClient, variantId: string, source: GrantSource): Promise<void> {
  const move = SALE_COUNTING[source];
  if (move) await moveSales(tx, variantId, move);
}
