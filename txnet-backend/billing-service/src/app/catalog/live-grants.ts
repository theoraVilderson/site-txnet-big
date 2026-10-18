/**
 * A variant's live services, for its active cap (F-514-a, catalog F-514).
 * Counted from the Grants by `catalog.live_grants_of` — SECURITY DEFINER,
 * because a platform variant's grants belong to every reseller and RLS shows
 * the caller only its own. One query for every capped variant of a read.
 */
import { Prisma } from '@prisma/client';

type LiveRow = { variantId: string; liveCount: number };

/** The live Grant count of each capped variant in `rows`, on the caller's `tenantTransaction`. */
async function liveGrantsOf(tx: Prisma.TransactionClient, rows: Array<{ id: string; activeCap?: number | null }>): Promise<Map<string, number>> {
  const ids = rows.filter((r) => typeof r.activeCap === 'number').map((r) => r.id);
  // An uncapped variant shows no live count, so a read with none asks nothing.
  if (ids.length === 0) return new Map();
  const counts = await tx.$queryRaw<LiveRow[]>`SELECT "variantId", "liveCount" FROM catalog.live_grants_of(${ids}::uuid[])`;
  return new Map(counts.map((c) => [c.variantId, c.liveCount]));
}

/** `rows` with each one's live count (0 for an uncapped one) — what an offer and a variant view read. */
export async function withLiveCounts<T extends { id: string; activeCap?: number | null }>(
  tx: Prisma.TransactionClient,
  rows: T[],
): Promise<Array<T & { liveCount: number }>> {
  const live = await liveGrantsOf(tx, rows);
  return rows.map((r) => ({ ...r, liveCount: live.get(r.id) ?? 0 }));
}

/** {@link withLiveCounts} over the admin service's untyped rows. */
export function withLiveCountRows(tx: Prisma.TransactionClient, rows: Array<Record<string, unknown>>) {
  return withLiveCounts(
    tx,
    rows.map((r) => ({ ...r, id: r['id'] as string, activeCap: (r['activeCap'] as number | null | undefined) ?? null })),
  );
}
