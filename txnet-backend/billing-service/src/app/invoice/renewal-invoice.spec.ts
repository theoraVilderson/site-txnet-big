/**
 * What a user's renewal invoice may name, and what it adds (F-305-c,
 * billing contract.renewal.md rules 1–4 and 6, ADR-0158).
 *
 * What would break silently here, and nowhere else:
 *  - the bag and days are the plan's as it is **now**, never the Grant's copy
 *    from its issue (rule 2): the price is today's, so the bag is too;
 *  - a renewal is never refused for what only stops a *new* service —
 *    `admin_only`, `unlisted`, sold out — but always for a plan off its own
 *    product, its own panel group or its own billing mode (rule 3, invariant 31);
 *  - only the limited part is sold (rule 6): a metered or unlimited Grant buys
 *    days, a permanent one bytes, and a plan whose shape the Grant cannot take
 *    is refused rather than charged for what renewGrant would drop.
 */
import { FulfilmentKind, GrantStatus, VariantBillingMode, VariantVisibility } from '@prisma/client';

import { CatalogOffer, isRenewable } from '../catalog/catalog-reads';
import { RenewableGrant, RenewalRefused, renewalOf } from './renewal-invoice';

const GIB = 1024 ** 3;
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const GROUP = '88888888-8888-4888-8888-888888888888';
const OWN_PLAN = '55555555-5555-4555-8555-555555555551';
const BIGGER_PLAN = '55555555-5555-4555-8555-555555555552';

const grant = (o: Partial<RenewableGrant> = {}): RenewableGrant => ({
  id: '99999999-9999-4999-8999-999999999999',
  status: GrantStatus.active,
  variantId: OWN_PLAN,
  productId: PRODUCT,
  panelGroupId: GROUP,
  billingMode: VariantBillingMode.prepaid,
  trafficUnlimited: false,
  endsAt: new Date('2026-11-01T00:00:00Z'),
  ...o,
});

const traffic = (limit: number) => ({ traffic_bytes: { limit, resetPolicy: 'none' } });

const plan = (o: Partial<CatalogOffer> = {}): CatalogOffer => ({
  variantId: OWN_PLAN,
  sku: 'VPN-30',
  tenantId: '11111111-1111-4111-8111-111111111111',
  nameKey: 'catalog.product.vpn.name',
  productId: PRODUCT,
  productNameKey: 'catalog.product.vpn.name',
  productKey: 'vpn',
  descriptionKey: null,
  categoryKey: 'vpn',
  categories: [],
  fulfilmentKind: FulfilmentKind.network_access,
  featureKeys: ['vpn'],
  quotas: traffic(60 * GIB),
  durationDays: 30,
  billingMode: VariantBillingMode.prepaid,
  qualityTier: 'standard',
  visibility: VariantVisibility.public,
  panelGroupId: GROUP,
  price: { id: 'price-1', amount: '12.5', currencyCode: 'USD', effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  campaignEndsAt: null,
  rateCards: [],
  remaining: null,
  soldOut: false,
  ...o,
});

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RenewalRefused) return e.reason;
    throw e;
  }
  return 'renewed';
};

describe('renewalOf — the plan as it is now (rule 2)', () => {
  it("adds the plan's bag and days as they are today, not the Grant's copy", () => {
    expect(renewalOf(grant(), plan())).toEqual({ bytes: BigInt(60 * GIB), days: 30, switched: false });
  });

  it('a suspended Grant is renewable, whatever stopped it (rule 1)', () => {
    expect(renewalOf(grant({ status: GrantStatus.suspended }), plan()).days).toBe(30);
  });

  it.each([GrantStatus.pending, GrantStatus.exhausted, GrantStatus.expired, GrantStatus.cancelled])('a %s Grant is not', (status) => {
    expect(refusal(() => renewalOf(grant({ status }), plan()))).toBe('grant_not_renewable');
  });
});

describe('renewalOf — which plan (rules 3, 4)', () => {
  it('another plan of the same product, on the same group and mode, is a switch', () => {
    expect(renewalOf(grant(), plan({ variantId: BIGGER_PLAN, quotas: traffic(200 * GIB), durationDays: 90 }))).toEqual({
      bytes: BigInt(200 * GIB),
      days: 90,
      switched: true,
    });
  });

  it('a sold-out plan is still renewed: a renewal starts no service (F-513, F-514)', () => {
    expect(refusal(() => renewalOf(grant(), plan({ soldOut: true, remaining: 0 })))).toBe('renewed');
  });

  it.each([
    ['not live, unpriced, or not this tenant’s to read', null],
    ['of another product', plan({ productId: '44444444-4444-4444-8444-444444444449' })],
    ['on another panel group (invariant 31)', plan({ panelGroupId: '88888888-8888-4888-8888-888888888889' })],
    ['in another billing mode', plan({ billingMode: VariantBillingMode.metered })],
  ])('a plan %s is refused', (_why, offer) => {
    expect(refusal(() => renewalOf(grant(), offer))).toBe('plan_not_renewable');
  });

  it('a Grant issued with no plan (an import) has no product to renew within', () => {
    expect(refusal(() => renewalOf(grant({ variantId: null, productId: null }), plan()))).toBe('plan_not_renewable');
  });

  it('admin_only and unlisted are live for a renewal; a switched-off one is not', () => {
    const facts = { isActive: true, productActive: true, categoryActive: true };
    expect(isRenewable({ ...facts, visibility: VariantVisibility.admin_only })).toBe(true);
    expect(isRenewable({ ...facts, visibility: VariantVisibility.unlisted })).toBe(true);
    expect(isRenewable({ ...facts, visibility: VariantVisibility.public, productActive: false })).toBe(false);
  });
});

describe('renewalOf — only the limited part (rule 6)', () => {
  it('a metered Grant buys days only: its bytes are blocks', () => {
    const metered = { billingMode: VariantBillingMode.metered };
    expect(renewalOf(grant(metered), plan({ ...metered, quotas: {} }))).toEqual({ bytes: BigInt(0), days: 30, switched: false });
  });

  it('an unlimited Grant buys days on an unlimited plan, and is refused a bag', () => {
    expect(renewalOf(grant({ trafficUnlimited: true }), plan({ quotas: traffic(0) })).bytes).toBe(BigInt(0));
    expect(refusal(() => renewalOf(grant({ trafficUnlimited: true }), plan()))).toBe('plan_not_renewable');
  });

  it('a bagged Grant is refused an unlimited plan, or one with no traffic stated (F-111-p)', () => {
    expect(refusal(() => renewalOf(grant(), plan({ quotas: traffic(0) })))).toBe('plan_not_renewable');
    expect(refusal(() => renewalOf(grant(), plan({ quotas: {} })))).toBe('plan_not_renewable');
  });

  it('a permanent Grant buys bytes only, and only on a permanent plan', () => {
    expect(renewalOf(grant({ endsAt: null }), plan({ durationDays: null }))).toEqual({ bytes: BigInt(60 * GIB), days: 0, switched: false });
    expect(refusal(() => renewalOf(grant({ endsAt: null }), plan()))).toBe('plan_not_renewable');
    expect(refusal(() => renewalOf(grant(), plan({ durationDays: null })))).toBe('plan_not_renewable');
  });

  it('a plan that adds nothing is refused', () => {
    const metered = { billingMode: VariantBillingMode.metered };
    expect(refusal(() => renewalOf(grant({ ...metered, endsAt: null }), plan({ ...metered, quotas: {}, durationDays: null })))).toBe('plan_not_renewable');
  });
});
