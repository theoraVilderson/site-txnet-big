import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Grant, GrantSource, GrantStatus, Prisma, QuotaAdjustment, QuotaMetric, VariantBillingMode } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { isSellableBySku, type OfferFacts } from '../catalog/catalog-reads';
import { PrismaService } from '../prisma/prisma.service';

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
 * mint a token and keep only its hash.
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
  | 'grant_not_active';

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
  product: { featureKeys: string[] };
};

/**
 * The part of a Grant copied from its variant at issue, so a later catalog edit
 * never changes what was sold. A purchase is `pending` until it settles; any
 * other source is `active` at once.
 */
export function grantFromVariant(input: { source: GrantSource; startsAt: Date }, v: VariantShape) {
  return {
    status: input.source === GrantSource.purchase ? GrantStatus.pending : GrantStatus.active,
    startsAt: input.startsAt,
    endsAt: v.durationDays === null ? null : new Date(input.startsAt.getTime() + v.durationDays * DAY_MS),
    billingMode: v.billingMode,
    quotas: structuredClone(v.quotas),
    featureKeys: [...v.product.featureKeys],
  };
}

/** SHA-256 of a subscription token, lowercase hex — the only form ever stored. */
export const hashSubscriptionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** 32 random bytes as base64url, and its hash. The token is answered once and never written. */
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
  constructor(private readonly prisma: PrismaService) {}

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

    const variant = await tx.productVariant.findUnique({
      where: { id: input.variantId },
      include: { product: { include: { category: true } } },
    });
    if (!variant) throw new EntitlementRefused('variant_not_found', input.variantId);
    const facts: OfferFacts = {
      visibility: variant.visibility,
      isActive: variant.isActive,
      productActive: variant.product.isActive,
      categoryActive: variant.product.category.isActive,
    };
    if (!assignable(input.source, facts)) throw new EntitlementRefused('variant_not_assignable', input.variantId);

    const { token, hash } = newSubscriptionToken();
    const shape = grantFromVariant({ source: input.source, startsAt: input.startsAt ?? new Date() }, variant);
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
    await tx.grant.update({ where: { id: grantId }, data: { subscriptionTokenHash: hash, tokenRotatedAt: new Date() } });
    return token;
  }
}
