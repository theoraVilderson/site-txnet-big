import type { CouponStatus } from './coupon-admin.service';

/** A coupon row as the admin service reads it: untyped columns. */
type Row = Record<string, unknown>;

const dateOf = (v: unknown): Date | null => (v === null || v === undefined || v === '' ? null : v instanceof Date ? v : new Date(String(v)));

/**
 * A coupon whose type, value and grant variant are settled (F-502-c, F-502-o).
 * A released redemption (`cancelled`/`expired`) leaves no counter behind, so the
 * row alone freezes the coupon: its receipt already names what it took.
 */
export function frozenBy(row: Row, hasRedemption: boolean): boolean {
  return Number(row['usedCount'] ?? 0) > 0 || Number(row['reservedCount'] ?? 0) > 0 || hasRedemption;
}

/** What an admin sees at a glance; the first that holds wins. */
export function statusOf(row: Row, now: number): CouponStatus {
  if (row['deletedAt'] != null) return 'deleted';
  if (!row['isActive']) return 'inactive';
  const until = dateOf(row['expiresAt']);
  if (until && until.getTime() <= now) return 'expired';
  const from = dateOf(row['validFrom']);
  if (from && from.getTime() > now) return 'scheduled';
  const total = row['totalUsageLimit'] as number | null | undefined;
  if (total !== null && total !== undefined && Number(row['usedCount'] ?? 0) + Number(row['reservedCount'] ?? 0) >= total) return 'exhausted';
  return 'active';
}
