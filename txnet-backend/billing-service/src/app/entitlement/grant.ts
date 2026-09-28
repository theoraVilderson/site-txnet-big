import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigStatus, Grant, GrantSource, GrantStatus, Prisma, QuotaAdjustment, QuotaMetric, VariantBillingMode } from '@prisma/client';
import { TenantContext, evaluateLineNameTemplate, meteredRatesInEffect, productCategoriesInclude, productCategoriesLive, tenantTransaction } from '@txnet-backend/shared-core';

import { isSellableBySku, meteredRateAt, type MeteredRateRow, type OfferFacts } from '../catalog/catalog-reads';
import { trafficQuotaOf } from '../catalog/traffic-quota';
import { PrismaService } from '../prisma/prisma.service';
import { GrantTokenSeal, NO_TOKEN_SEAL, type SealedToken } from './grant-token-seal';
import { ADMIN_FROZEN } from './suspension';
import { unusedClockOf } from './unused-clock';
import { configIdentityOf, storedLineIdentity } from '../traffic/config-identity';
import { foldConfigText } from '../traffic/config-text';

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
  | 'metered_rate_not_positive'
  /** Renewal (F-027-dg): only an `active` Grant, or one `suspended`, is renewed in place. */
  | 'grant_not_renewable'
  /** Renewal: bytes on a metered Grant (its blocks buy them) or an unlimited one. */
  | 'traffic_not_renewable'
  /** Renewal: neither bytes nor days. */
  | 'nothing_to_renew'
  /** Renewal or unfreeze: the Grant's Quota or end moved between the read and the write; retry. */
  | 'grant_moved'
  /** Unfreeze (F-311-h): the Grant is not frozen — never a suspension for quota, which a top-up lifts. */
  | 'grant_not_frozen'
  /** Freeze: an unfreeze time that has already come. */
  | 'freeze_until_not_future'
  /** Days (F-311-i): expired, exhausted or cancelled — only a renewal brings it back (§4.4). */
  | 'grant_closed'
  /** Traffic (F-311-j): a metered Grant (its blocks buy its bytes) or an unlimited one has no bag an admin moves. */
  | 'traffic_not_adjustable'
  /** Gift (F-311-l): only a metered, limited Grant takes gifted bytes — a prepaid bag is moved by Traffic. */
  | 'grant_not_metered'
  /** Traffic: a cut past zero — a Quota is never negative. */
  | 'quota_below_zero'
  /** Traffic reset (F-311-k): nothing used since the last reset — the full bag is already left. */
  | 'nothing_to_reset'
  /** Days: a permanent Grant has no end to move. */
  | 'grant_permanent'
  /** Days: the new end is now or earlier — cutting a service off is a delete (F-311-m). */
  | 'duration_end_not_future'
  /** Days: the new end is the end it has. */
  | 'duration_unchanged'
  /** Admin issue (F-311-o): nothing could deliver it — no handler, no placeable group, no stated traffic. */
  | 'variant_not_deliverable'
  /** Admin issue or renewal: this request id already issued a Grant to another user or variant, or renewed another Grant. */
  | 'request_reused'
  /** Admin renewal (F-311-d): a dated Grant with no copied plan period — the admin types the amount. */
  | 'plan_period_unknown'
  /** Admin renewal: a concurrent repeat of the same request won; retry to read its renewal. */
  | 'already_renewed';

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
 * `purchasedBytes` is the bag the lease planner splits into panel ceilings
 * (ADR-0072). A prepaid package *is* a bag with a fixed ceiling, so it is
 * filled here with the sold `traffic_bytes` limit; a metered Grant starts
 * empty and buys blocks. Left at 0, a prepaid config is born with a 0-byte
 * ceiling, never placed on its panel, and refunded by the delivery clock.
 *
 * A prepaid variant sold with `traffic_bytes.limit = 0` is unlimited
 * (F-111-q): the bag stays 0 and `trafficUnlimited` says why, so nothing
 * downstream ever reads 0 as unlimited — to the lease planner and to exhaustion
 * 0 is empty.
 */
export function grantFromVariant(input: { source: GrantSource; startsAt: Date }, v: VariantShape) {
  // A metered Grant's traffic is what its blocks buy, never the variant's.
  const traffic = v.billingMode === VariantBillingMode.prepaid ? trafficQuotaOf(v.quotas) : null;
  return {
    status: input.source === GrantSource.purchase ? GrantStatus.pending : GrantStatus.active,
    startsAt: input.startsAt,
    endsAt: v.durationDays === null ? null : new Date(input.startsAt.getTime() + v.durationDays * DAY_MS),
    periodDays: v.durationDays,
    billingMode: v.billingMode,
    quotas: structuredClone(v.quotas),
    featureKeys: [...v.product.featureKeys],
    meteredRate: v.billingMode === VariantBillingMode.metered ? (meteredRateAt(v.meteredRates, input.startsAt)?.rate ?? null) : null,
    purchasedBytes: traffic?.kind === 'limited' ? traffic.bytes : BigInt(0),
    trafficUnlimited: traffic?.kind === 'unlimited',
  };
}

/** SHA-256 of a subscription token, lowercase hex — what `/sub` looks a Grant up by. */
export const hashSubscriptionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** `/sub/{token}` in a pasted link, whatever its host (a reseller's own domain), trailing `/` or query. */
const SUB_PATH = /^https?:\/\/[^/?#\s]+\/sub\/([A-Za-z0-9_-]{16,})\/?(?:[?#]|$)/i;

/** The token of a pasted subscription link (F-307-r), or `null` for any other line. */
export function subscriptionTokenOf(pasted: string): string | null {
  return SUB_PATH.exec(pasted.trim())?.[1] ?? null;
}

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
  /** Sold with unlimited traffic (F-111-q): `purchasedBytes` is 0 and bounds nothing. */
  trafficUnlimited: boolean;
  /**
   * A capped prepaid Grant's traffic cap, as a decimal string: the quota's
   * `limit` plus its unexpired `traffic_bytes` adjustments — the `total` `/sub`
   * gives the app (F-111-t). `null` for metered, unlimited or no quota.
   */
  trafficCapBytes: string | null;
  /** When the bag ran empty; `null` unless the Grant is suspended (ADR-0075). */
  suspendedAt: string | null;
  /** When the purge releases its panel seats; `null` when nothing is due — not suspended, frozen (never purged), or a window of `0` (never). */
  purgeAt: string | null;
  /** An admin froze it (F-311-h): `suspended`, kept, its clock stopped. */
  frozen: boolean;
  /** When a timed freeze ends by itself; `null` when not frozen or frozen until the admin unfreezes it. */
  frozenUntil: string | null;
  /**
   * When traffic last moved, to within one usage push (F-307-u): metering's
   * `usagePushedAt`, which only a charged, non-zero delta writes, at most once
   * per 30 s. `null` when nothing was ever charged. What the panel's "in use"
   * reads on first paint, before the socket has pushed anything.
   */
  lastTrafficAt: string | null;
};

/** `hidden`: the user's Grants the scope left out — 0 on `all` (user, 2026-09-26). */
export type GrantPage = { total: number; page: number; pageSize: number; hidden: number; rows: GrantView[] };

/** Which of a user's Grants the list answers: `current` by default, `all` on request. */
export const GRANT_LIST_SCOPES = ['current', 'all'] as const;
export type GrantListScope = (typeof GRANT_LIST_SCOPES)[number];

/**
 * The statuses `current` leaves out: a Grant that will never serve again and
 * that no action of the user's brings back — `cancelled` (delivery failed, the
 * money went back) and `exhausted`. `suspended` stays, because a top-up revives
 * it and its purge countdown is what the user must see; `expired` stays because
 * the user asked for it (2026-09-26).
 */
export const SETTLED_GRANT_STATUSES: readonly GrantStatus[] = [GrantStatus.cancelled, GrantStatus.exhausted];

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
  trafficUnlimited: true,
  quotas: true,
  suspendedAt: true,
  statusReason: true,
  frozenUntil: true,
  purgeAfterDays: true,
  usagePushedAt: true,
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

type GrantViewRow = Prisma.GrantGetPayload<{ select: typeof GRANT_VIEW_COLUMNS }>;

/** The sold limit of a Grant that has a cap; `null` for metered, unlimited or no quota (F-111-t). */
/**
 * A live config whose name, as ADR-0089 gives it, holds `q`, case aside: its
 * buyer's label, else the tenant's template over its panel's region. The
 * default name is the same for every config of one region, so it is evaluated
 * here once per region and matched as a region list — the page stays one
 * query. The ` 2` numbering is not matched (it is a position, not a name), nor
 * a panel's own name where a template evaluates empty. `q` and a default name
 * are folded as a label is saved (F-307-o, `config-text.ts`), so either
 * keyboard's spelling finds either.
 */
async function configNamedLike(tx: Prisma.TransactionClient, userId: string, q: string): Promise<Prisma.ConfigWhereInput> {
  const live = { not: ConfigStatus.retired };
  const [branding, unlabelled] = await Promise.all([
    tx.tenantBranding.findUnique({
      where: { tenantId: TenantContext.current('grant list').id },
      select: { brandName: true, lineNameTemplate: true },
    }),
    tx.config.findMany({ where: { userId, status: live, userLabel: null }, select: { panel: { select: { region: true } } } }),
  ]);
  const folded = foldConfigText(q);
  const needle = folded.toLocaleLowerCase();
  const regions = [...new Set(unlabelled.map((c) => c.panel.region))].filter((region) =>
    foldConfigText(evaluateLineNameTemplate(branding?.lineNameTemplate ?? null, { brand: branding?.brandName ?? '', region }))
      .toLocaleLowerCase()
      .includes(needle),
  );
  return {
    status: live,
    OR: [{ userLabel: { contains: folded, mode: 'insensitive' } }, { userLabel: null, panel: { region: { in: regions } } }],
  };
}

/**
 * A live config of the user's that any pasted line is (F-307-p,
 * `config-identity.ts`): the uuid a line carries matched in the query, case
 * aside; a line with none compared with the configs' current captured lines,
 * `#name` left out of both. A captured line read from another client (a
 * regenerate not yet re-captured) is a dead link and matches nothing, as
 * `/sub` serves nothing from it. An empty result matches no Grant.
 */
async function configHoldingLines(tx: Prisma.TransactionClient, userId: string, pasted: readonly string[]): Promise<Prisma.ConfigWhereInput> {
  const live = { not: ConfigStatus.retired };
  const ids = pasted.map(configIdentityOf).filter((i) => i !== null);
  const uuids = [...new Set(ids.flatMap((i) => ('uuid' in i ? [i.uuid] : [])))];
  const lines = new Set(ids.flatMap((i) => ('line' in i ? [i.line] : [])));
  const OR: Prisma.ConfigWhereInput[] = [];
  if (uuids.length) OR.push({ uuid: { in: uuids, mode: 'insensitive' } });
  if (lines.size || !OR.length) {
    const stored = lines.size
      ? await tx.config.findMany({ where: { userId, status: live }, select: { id: true, uuid: true, linksUuid: true, linkLines: true } })
      : [];
    const held = stored.filter((c) => c.linksUuid !== null && c.linksUuid === c.uuid && c.linkLines.some((l) => lines.has(storedLineIdentity(l))));
    OR.push({ id: { in: held.map((c) => c.id) } });
  }
  return { status: live, OR };
}

/**
 * The caller's Grants any pasted line finds: a subscription link by its
 * token's hash (F-307-r), every other line through `configHoldingLines`. A
 * paste of config lines alone asks only the configs, as before.
 */
async function grantHoldingLines(tx: Prisma.TransactionClient, userId: string, pasted: readonly string[]): Promise<Prisma.GrantWhereInput> {
  const tokens = pasted.map(subscriptionTokenOf).filter((t) => t !== null);
  const lines = pasted.filter((l) => subscriptionTokenOf(l) === null);
  if (!tokens.length) return { userId, configs: { some: await configHoldingLines(tx, userId, lines) } };
  const OR: Prisma.GrantWhereInput[] = [{ subscriptionTokenHash: { in: [...new Set(tokens.map(hashSubscriptionToken))] } }];
  if (lines.length) OR.push({ configs: { some: await configHoldingLines(tx, userId, lines) } });
  return { userId, OR };
}

function soldLimitOf(r: GrantViewRow): bigint | null {
  if (r.billingMode !== VariantBillingMode.prepaid || r.trafficUnlimited) return null;
  const traffic = trafficQuotaOf(r.quotas);
  return traffic.kind === 'limited' ? traffic.bytes : null;
}

function grantViewOf(r: GrantViewRow, tenantPurgeDays: number | null, adjustedBytes = BigInt(0)): GrantView {
  const limit = soldLimitOf(r);
  const cap = limit === null ? null : limit + adjustedBytes;
  const suspended = r.status === GrantStatus.suspended ? r.suspendedAt : null;
  const frozen = r.status === GrantStatus.suspended && r.statusReason === ADMIN_FROZEN;
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
    trafficUnlimited: r.trafficUnlimited,
    trafficCapBytes: cap === null ? null : (cap > BigInt(0) ? cap : BigInt(0)).toString(),
    suspendedAt: suspended?.toISOString() ?? null,
    purgeAt: frozen ? null : (purgeAtOf(suspended, r.purgeAfterDays, tenantPurgeDays)?.toISOString() ?? null),
    frozen,
    frozenUntil: frozen ? (r.frozenUntil?.toISOString() ?? null) : null,
    lastTrafficAt: r.usagePushedAt?.toISOString() ?? null,
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
    // Born `active`, it is activated at its start (F-601-c); a purchase waits for `markDelivered`.
    const activatedAt = shape.status === GrantStatus.active ? startsAt : null;
    try {
      const grant = await tx.grant.create({
        data: {
          ...shape,
          activatedAt,
          unusedCheckAt: activatedAt && unusedClockOf(input.source, activatedAt),
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
   * **`current` by default, `all` on request** (user, 2026-09-26). A cancelled
   * or exhausted Grant is left out of the default page (`SETTLED_GRANT_STATUSES`)
   * and counted in `hidden`, so the reader can offer the rest — a key is shown
   * once (D-35) and a hidden Grant must stay one request away. The filter is
   * here, not in the reader, because a page of 20 filtered afterwards would
   * come back short or empty.
   *
   * **`q` keeps the Grants holding a live config named like it** (F-307-m):
   * `configNamedLike`. `hidden` then counts the ended Grants that match.
   * **`lines` keeps the Grants holding a config any pasted line is** (F-307-p):
   * `configHoldingLines`, the same way; it wins over `q`. A pasted
   * subscription link (`…/sub/{token}`, F-307-r) keeps the caller's Grant whose
   * current token it carries, by the token's hash — a reset link finds nothing,
   * as `/sub` serves nothing from it.
   */
  listForUser(
    userId: string,
    request: { page?: number; pageSize?: number; scope?: GrantListScope; q?: string; lines?: readonly string[] } = {},
  ): Promise<GrantPage> {
    const page = request.page ?? DEFAULT_PAGE;
    const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
    const all = request.scope === 'all';
    const q = request.q?.trim() ?? '';
    return tenantTransaction(this.prisma, async (tx) => {
      const mine: Prisma.GrantWhereInput = request.lines
        ? await grantHoldingLines(tx, userId, request.lines)
        : q === ''
          ? { userId }
          : { userId, configs: { some: await configNamedLike(tx, userId, q) } };
      const where: Prisma.GrantWhereInput = all ? mine : { ...mine, status: { notIn: [...SETTLED_GRANT_STATUSES] } };
      const [rows, total, everything] = await Promise.all([
        tx.grant.findMany({
          where,
          select: GRANT_VIEW_COLUMNS,
          // `id` breaks the tie: two Grants issued in one transaction share an
          // instant, and an unstable order repeats or skips one across pages.
          orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.grant.count({ where }),
        all ? null : tx.grant.count({ where: mine }),
      ]);
      const hidden = everything === null ? 0 : everything - total;
      // The tenant's window is read only when a row needs it: a suspended
      // Grant with no window of its own.
      const needsTenant = rows.some((r) => r.status === GrantStatus.suspended && r.statusReason !== ADMIN_FROZEN && r.purgeAfterDays === null);
      const tenant = needsTenant
        ? await tx.tenant.findUnique({ where: { id: TenantContext.current('grant list').id }, select: { purgeAfterDays: true } })
        : null;
      // A cap moves with its traffic adjustments (a rollover): one read for
      // the page, the same sum `/sub` makes, so the panel and the app agree.
      const capped = rows.filter((r) => soldLimitOf(r) !== null).map((r) => r.id);
      const sums = capped.length
        ? await tx.quotaAdjustment.groupBy({
            by: ['grantId'],
            where: { grantId: { in: capped }, metric: QuotaMetric.traffic_bytes, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            _sum: { delta: true },
          })
        : [];
      const adjusted = new Map(sums.map((s) => [s.grantId, s._sum.delta ?? BigInt(0)]));
      return { total, page, pageSize, hidden, rows: rows.map((r) => grantViewOf(r, tenant?.purgeAfterDays ?? null, adjusted.get(r.id))) };
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
