import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Grant, GrantSource, GrantStatus, Prisma, QuotaAdjustment, QuotaMetric, VariantBillingMode } from '@prisma/client';
import { TenantContext, meteredRatesInEffect, productCategoriesInclude, productCategoriesLive, tenantTransaction } from '@txnet-backend/shared-core';

import { isSellableBySku, meteredRateAt, type MeteredRateRow, type OfferFacts } from '../catalog/catalog-reads';
import { PrismaService } from '../prisma/prisma.service';
import { GrantTokenSeal, NO_TOKEN_SEAL, type SealedToken } from './grant-token-seal';

/**
 * Grant core (F-026-e; D-34, ADR-0049; spec: `tools/spec.py --section 4.4`).
 *
 * A user's access to anything is one question — does an active Grant with this
 * feature key exist — and this is the only code that writes a Grant. It runs
 * inside the **caller's** transaction (`issue`, `transition`, `adjustQuota`,
 * `rotateToken` take `tx`), so a `free_grant` coupon (F-502-l) or a settled
 * purchase issues its Grant atomically with the rest of its work.
 *
 * The database holds the same rules for every writer
 * (`entitlement-schema.int.spec.ts`); these refuse first, with a reason a
 * caller can act on, and do what a trigger cannot: copy a variant into a Grant,
 * mint a token and keep its hash, and a sealed copy My services can show
 * again (ADR-0085).
 */

/** Why a Grant operation was refused. Nothing was written. */
export type EntitlementRejection =
  | 'variant_not_found'
  /** Switched off, or `admin_only` for a purchase. */
  | 'variant_not_assignable'
  /** A concurrent issue for the same cause won; retry to read its Grant. */
  | 'already_issued'
  /** Unknown, another tenant's, or — for a token rotation — another user's. Never told apart. */
  | 'grant_not_found'
  | 'illegal_transition'
  | 'grant_not_active'
  /** A `metered` variant with no rate in effect at the sale: nothing would price its bytes (F-027-p). */
  | 'metered_rate_missing'
  /** The rate in effect is zero: a block priced at nothing cannot be bought, so the Grant would stall (F-027-al). */
  | 'metered_rate_not_positive';

export class EntitlementRefused extends Error {
  constructor(
    readonly reason: EntitlementRejection,
    detail = '',
  ) {
    super(`entitlement refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'EntitlementRefused';
  }
}

/** The moves `grant_status_one_way` allows; only `suspended → active` goes back (§4.4). */
const MOVES: Record<GrantStatus, readonly GrantStatus[]> = {
  pending: [GrantStatus.active, GrantStatus.cancelled],
  active: [GrantStatus.suspended, GrantStatus.exhausted, GrantStatus.expired, GrantStatus.cancelled],
  suspended: [GrantStatus.active, GrantStatus.exhausted, GrantStatus.expired, GrantStatus.cancelled],
  exhausted: [],
  expired: [],
  cancelled: [],
};

/** Staying put is not a move and is always allowed. */
export const canMove = (from: GrantStatus, to: GrantStatus): boolean => from === to || MOVES[from].includes(to);

/** Active at `at`: `status = active` and `startsAt <= at < endsAt`; a permanent Grant has no end. */
export function isActiveAt(g: Pick<Grant, 'status' | 'startsAt' | 'endsAt'>, at: Date): boolean {
  const t = at.getTime();
  return g.status === GrantStatus.active && g.startsAt.getTime() <= t && (g.endsAt === null || t < g.endsAt.getTime());
}

/**
 * Whether `source` may issue a Grant of this variant. A purchase buys what is
 * for sale — `public` or `unlisted`. An admin, a coupon, a trial or a rollover
 * may assign any live variant, `admin_only` included (F-506). Nothing is
 * assigned from a switched-off variant, product or category.
 */
export function assignable(source: GrantSource, v: OfferFacts): boolean {
  if (source === GrantSource.purchase) return isSellableBySku(v);
  return v.isActive && v.productActive && v.categoryActive;
}

const DAY_MS = 86_400_000;

type VariantShape = {
  billingMode: VariantBillingMode;
  quotas: Prisma.JsonValue;
  durationDays: number | null;
  /** The variant's rate history — only the rows that could be in effect need be here. */
  meteredRates: readonly MeteredRateRow[];
  product: { featureKeys: string[] };
};

/**
 * The part of a Grant copied from its variant at issue, so a later catalog edit
 * never changes what was sold. A purchase is `pending` until it settles; any
 * other source is `active` at once.
 *
 * `meteredRate` joins the quotas here (ADR-0073): the rate in effect at
 * `startsAt`, and `null` for anything not `metered` — `grant_metered_rate_is_metered`
 * refuses a rate on a prepaid Grant, and a rate nobody reads is a second answer
 * to what the user owes. A metered variant with no rate at all resolves to
 * `null` too; `issue` is what refuses that, with the variant in the message.
 *
 * `purchasedBytes` is the bag the allocator splits into panel ceilings
 * (ADR-0072). A prepaid package *is* a bag with a fixed ceiling, so it is
 * filled here with the sold `traffic_bytes` limit; a metered Grant starts
 * empty and buys blocks. Left at 0, a prepaid config is born with a 0-byte
 * ceiling, never placed on its panel, and refunded by the delivery clock.
 */
export function grantFromVariant(input: { source: GrantSource; startsAt: Date }, v: VariantShape) {
  return {
    status: input.source === GrantSource.purchase ? GrantStatus.pending : GrantStatus.active,
    startsAt: input.startsAt,
    endsAt: v.durationDays === null ? null : new Date(input.startsAt.getTime() + v.durationDays * DAY_MS),
    billingMode: v.billingMode,
    quotas: structuredClone(v.quotas),
    featureKeys: [...v.product.featureKeys],
    meteredRate: v.billingMode === VariantBillingMode.metered ? (meteredRateAt(v.meteredRates, input.startsAt)?.rate ?? null) : null,
    purchasedBytes: v.billingMode === VariantBillingMode.prepaid ? trafficLimitOf(v.quotas) : BigInt(0),
  };
}

/** The sold `traffic_bytes` limit, or 0 where the variant sells none. */
function trafficLimitOf(quotas: Prisma.JsonValue): bigint {
  const q = quotas as { traffic_bytes?: { limit?: unknown } } | null;
  const limit = q?.traffic_bytes?.limit;
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? BigInt(limit) : BigInt(0);
}

/** SHA-256 of a subscription token, lowercase hex — what `/sub` looks a Grant up by. */
export const hashSubscriptionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** 32 random bytes as base64url, and its hash. The token itself is written only sealed (ADR-0085). */
export function newSubscriptionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSubscriptionToken(token) };
}

export type IssueGrant = {
  userId: string;
  variantId: string;
  source: GrantSource;
  /** The payment, coupon redemption or admin action that issued it. One cause, one Grant. */
  sourceReferenceId?: string | null;
  /** Default now. */
  startsAt?: Date;
  issuedByAdminId?: string | null;
};

/** `token` is set only when this call wrote the Grant; a repeat for the same cause answers `null`. */
export type IssuedGrant = { grant: Grant; token: string | null };

/** One Grant as its own user reads it (F-502-r). Never the subscription key, never its hash. */
export type GrantView = {
  id: string;
  status: GrantStatus;
  startsAt: string;
  /** `null` = permanent. */
  endsAt: string | null;
  featureKeys: string[];
  /** `null` for a Grant issued without a catalog item (`migration`). `nameKey` is the variant's own wording, else its product's (§4.3). */
  variant: { id: string; sku: string; nameKey: string } | null;
  billingMode: VariantBillingMode;
  /** What the panels reported, in bytes, as a decimal string (F-027-ac). Measured, not charged. */
  consumedBytes: string;
  /** What has been bought, in bytes, as a decimal string: the bound every ceiling shares (ADR-0072). */
  purchasedBytes: string;
  /** When the bag ran empty; `null` unless the Grant is suspended (ADR-0075). */
  suspendedAt: string | null;
  /** When the purge releases its panel seats; `null` when nothing is due — not suspended, or a window of `0` (never). */
  purgeAt: string | null;
};

export type GrantPage = { total: number; page: number; pageSize: number; rows: GrantView[] };

/**
 * The columns a user's own list reads. Explicit, because the row beside them is
 * `subscriptionTokenHash`: a `select` is what keeps the hash of a live
 * credential — and whatever the schema grows next — out of a response nobody
 * re-read (F-502-r).
 */
const GRANT_VIEW_COLUMNS = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  featureKeys: true,
  variant: { select: { id: true, sku: true, nameKey: true, product: { select: { nameKey: true } } } },
  billingMode: true,
  consumedBytes: true,
  purchasedBytes: true,
  suspendedAt: true,
  purgeAfterDays: true,
} satisfies Prisma.GrantSelect;

/** What an absent page means, decided here and nowhere else; the schema bounds `pageSize` at 100 when it is sent. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/**
 * When a suspended Grant's seats are released (F-027-ac): `suspendedAt` plus
 * the window, where the window is the Grant's own `purgeAfterDays`, else the
 * tenant's, and `0` means never. The same resolution `purge.ts` makes in SQL,
 * so the countdown the panel shows is the instant the hourly job acts after.
 */
export function purgeAtOf(suspendedAt: Date | null, grantDays: number | null, tenantDays: number | null): Date | null {
  const days = grantDays ?? tenantDays;
  if (!suspendedAt || days === null || days <= 0) return null;
  return new Date(suspendedAt.getTime() + days * DAY_MS);
}

function grantViewOf(r: Prisma.GrantGetPayload<{ select: typeof GRANT_VIEW_COLUMNS }>, tenantPurgeDays: number | null): GrantView {
  const suspended = r.status === GrantStatus.suspended ? r.suspendedAt : null;
  return {
    id: r.id,
    status: r.status,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt?.toISOString() ?? null,
    featureKeys: r.featureKeys,
    variant: r.variant ? { id: r.variant.id, sku: r.variant.sku, nameKey: r.variant.nameKey ?? r.variant.product.nameKey } : null,
    billingMode: r.billingMode,
    consumedBytes: r.consumedBytes.toString(),
    purchasedBytes: r.purchasedBytes.toString(),
    suspendedAt: suspended?.toISOString() ?? null,
    purgeAt: purgeAtOf(suspended, r.purgeAfterDays, tenantPurgeDays)?.toISOString() ?? null,
  };
}

export type AdjustQuota = {
  grantId: string;
  metric: QuotaMetric;
  delta: bigint;
  source: GrantSource;
  capPercent?: number | null;
  expiresAt?: Date | null;
  reason?: string | null;
  createdByAdminId?: string | null;
};

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

@Injectable()
export class GrantService {
  constructor(
    private readonly prisma: PrismaService,
    // Defaulted so a spec or script that builds the service by hand needs no KEK.
    private readonly tokens: GrantTokenSeal = NO_TOKEN_SEAL,
  ) {}

  /**
   * Issues a Grant of a variant to a user of the caller's tenant, or answers the
   * one already issued for the same `(source, sourceReferenceId)` with no token.
   */
  async issue(tx: Prisma.TransactionClient, input: IssueGrant): Promise<IssuedGrant> {
    const tenant = TenantContext.current('grant issue');
    const reference = input.sourceReferenceId ?? null;

    if (reference) {
      const existing = await tx.grant.findFirst({ where: { source: input.source, sourceReferenceId: reference } });
      if (existing) return { grant: existing, token: null };
    }

    const startsAt = input.startsAt ?? new Date();
    const variant = await tx.productVariant.findUnique({
      where: { id: input.variantId },
      // The rate history comes back with the variant — one round trip, and the
      // rows are narrowed to those that could be in effect at the sale.
      include: { product: { include: productCategoriesInclude }, meteredRates: { where: meteredRatesInEffect(startsAt) } },
    });
    if (!variant) throw new EntitlementRefused('variant_not_found', input.variantId);
    const facts: OfferFacts = {
      visibility: variant.visibility,
      isActive: variant.isActive,
      productActive: variant.product.isActive,
      categoryActive: productCategoriesLive(variant.product.categories),
    };
    if (!assignable(input.source, facts)) throw new EntitlementRefused('variant_not_assignable', input.variantId);

    const { token, hash } = newSubscriptionToken();
    const shape = grantFromVariant({ source: input.source, startsAt }, variant);
    // A metered variant with no rate in effect is not sold — never at zero by
    // default, exactly as a variant with no price is not for sale (ADR-0073).
    if (variant.billingMode === VariantBillingMode.metered && shape.meteredRate === null) {
      throw new EntitlementRefused('metered_rate_missing', input.variantId);
    }
    // Nor at a rate of zero. `sizeBlock` refuses one too (`rate_not_priceable`,
    // F-027-q), but there it is a user stalled mid-session far from whoever
    // priced the variant; the sale is the last point the two are one act
    // (F-027-al). `metered_rate_is_positive` holds the same line in the column.
    if (shape.meteredRate !== null && shape.meteredRate.lte(0)) {
      throw new EntitlementRefused('metered_rate_not_positive', input.variantId);
    }
    try {
      const grant = await tx.grant.create({
        data: {
          ...shape,
          quotas: shape.quotas as Prisma.InputJsonValue,
          tenantId: tenant.id,
          userId: input.userId,
          variantId: variant.id,
          source: input.source,
          sourceReferenceId: reference,
          issuedByAdminId: input.issuedByAdminId ?? null,
          subscriptionTokenHash: hash,
          subscriptionTokenSealed: this.sealed(token),
        },
      });
      return { grant, token };
    } catch (e) {
      // Postgres aborts the transaction on a unique violation, so the winner
      // cannot be read back here; the caller's retry reads it above.
      if (reference && isUniqueViolation(e)) throw new EntitlementRefused('already_issued', reference);
      throw e;
    }
  }

  /** Moves a Grant, or refuses the moves the trigger refuses. Staying put is a no-op. */
  async transition(tx: Prisma.TransactionClient, grantId: string, to: GrantStatus, reason: string | null = null): Promise<Grant> {
    const grant = await tx.grant.findUnique({ where: { id: grantId } });
    if (!grant) throw new EntitlementRefused('grant_not_found', grantId);
    if (!canMove(grant.status, to)) throw new EntitlementRefused('illegal_transition', `${grant.status} -> ${to}`);
    if (grant.status === to) return grant;
    return tx.grant.update({ where: { id: grantId }, data: { status: to, statusReason: reason } });
  }

  /** The user's active Grant carrying `featureKey` at `at` — the longest-lasting one — or `null`. */
  activeGrant(userId: string, featureKey: string, at: Date = new Date()): Promise<Grant | null> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.grant.findMany({
        where: {
          userId,
          status: GrantStatus.active,
          featureKeys: { has: featureKey },
          startsAt: { lte: at },
          OR: [{ endsAt: null }, { endsAt: { gt: at } }],
        },
        orderBy: [{ endsAt: { sort: 'desc', nulls: 'first' } }],
        take: 1,
      });
      return rows.find((g) => isActiveAt(g, at)) ?? null;
    });
  }

  /** The golden rule (§4.4): access is an active Grant with this feature key, and nothing else. */
  async hasActiveGrant(userId: string, featureKey: string, at: Date = new Date()): Promise<boolean> {
    return (await this.activeGrant(userId, featureKey, at)) !== null;
  }

  /**
   * One page of a user's own Grants (F-502-r), newest period first — the list
   * the panel's "my services" page reads.
   *
   * **Every Grant, whatever its status.** A key is shown once (D-35) and the
   * reissue route (F-502-p) is the only way back, so a list that hid an
   * expired or suspended Grant would hide exactly the row a user came looking
   * for. The status is answered and the reader decides what to do with it.
   */
  listForUser(userId: string, request: { page?: number; pageSize?: number } = {}): Promise<GrantPage> {
    const page = request.page ?? DEFAULT_PAGE;
    const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
    return tenantTransaction(this.prisma, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.grant.findMany({
          where: { userId },
          select: GRANT_VIEW_COLUMNS,
          // `id` breaks the tie: two Grants issued in one transaction share an
          // instant, and an unstable order repeats or skips one across pages.
          orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.grant.count({ where: { userId } }),
      ]);
      // The tenant's window is read only when a row needs it: a suspended
      // Grant with no window of its own.
      const needsTenant = rows.some((r) => r.status === GrantStatus.suspended && r.purgeAfterDays === null);
      const tenant = needsTenant
        ? await tx.tenant.findUnique({ where: { id: TenantContext.current('grant list').id }, select: { purgeAfterDays: true } })
        : null;
      return { total, page, pageSize, rows: rows.map((r) => grantViewOf(r, tenant?.purgeAfterDays ?? null)) };
    });
  }

  /** Adds a signed change to one quota of an active Grant. History: never edited afterwards. */
  async adjustQuota(tx: Prisma.TransactionClient, input: AdjustQuota): Promise<QuotaAdjustment> {
    const grant = await tx.grant.findUnique({ where: { id: input.grantId }, select: { status: true, tenantId: true } });
    if (!grant) throw new EntitlementRefused('grant_not_found', input.grantId);
    if (grant.status !== GrantStatus.active) throw new EntitlementRefused('grant_not_active', `${input.grantId} is ${grant.status}`);
    return tx.quotaAdjustment.create({
      data: {
        tenantId: grant.tenantId,
        grantId: input.grantId,
        metric: input.metric,
        delta: input.delta,
        source: input.source,
        capPercent: input.capPercent ?? null,
        expiresAt: input.expiresAt ?? null,
        reason: input.reason ?? null,
        createdByAdminId: input.createdByAdminId ?? null,
      },
    });
  }

  /**
   * `rotateToken` in a transaction of its own, for a caller with no other work
   * to commit with it (F-502-p). Every other writer here takes the caller's
   * `tx` because it has one; a route that only rotates would otherwise open
   * one at the call site and get the tenant scoping wrong.
   */
  rotateTokenForUser(grantId: string, userId: string): Promise<string> {
    return tenantTransaction(this.prisma, (tx) => this.rotateToken(tx, grantId, userId));
  }

  /** A new subscription token for the Grant's own user, answered once; the old link stops working. */
  async rotateToken(tx: Prisma.TransactionClient, grantId: string, userId: string): Promise<string> {
    const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { userId: true } });
    // Another user's Grant is answered exactly as a missing one.
    if (!grant || grant.userId !== userId) throw new EntitlementRefused('grant_not_found', grantId);
    const { token, hash } = newSubscriptionToken();
    await tx.grant.update({
      where: { id: grantId },
      data: { subscriptionTokenHash: hash, subscriptionTokenSealed: this.sealed(token), tokenRotatedAt: new Date() },
    });
    return token;
  }

  /** `subscriptionTokenFor` in a transaction of its own, as `rotateTokenForUser` is. */
  subscriptionTokenForUser(grantId: string, userId: string): Promise<string | null> {
    return tenantTransaction(this.prisma, (tx) => this.subscriptionTokenFor(tx, grantId, userId));
  }

  /**
   * The Grant's current token, for its own user, as often as asked (ADR-0085).
   * `null` when none is kept: a Grant from before the sealed column, or one issued
   * with no KEK loaded. Resetting its link (`rotateToken`) keeps one from then on.
   */
  async subscriptionTokenFor(tx: Prisma.TransactionClient, grantId: string, userId: string): Promise<string | null> {
    const grant = await tx.grant.findUnique({
      where: { id: grantId },
      select: { userId: true, subscriptionTokenHash: true, subscriptionTokenSealed: true },
    });
    // Another user's Grant is answered exactly as a missing one.
    if (!grant || grant.userId !== userId) throw new EntitlementRefused('grant_not_found', grantId);
    if (!grant.subscriptionTokenSealed) return null;
    // The shape is held by `grant_token_sealed_shape`, so the JSON is read as one.
    const token = this.tokens.open(grant.subscriptionTokenSealed as unknown as SealedToken);
    // `/sub` finds the Grant by the hash; a sealed copy that disagrees would hand
    // out a link to another Grant, or to none. Refuse loudly instead.
    if (hashSubscriptionToken(token) !== grant.subscriptionTokenHash) {
      throw new Error(`Grant ${grantId}: the sealed subscription token does not match its hash.`);
    }
    return token;
  }

  /** `Prisma.DbNull` when nothing is sealed: a JSON column is told apart from JSON `null`. */
  private sealed(token: string): Prisma.InputJsonObject | typeof Prisma.DbNull {
    const sealed = this.tokens.seal(token);
    return sealed ? { ...sealed } : Prisma.DbNull;
  }
}
