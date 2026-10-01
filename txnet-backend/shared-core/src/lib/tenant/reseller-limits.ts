import { TenantType, type Prisma } from '@prisma/client';

/**
 * What a reseller may do with the platform's shared things (ADR-0106,
 * F-019-m): one registry of keys, each a number bounded at three levels.
 *
 * A key is its name, the platform's default in code, and the highest value
 * staff may type (above it is a typo). A new limit is a new key here plus the
 * one place that refuses past it — no table changes. `default: null` would be
 * "no limit unless someone sets one".
 */
export const RESELLER_LIMITS = {
  /** The number a reseller gives one user, and its tenant default (F-118-ap, F-019-n). */
  user_metered_cap_max: { default: 20, max: 1000 },
  /** Open Grants of the reseller's users on platform panels (F-019-o). */
  platform_open_grants_max: { default: 500, max: 1_000_000 },
  /** Services the reseller's own people issue by hand in any 30 days (F-019-p). */
  admin_issues_30d_max: { default: 50, max: 100_000 },
  /** The reseller's custom domains — each a certificate (F-019-q). */
  custom_domains_max: { default: 5, max: 1000 },
  /** People on the reseller's team: seats not removed and not expired (F-019-t1). */
  staff_members_max: { default: 20, max: 1000 },
  /** Services one bulk job of the reseller's own people may act on, under billing's fixed 100 000 (F-019-t5). A ceiling: `used` is the job's size. */
  bulk_job_grants_max: { default: 10_000, max: 100_000 },
  /** Campaigns the reseller starts sending in any 24 hours (F-019-t4). */
  campaign_sends_daily_max: { default: 10, max: 1000 },
  /** The reseller's end users, any status, not deleted; a new registration is refused at it (F-019-t2). */
  end_users_max: { default: 50_000, max: 10_000_000 },
  /**
   * Whole GiB its users moved on platform panels this UTC calendar month; past
   * it, no new service or renewal on them until the month ends (F-019-t6).
   * No limit unless the platform sets one (user 2026-10-01): each byte is
   * already bought from the reseller's wallet.
   */
  platform_traffic_gib_monthly_max: { default: null as number | null, max: 10_000_000 },
} as const satisfies Record<string, { default: number | null; max: number }>;

export type ResellerLimitKey = keyof typeof RESELLER_LIMITS;

export const RESELLER_LIMIT_KEYS = Object.keys(RESELLER_LIMITS) as ResellerLimitKey[];

export const isResellerLimitKey = (key: string): key is ResellerLimitKey => Object.prototype.hasOwnProperty.call(RESELLER_LIMITS, key);

/**
 * Where the limit in effect came from. `exempt`: the tenant is not a reseller —
 * the platform's own tenant has no limits (ADR-0106 point 4).
 */
export type ResellerLimitSource = 'reseller' | 'package' | 'platform' | 'default' | 'exempt';

/** `limit` null = no limit. */
export type ResellerLimitInEffect = { limit: number | null; source: ResellerLimitSource };

/**
 * The reads the rule needs. `resellerLimit` and `tenantSubscription` have
 * strict tenant RLS: on the app pool, call this in the reseller's own scope;
 * a platform surface reading another reseller passes its cross-tenant pool.
 */
export type ResellerLimitReader = Pick<
  Prisma.TransactionClient,
  'tenant' | 'tenantSubscription' | 'resellerLimit' | 'packageLimit' | 'resellerLimitSetting'
>;

/** The reseller's limit for one key: its own, else its package's, else the platform's, else the code default. A `null` row stops the search. */
export async function resellerLimitOf(tx: ResellerLimitReader, tenantId: string, key: ResellerLimitKey): Promise<ResellerLimitInEffect> {
  const [one] = await limitsOf(tx, tenantId, [key]);
  return { limit: one.limit, source: one.source };
}

/** Every key at once, for a page that shows them all. */
export function resellerLimitsOf(tx: ResellerLimitReader, tenantId: string): Promise<Array<ResellerLimitInEffect & { key: ResellerLimitKey }>> {
  return limitsOf(tx, tenantId, RESELLER_LIMIT_KEYS);
}

async function limitsOf(tx: ResellerLimitReader, tenantId: string, keys: readonly ResellerLimitKey[]): Promise<Array<ResellerLimitInEffect & { key: ResellerLimitKey }>> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
  if (tenant?.tenantType !== TenantType.reseller) return keys.map((key) => ({ key, limit: null as number | null, source: 'exempt' as const }));

  const where = { key: { in: [...keys] } };
  const sub = await tx.tenantSubscription.findUnique({ where: { tenantId }, select: { packageId: true } });
  const [own, pkg, platform] = await Promise.all([
    tx.resellerLimit.findMany({ where: { tenantId, ...where }, select: { key: true, value: true } }),
    sub ? tx.packageLimit.findMany({ where: { packageId: sub.packageId, ...where }, select: { key: true, value: true } }) : Promise.resolve([]),
    tx.resellerLimitSetting.findMany({ where, select: { key: true, value: true } }),
  ]);
  const levels: Array<[Exclude<ResellerLimitSource, 'default' | 'exempt'>, Map<string, number | null>]> = [
    ['reseller', new Map(own.map((r) => [r.key, r.value]))],
    ['package', new Map(pkg.map((r) => [r.key, r.value]))],
    ['platform', new Map(platform.map((r) => [r.key, r.value]))],
  ];
  return keys.map((key) => {
    for (const [source, rows] of levels) {
      // A row, even a null one, is this level's answer: null is "no limit", on purpose.
      if (rows.has(key)) return { key, limit: rows.get(key) ?? null, source };
    }
    return { key, limit: RESELLER_LIMITS[key].default, source: 'default' as const };
  });
}

/** One more past the reseller's limit. Nothing was written; the figures say what to raise. */
export class ResellerLimitReached extends Error {
  readonly reason = 'reseller_limit_reached' as const;

  constructor(
    readonly key: ResellerLimitKey,
    readonly limit: number,
    readonly used: number,
  ) {
    super(`reseller limit reached: ${key} (${used} of ${limit})`);
    this.name = 'ResellerLimitReached';
  }

  /** As `error.facts`: flat, no text (`sanitizeError`). */
  get facts(): { key: ResellerLimitKey; limit: number; used: number } {
    return { key: this.key, limit: this.limit, used: this.used };
  }
}

/** Refuses one more when `used` is at or past the limit in effect; no limit passes. */
export function assertUnderLimit(key: ResellerLimitKey, inEffect: ResellerLimitInEffect, used: number): void {
  if (inEffect.limit !== null && used >= inEffect.limit) throw new ResellerLimitReached(key, inEffect.limit, used);
}
