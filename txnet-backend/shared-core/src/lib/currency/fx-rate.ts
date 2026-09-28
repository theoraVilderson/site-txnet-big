import { Prisma, RateSource } from '@prisma/client';

import { UnscopedRedisKeys } from '../redis/keys';

/**
 * The currency every `currency_exchange_rate` row is quoted against (ADR-0098
 * part 6). A row is "units of `code` per one USD"; USD has no row of its own.
 */
export const FX_PIVOT_CURRENCY = 'USD';

/**
 * F-116-m — a currency that is another divided by a fixed number, never a
 * rate of its own (user, 2026-09-28): the toman is ten rials. Its rate is
 * `rate(of) / divisor`, read through the same pin, cache and table as `of`,
 * so a rial pin moves the toman and the two can never disagree. Nothing
 * fetches, stores or pins a rate for a key of this map.
 */
export const DERIVED_CURRENCIES: Readonly<Record<string, { of: string; divisor: number }>> = {
  IRT: { of: 'IRR', divisor: 10 },
};

/** `code`'s root currency and how many root units one of `code` is — `code`, 1 for any other. */
function rootOf(code: string): { root: string; units: number } {
  const derived = DERIVED_CURRENCIES[code];
  return derived ? { root: derived.of, units: derived.divisor } : { root: code, units: 1 };
}

/** One accepted USD -> `currencyCode` rate, and the row that backs it. */
export interface FxRateSnapshot {
  /** `currency.CurrencyExchangeRate.id` — what a price records it crossed at. */
  snapshotId: string;
  currencyCode: string;
  rate: Prisma.Decimal;
  /** F-0607-a's staleness ladder reads this; the reader does not judge it. */
  effectiveAt: Date;
  /** Set when this is a person's pin (F-0608-a, ADR-0101), not a discovered rate. */
  /** `expiresAt` null: a pin with no end, live until a person ends it (F-116-n). */
  pinned?: { reason: string; expiresAt: Date | null };
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

/**
 * The two tables the reads use. A transaction client or a service fits; a
 * service also brings `$transaction`, which a tenant's pin needs (below).
 */
export type FxRateDb = Pick<Prisma.TransactionClient, 'currency' | 'currencyExchangeRate'> & {
  $transaction?: unknown;
};

type PinQuery = Parameters<Prisma.TransactionClient['currencyExchangeRate']['findFirst']>[0];

/** `fx:rate:{code}` is read with a plain GET. */
export interface FxRateCache {
  get(key: string): Promise<string | null>;
}

export interface FxRateLog {
  warn(message: string): void;
}

/**
 * Whose books a read prices (F-116-j, ADR-0098 part 9). With a `tenantId`,
 * that tenant's own live pin answers before the platform's. Without one — the
 * tenant <-> platform boundary, a billing top-up, anything the platform
 * charges a tenant — no tenant's pin is ever read.
 */
export interface FxRateScope {
  tenantId?: string | null;
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
  scope: FxRateScope = {},
): Promise<FxRateSnapshot | null> {
  const { root, units } = rootOf(code);
  if (root !== code) {
    // The root's snapshot, its id and pin kept: a price records the rial row it crossed at.
    const snap = await readFxRate(db, cache, root, log, scope);
    return snap ? { ...snap, currencyCode: code, rate: snap.rate.div(units) } : null;
  }
  return (
    (await fromPin(db, code, log, scope)) ??
    (await fromCache(cache, code, log)) ??
    (await fromTable(db, code, log))
  );
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
  scope: FxRateScope = {},
): Promise<FxPair | null> {
  if (fromCode === toCode) return { fromCode, toCode, rate: new Prisma.Decimal(1), from: null, to: null };

  // One root (IRR <-> IRT, F-116-m): the exact ratio, both legs from one read,
  // so a worker tick can never land between them.
  const [f, t] = [rootOf(fromCode), rootOf(toCode)];
  if (f.root === t.root && f.root !== FX_PIVOT_CURRENCY) {
    const snap = await readFxRate(db, cache, f.root, log, scope);
    if (!snap) return null;
    const leg = (code: string, units: number): FxRateSnapshot => ({ ...snap, currencyCode: code, rate: snap.rate.div(units) });
    return { fromCode, toCode, rate: new Prisma.Decimal(f.units).div(t.units), from: leg(fromCode, f.units), to: leg(toCode, t.units) };
  }

  const leg = (code: string) =>
    code === FX_PIVOT_CURRENCY ? Promise.resolve(null) : readFxRate(db, cache, code, log, scope);
  const [from, to] = await Promise.all([leg(fromCode), leg(toCode)]);

  if ((fromCode !== FX_PIVOT_CURRENCY && !from) || (toCode !== FX_PIVOT_CURRENCY && !to)) return null;

  const fromRate = from?.rate ?? new Prisma.Decimal(1);
  const toRate = to?.rate ?? new Prisma.Decimal(1);
  return { fromCode, toCode, rate: toRate.div(fromRate), from, to };
}

/**
 * F-0608-a (ADR-0101 part 3) — a live pin wins over every discovered rate: a
 * `manual_admin` row not yet expired and not ended, the newest if several; a
 * tenant's own before the platform's when the read names that tenant (F-116-j).
 * Read from the table on every call, not a cache: a pin that a Redis flush
 * lost would sell at the rate the admin pinned against, silently. A failed
 * read is a warning and falls through to the discovered rate — the reader
 * never throws.
 */
async function fromPin(db: FxRateDb, code: string, log: FxRateLog | undefined, scope: FxRateScope): Promise<FxRateSnapshot | null> {
  try {
    const currency = await db.currency.findUnique({ where: { code }, select: { id: true } });
    if (!currency) return null;
    const pin = await pinRow(db, scope, {
      where: {
        currencyId: currency.id,
        source: RateSource.manual_admin,
        isActive: true,
        pinEnd: { is: null },
        // Not expired, or no end at all (F-116-n).
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
        // A tenant's pin, then the platform's (F-116-j); no tenant, the platform's only.
        ...(scope.tenantId ? { OR: [{ tenantId: scope.tenantId }, { tenantId: null }] } : { tenantId: null }),
      },
      orderBy: [{ tenantId: { sort: 'asc', nulls: 'last' } }, { effectiveAt: 'desc' }],
      select: { id: true, rate: true, effectiveAt: true, reason: true, expiresAt: true },
    }) as { id: string; rate: Prisma.Decimal; effectiveAt: Date; reason: string | null; expiresAt: Date | null } | null;
    if (!pin) return null;
    const snap = usable(pin.id, code, pin.rate, pin.effectiveAt);
    return snap ? { ...snap, pinned: { reason: pin.reason ?? '', expiresAt: pin.expiresAt } } : null;
  } catch (err) {
    log?.warn(`fx pin for ${code} unreadable, using the discovered rate: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The pin lookup, bound to the tenant it names (F-116-j). `currency_exchange_rate`
 * is under RLS: a tenant's pin is visible only where `app.tenant_id` is that
 * tenant. Given a service (it has `$transaction`), the reader opens a
 * transaction and binds exactly `scope.tenantId` for this one query; given a
 * transaction client, the caller's binding stands. No tenant: no binding, and
 * RLS itself shows only the platform's pins.
 */
async function pinRow(db: FxRateDb, scope: FxRateScope, query: PinQuery): Promise<unknown> {
  const tenantId = scope.tenantId;
  if (!tenantId || typeof db.$transaction !== 'function') return db.currencyExchangeRate.findFirst(query);
  const begin = db.$transaction as (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>;
  return begin.call(db, async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return tx.currencyExchangeRate.findFirst(query);
  });
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
  // the `[currencyId, effectiveAt desc]` index answers. Discovered rates only:
  // a pin is `fromPin`'s, and an expired or ended one is history, not a rate.
  const latest = await db.currencyExchangeRate.findFirst({
    where: { currencyId: currency.id, isActive: true, source: RateSource.external_api },
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
