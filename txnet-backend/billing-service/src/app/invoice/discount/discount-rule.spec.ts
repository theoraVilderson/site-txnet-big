/**
 * A discount with no code (F-114-h, D-45, ADR-0087).
 *
 * What would break silently here, and nowhere else:
 *  - a rule outside its window, switched off, on another product or category,
 *    or naming other users takes nothing — a mistake here gives money away on
 *    every invoice of the tenant, with no code to notice it by;
 *  - a category rule covers the categories under it too, as a switched-off
 *    parent hides its subtree (`category-tree.ts`);
 *  - of several that match, the one that takes the most wins, and only it —
 *    rules never stack, so no two campaigns add up to more than either meant;
 *  - a percentage rounds down to the cent and a fixed amount never takes more
 *    than the price, as a coupon's does;
 *  - an admin writes only their own tenant's rules, naming only their own
 *    users and products they can see, and every write leaves an audit row.
 */
import { DiscountRuleKind, Prisma } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { DiscountRuleAdminService, DiscountRuleRefused } from './discount-rule-admin.service';
import { DiscountRuleFacts, PurchaseFacts, bestDiscountRule, ruleDiscountOf, ruleMatches } from './discount-rule';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '33333333-3333-4333-8333-333333333334';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const OTHER_PRODUCT = '44444444-4444-4444-8444-444444444445';
const PARENT_CATEGORY = '55555555-5555-4555-8555-555555555551';
const CATEGORY = '55555555-5555-4555-8555-555555555552';

const D = (v: string) => new Prisma.Decimal(v);
const AT = new Date('2026-09-25T12:00:00Z');

function rule(o: Partial<DiscountRuleFacts> = {}): DiscountRuleFacts {
  return {
    id: 'r1',
    name: 'Autumn',
    kind: DiscountRuleKind.percentage,
    value: D('10'),
    productId: null,
    categoryId: null,
    forNamedUsers: false,
    userIds: [],
    startsAt: new Date('2026-09-01T00:00:00Z'),
    endsAt: null,
    isActive: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...o,
  };
}

const purchase: PurchaseFacts = { userId: USER, productId: PRODUCT, categoryIds: [CATEGORY, PARENT_CATEGORY], at: AT };

describe('ruleMatches', () => {
  it('a rule for everything and everyone matches inside its window', () => {
    expect(ruleMatches(rule(), purchase)).toBe(true);
  });

  it.each([
    ['not started', rule({ startsAt: new Date('2026-09-26T00:00:00Z') })],
    ['ended — the end is exclusive', rule({ endsAt: AT })],
    ['switched off', rule({ isActive: false })],
    ['another product', rule({ productId: OTHER_PRODUCT })],
    ['a category the product is not under', rule({ categoryId: '55555555-5555-4555-8555-555555555559' })],
    ['other named users', rule({ forNamedUsers: true, userIds: [OTHER_USER] })],
    ['named users, none listed', rule({ forNamedUsers: true, userIds: [] })],
  ])('takes nothing when %s', (_why, r) => {
    expect(ruleMatches(r, purchase)).toBe(false);
  });

  it('matches its product, its category, a category above the product, and a named user', () => {
    expect(ruleMatches(rule({ productId: PRODUCT }), purchase)).toBe(true);
    expect(ruleMatches(rule({ categoryId: CATEGORY }), purchase)).toBe(true);
    expect(ruleMatches(rule({ categoryId: PARENT_CATEGORY }), purchase)).toBe(true);
    expect(ruleMatches(rule({ forNamedUsers: true, userIds: [OTHER_USER, USER] }), purchase)).toBe(true);
  });
});

describe('ruleDiscountOf', () => {
  it('rounds a percentage down to the cent', () => {
    expect(ruleDiscountOf(rule({ value: D('15') }), D('12.99')).toFixed(2)).toBe('1.94');
  });

  it('never takes more than the price', () => {
    expect(ruleDiscountOf(rule({ kind: DiscountRuleKind.fixed_amount, value: D('20') }), D('12.50')).toFixed(2)).toBe('12.50');
    expect(ruleDiscountOf(rule({ value: D('100') }), D('12.50')).toFixed(2)).toBe('12.50');
  });
});

describe('bestDiscountRule', () => {
  it('picks the one matching rule that takes the most — rules never stack', () => {
    const best = bestDiscountRule(
      [
        rule({ id: 'pct', value: D('10') }),
        rule({ id: 'fixed', kind: DiscountRuleKind.fixed_amount, value: D('2.00'), productId: PRODUCT }),
        rule({ id: 'bigger-but-elsewhere', value: D('50'), productId: OTHER_PRODUCT }),
      ],
      purchase,
      D('12.50'),
    );
    expect(best?.rule.id).toBe('fixed');
    expect(best?.discount.toFixed(2)).toBe('2.00');
  });

  it('breaks a tie by the older rule, so the same invoice twice is priced the same', () => {
    const best = bestDiscountRule(
      [rule({ id: 'newer', createdAt: new Date('2026-09-10T00:00:00Z') }), rule({ id: 'older', createdAt: new Date('2026-09-02T00:00:00Z') })],
      purchase,
      D('10.00'),
    );
    expect(best?.rule.id).toBe('older');
  });

  it('answers null when nothing matches, or when the price is zero', () => {
    expect(bestDiscountRule([rule({ productId: OTHER_PRODUCT })], purchase, D('10.00'))).toBeNull();
    expect(bestDiscountRule([rule()], purchase, D('0'))).toBeNull();
  });
});

describe('DiscountRuleAdminService', () => {
  const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
  const actor = { adminId: ADMIN, tenantId: TENANT, ip: '203.0.113.9' };

  function build(o: { products?: string[]; categories?: string[]; users?: Array<{ id: string; tenantId: string }> } = {}) {
    const audits: Array<Record<string, unknown>> = [];
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: async () => 0,
      product: { findFirst: async ({ where }: { where: { id: string } }) => ((o.products ?? [PRODUCT]).includes(where.id) ? { id: where.id } : null) },
      productCategory: {
        findFirst: async ({ where }: { where: { id: string } }) => ((o.categories ?? [CATEGORY]).includes(where.id) ? { id: where.id } : null),
      },
      user: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          (o.users ?? [{ id: USER, tenantId: TENANT }]).filter((u) => where.id.in.includes(u.id)),
      },
      discountRule: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: 'new-rule', createdAt: AT, updatedAt: AT, ...data };
          created.push(row);
          return row;
        },
        findUnique: async () => ({ ...created[0], users: [] }),
      },
      discountRuleUser: { createMany: async () => ({ count: 1 }), deleteMany: async () => ({ count: 0 }) },
      adminAuditLog: { create: async ({ data }: { data: Record<string, unknown> }) => audits.push(data) },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    return { service: new DiscountRuleAdminService(prisma as never), audits, created };
  }

  const base = { name: 'Autumn', kind: DiscountRuleKind.percentage, value: '10', startsAt: '2026-09-01T00:00:00Z' };

  it('creates a rule in the caller’s tenant, and audits it', async () => {
    const { service, audits, created } = build();
    const view = await asTenant(() => service.create(actor, { ...base, productId: PRODUCT, forNamedUsers: true, userIds: [USER] }));

    expect(created[0]).toMatchObject({ tenantId: TENANT, productId: PRODUCT, forNamedUsers: true, createdByAdminId: ADMIN });
    expect(view.userIds).toEqual([USER]);
    expect(audits).toEqual([expect.objectContaining({ tenantId: TENANT, adminId: ADMIN, action: 'discount_rule_create', targetEntityId: 'new-rule' })]);
  });

  it.each([
    ['a percentage above 100', { value: '101' }, 'invalid_value'],
    ['a fixed amount below a cent', { kind: DiscountRuleKind.fixed_amount, value: '0.001' }, 'invalid_value'],
    ['a product and a category at once', { productId: PRODUCT, categoryId: CATEGORY }, 'one_target'],
    ['an end not after the start', { endsAt: '2026-09-01T00:00:00Z' }, 'invalid_window'],
    ['named users, none given', { forNamedUsers: true, userIds: [] }, 'named_needs_users'],
    ['a product this tenant cannot see', { productId: OTHER_PRODUCT }, 'target_not_found'],
    ['a user of another tenant', { forNamedUsers: true, userIds: [OTHER_USER] }, 'user_out_of_scope'],
  ])('refuses %s, writing nothing', async (_why, patch, reason) => {
    const { service, audits, created } = build({ users: [{ id: OTHER_USER, tenantId: '22222222-2222-4222-8222-222222222222' }] });
    const run = asTenant(() => service.create(actor, { ...base, ...patch } as never));
    await expect(run).rejects.toBeInstanceOf(DiscountRuleRefused);
    await expect(run).rejects.toMatchObject({ reason });
    expect(created).toEqual([]);
    expect(audits).toEqual([]);
  });
});
