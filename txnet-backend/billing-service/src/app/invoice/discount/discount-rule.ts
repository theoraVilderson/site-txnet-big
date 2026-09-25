import { DiscountRuleKind, Prisma } from '@prisma/client';
import { categoryChainInclude } from '@txnet-backend/shared-core';

/**
 * A discount with no code (F-114-h, D-45, ADR-0087): which rule a purchase
 * takes, and what it takes.
 *
 * A rule is one tenant's own (RLS). It covers everything, one product, or one
 * category **and the categories under it**; it serves everyone, or its named
 * users; it runs from `startsAt` to `endsAt` (exclusive; null = until switched
 * off). Of every rule that matches, the one that takes the most wins — rules
 * never stack — and a tie goes to the older rule, so the same purchase is
 * priced the same twice. Coupons are then validated against what it left.
 *
 * A time-boxed campaign price is not this: that is a new catalog price row
 * (F-503-a), never a rule.
 */

/** Same scale as every money column (C-02). */
const MONEY_SCALE = 2;

export type DiscountRuleFacts = {
  id: string;
  name: string;
  kind: DiscountRuleKind;
  value: Prisma.Decimal;
  productId: string | null;
  categoryId: string | null;
  forNamedUsers: boolean;
  /** For a `forNamedUsers` rule: its users, or at least the buyer if named. */
  userIds: readonly string[];
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  createdAt: Date;
};

export type PurchaseFacts = {
  userId: string;
  productId: string;
  /** Every category the product is filed in, and every one above each. */
  categoryIds: readonly string[];
  at: Date;
};

export type ChosenRule = { rule: DiscountRuleFacts; discount: Prisma.Decimal };

export function ruleMatches(rule: DiscountRuleFacts, p: PurchaseFacts): boolean {
  if (!rule.isActive) return false;
  const at = p.at.getTime();
  if (rule.startsAt.getTime() > at) return false;
  if (rule.endsAt && rule.endsAt.getTime() <= at) return false;
  if (rule.productId !== null && rule.productId !== p.productId) return false;
  if (rule.categoryId !== null && !p.categoryIds.includes(rule.categoryId)) return false;
  if (rule.forNamedUsers && !rule.userIds.includes(p.userId)) return false;
  return true;
}

/** What `rule` takes from `amount`: a percentage down to the cent, never more than `amount`. */
export function ruleDiscountOf(rule: DiscountRuleFacts, amount: Prisma.Decimal): Prisma.Decimal {
  const d =
    rule.kind === DiscountRuleKind.percentage
      ? // Down to the cent: a discount rounded up would give away money no rule granted.
        amount.mul(rule.value).div(100).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_DOWN)
      : rule.value;
  return d.gt(amount) ? amount : d;
}

export function bestDiscountRule(rules: readonly DiscountRuleFacts[], p: PurchaseFacts, amount: Prisma.Decimal): ChosenRule | null {
  if (amount.lte(0)) return null;
  let best: ChosenRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, p)) continue;
    const discount = ruleDiscountOf(rule, amount);
    if (discount.lte(0)) continue;
    if (
      !best ||
      discount.gt(best.discount) ||
      (discount.eq(best.discount) && (rule.createdAt.getTime() < best.rule.createdAt.getTime() || (rule.createdAt.getTime() === best.rule.createdAt.getTime() && rule.id < best.rule.id)))
    ) {
      best = { rule, discount };
    }
  }
  return best;
}

type CategoryWithChain = { id: string; parent?: CategoryWithChain | null };

/** A category's id and every id above it, as `categoryChainInclude` loaded them. */
function chainIds(c: CategoryWithChain | null | undefined, out: Set<string>): void {
  for (let x = c; x; x = x.parent) out.add(x.id);
}

/**
 * The rule `userId`'s purchase of `productId` takes at `amount`, read in the
 * caller's `tenantTransaction` — RLS shows only this tenant's rules.
 */
export async function discountRuleFor(
  tx: Prisma.TransactionClient,
  purchase: { userId: string; productId: string; at: Date },
  amount: Prisma.Decimal,
): Promise<ChosenRule | null> {
  if (amount.lte(0)) return null;
  const { at, userId, productId } = purchase;
  const rows = await tx.discountRule.findMany({
    where: { isActive: true, startsAt: { lte: at }, OR: [{ endsAt: null }, { endsAt: { gt: at } }] },
    include: { users: { where: { userId }, select: { userId: true } } },
  });
  if (rows.length === 0) return null;

  const links = await tx.productCategoryLink.findMany({
    where: { productId },
    include: { category: { include: categoryChainInclude() } },
  });
  const categoryIds = new Set<string>();
  for (const l of links) chainIds(l.category as CategoryWithChain, categoryIds);

  const facts = rows.map((r) => ({ ...r, userIds: r.users.map((u) => u.userId) }));
  return bestDiscountRule(facts, { userId, productId, categoryIds: [...categoryIds], at }, amount);
}
