import { Prisma } from '@prisma/client';

import { UnscopedRedisKeys } from '../redis/keys';

/**
 * The currency every `currency_exchange_rate` row is quoted against (ADR-0098
 * part 6). A row is "units of `code` per one USD"; USD has no row of its own.
 */
export const FX_PIVOT_CURRENCY = 'USD';

/** One accepted USD -> `currencyCode` rate, and the row that backs it. */
export interface FxRateSnapshot {
  /** `currency.CurrencyExchangeRate.id` — what a price records it crossed at. */
  snapshotId: string;
  currencyCode: string;
  rate: Prisma.Decimal;
  /** F-0607-a's staleness ladder reads this; the reader does not judge it. */
  effectiveAt: Date;
}

/**
 * `fromCode` -> `toCode`: one unit of `fromCode` is `rate` units of `toCode`.
 * A leg is `null` when that side is the pivot (or both sides are one
 * currency), because the pivot's rate is exactly 1 and no row backs it.
 */
export interface FxPair {
  fromCode: string;
  toCode: string;
  rate: Prisma.Decimal;
  from: FxRateSnapshot | null;
  to: FxRateSnapshot | null;
}

/** The two tables the table fallback reads. A transaction client or a service fits. */
export type FxRateDb = Pick<Prisma.TransactionClient, 'currency' | 'currencyExchangeRate'>;

/** `fx:rate:{code}` is read with a plain GET. */
export interface FxRateCache {
  get(key: string): Promise<string | null>;
}

export interface FxRateLog {
  warn(message: string): void;
}

/**
 * F-116-c — the rate the platform last accepted for one currency: the worker's
 * `fx:rate:{code}` cache first, the newest `currency_exchange_rate` row second
 * (`contract.fx-worker.md`). Moved here from billing's `FxRateReader` (F-092-c)
 * so every service reads a rate the same way.
 *
 * **It never throws.** Redis down, a value that no longer parses, a cached
 * value for another code, no `currency` row, no snapshot ever written — each
 * is `null`, and a caller turns `null` into its own "no rate" (a 503, a
 * static rate). A rate with no snapshot id, or one that is not positive, is
 * never handed out (ADR-0019): a bad cache entry falls through to the table.
 */
export async function readFxRate(
  db: FxRateDb,
  cache: FxRateCache,
  code: string,
  log?: FxRateLog,
): Promise<FxRateSnapshot | null> {
  return (await fromCache(cache, code, log)) ?? (await fromTable(db, code, log));
}

/**
 * F-116-c — any currency to any other through the USD pivot (ADR-0098 part 6):
 * `rate(to) / rate(from)`, each leg at its own latest snapshot, both returned
 * so a caller can record the pair it crossed at (F-116-e, F-116-g).
 *
 * `null` when either non-pivot leg has no rate — never half a pair. The rate
 * is not rounded: a caller rounds the **amount** it converts, to the target
 * currency's `decimalPlaces`, once.
 */
export async function readFxPair(
  db: FxRateDb,
  cache: FxRateCache,
  fromCode: string,
  toCode: string,
  log?: FxRateLog,
): Promise<FxPair | null> {
  if (fromCode === toCode) return { fromCode, toCode, rate: new Prisma.Decimal(1), from: null, to: null };

  const leg = (code: string) =>
    code === FX_PIVOT_CURRENCY ? Promise.resolve(null) : readFxRate(db, cache, code, log);
  const [from, to] = await Promise.all([leg(fromCode), leg(toCode)]);

  if ((fromCode !== FX_PIVOT_CURRENCY && !from) || (toCode !== FX_PIVOT_CURRENCY && !to)) return null;

  const fromRate = from?.rate ?? new Prisma.Decimal(1);
  const toRate = to?.rate ?? new Prisma.Decimal(1);
  return { fromCode, toCode, rate: toRate.div(fromRate), from, to };
}

async function fromCache(cache: FxRateCache, code: string, log?: FxRateLog): Promise<FxRateSnapshot | null> {
  try {
    const hit = await cache.get(UnscopedRedisKeys.fxRate(code));
    if (!hit) return null;
    const value = JSON.parse(hit) as Partial<{ snapshotId: string; currencyCode: string; rate: string; effectiveAt: string }>;
    // A value naming another currency is not this currency's rate, however it got there.
    if (value.currencyCode !== undefined && value.currencyCode !== code) return null;
    return usable(value.snapshotId, code, value.rate, value.effectiveAt);
  } catch (err) {
    // An unreadable cache is a miss, not "no rate": the table still answers.
    log?.warn(`fx rate cache for ${code} unusable, falling back to the snapshot table: ${(err as Error).message}`);
    return null;
  }
}

async function fromTable(db: FxRateDb, code: string, log?: FxRateLog): Promise<FxRateSnapshot | null> {
  // `currency_exchange_rate` has no `tenantId` and no RLS policy: the rate is
  // the platform's, so this reads the same with or without a bound tenant.
  const currency = await db.currency.findUnique({ where: { code }, select: { id: true } });
  if (!currency) {
    log?.warn(`no currency row with code "${code}" — no rate can be read`);
    return null;
  }
  // Append-only (invariant #3): "current" is the newest `effectiveAt`, which
  // the `[currencyId, effectiveAt desc]` index answers.
  const latest = await db.currencyExchangeRate.findFirst({
    where: { currencyId: currency.id, isActive: true },
    orderBy: { effectiveAt: 'desc' },
    select: { id: true, rate: true, effectiveAt: true },
  });
  return latest ? usable(latest.id, code, latest.rate, latest.effectiveAt) : null;
}

/** A snapshot a pricer will accept, or nothing: id, positive rate and age, or none of them (ADR-0019). */
function usable(
  snapshotId: string | undefined,
  currencyCode: string,
  rate: Prisma.Decimal | string | undefined,
  effectiveAt: Date | string | undefined,
): FxRateSnapshot | null {
  if (!snapshotId || snapshotId.trim() === '' || rate === undefined || rate === null) return null;
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(rate);
  } catch {
    return null;
  }
  if (!value.gt(0)) return null;
  // F-0607-a's ladder is a function of the age, so a snapshot without one is no snapshot.
  const at = effectiveAt === undefined ? null : new Date(effectiveAt);
  if (!at || Number.isNaN(at.getTime())) return null;
  return { snapshotId, currencyCode, rate: value, effectiveAt: at };
}
