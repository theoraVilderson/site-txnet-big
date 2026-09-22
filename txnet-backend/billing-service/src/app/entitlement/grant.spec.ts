/**
 * Grant core (F-026-e; spec: `tools/spec.py --section 4.4`).
 *
 * What breaks without anyone seeing it:
 *  - **a Grant revived for free.** The service refuses the moves the database
 *    trigger refuses, with a reason a caller can act on, before the round trip;
 *  - **access past its end.** Active means `status = active` and `startsAt <= at
 *    < endsAt`; a permanent Grant has no end;
 *  - **an `admin_only` variant bought.** A purchase needs a `public` or
 *    `unlisted` variant; an admin, a coupon or a trial may assign any live one;
 *  - **a catalog edit changing what was sold.** Quotas, feature keys, billing
 *    mode and duration are copied from the variant at issue;
 *  - **yesterday's traffic repriced.** A metered variant's rate in effect is
 *    copied onto `Grant.meteredRate` at issue (F-027-p, ADR-0073), and a
 *    metered variant with no rate is not issued at all;
 *  - **a working link in the database.** Only the token's SHA-256 is written;
 *    the token is answered once;
 *  - **a retried cause granting twice.** A second issue for the same
 *    `(source, sourceReferenceId)` answers the first Grant and no token.
 *
 * What the database itself holds is `entitlement-schema.int.spec.ts`.
 */
import { createHash } from 'node:crypto';

import { GrantSource, GrantStatus, Prisma, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import {
  assignable,
  canMove,
  EntitlementRefused,
  GrantService,
  grantFromVariant,
  hashSubscriptionToken,
  isActiveAt,
  newSubscriptionToken,
} from './grant';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const VARIANT = '66666666-6666-4666-8666-6666666666c1';
const PAYMENT = '99999999-9999-4999-8999-999999999999';
const at = (iso: string) => new Date(iso);

describe('canMove', () => {
  const S = GrantStatus;

  it.each([
    [S.pending, S.active],
    [S.pending, S.cancelled],
    [S.active, S.suspended],
    [S.active, S.exhausted],
    [S.active, S.expired],
    [S.active, S.cancelled],
    [S.suspended, S.active],
    [S.suspended, S.expired],
  ])('allows %s → %s', (from, to) => {
    expect(canMove(from, to)).toBe(true);
  });

  it.each([
    [S.expired, S.active],
    [S.exhausted, S.active],
    [S.cancelled, S.active],
    [S.expired, S.cancelled],
    [S.active, S.pending],
    [S.pending, S.expired],
  ])('refuses %s → %s', (from, to) => {
    expect(canMove(from, to)).toBe(false);
  });
});

describe('isActiveAt', () => {
  const grant = { status: GrantStatus.active, startsAt: at('2026-09-01T00:00:00Z'), endsAt: at('2026-10-01T00:00:00Z') };

  it('is active inside its window, from its start and until — not at — its end', () => {
    expect(isActiveAt(grant, at('2026-09-01T00:00:00Z'))).toBe(true);
    expect(isActiveAt(grant, at('2026-09-30T23:59:59Z'))).toBe(true);
    expect(isActiveAt(grant, at('2026-10-01T00:00:00Z'))).toBe(false);
    expect(isActiveAt(grant, at('2026-08-31T23:59:59Z'))).toBe(false);
  });

  it('has no end when permanent, and is never active in another status', () => {
    expect(isActiveAt({ ...grant, endsAt: null }, at('2030-01-01T00:00:00Z'))).toBe(true);
    expect(isActiveAt({ ...grant, status: GrantStatus.suspended }, at('2026-09-15T00:00:00Z'))).toBe(false);
    expect(isActiveAt({ ...grant, status: GrantStatus.pending }, at('2026-09-15T00:00:00Z'))).toBe(false);
  });
});

describe('assignable', () => {
  const live = { isActive: true, productActive: true, categoryActive: true };

  it.each([
    [GrantSource.purchase, VariantVisibility.public, true],
    [GrantSource.purchase, VariantVisibility.unlisted, true],
    [GrantSource.purchase, VariantVisibility.admin_only, false],
    [GrantSource.coupon, VariantVisibility.admin_only, true],
    [GrantSource.admin_grant, VariantVisibility.admin_only, true],
    [GrantSource.trial, VariantVisibility.unlisted, true],
  ])('%s of a %s variant: %s', (source, visibility, expected) => {
    expect(assignable(source, { ...live, visibility })).toBe(expected);
  });

  it('never assigns a switched-off variant, whoever asks', () => {
    for (const source of [GrantSource.purchase, GrantSource.admin_grant, GrantSource.coupon]) {
      expect(assignable(source, { ...live, productActive: false, visibility: VariantVisibility.public })).toBe(false);
    }
  });
});

describe('grantFromVariant', () => {
  const rate = (id: string, r: string, effectiveFrom: string, isActive = true) => ({
    id,
    rate: new Prisma.Decimal(r),
    effectiveFrom: at(effectiveFrom),
    isActive,
  });
  const variant = {
    billingMode: VariantBillingMode.prepaid,
    quotas: { traffic_bytes: { limit: 53687091200, resetPolicy: 'none' } },
    durationDays: 30,
    meteredRates: [],
    product: { featureKeys: ['vpn.access'] },
  };

  it('copies what was sold and ends it durationDays later', () => {
    expect(grantFromVariant({ source: GrantSource.coupon, startsAt: at('2026-09-01T10:00:00Z') }, variant)).toEqual({
      status: GrantStatus.active,
      startsAt: at('2026-09-01T10:00:00Z'),
      endsAt: at('2026-10-01T10:00:00Z'),
      billingMode: VariantBillingMode.prepaid,
      quotas: variant.quotas,
      featureKeys: ['vpn.access'],
      meteredRate: null,
    });
  });

  it('locks the rate in effect at the start onto a metered Grant, and never a later one', () => {
    const metered = {
      ...variant,
      billingMode: VariantBillingMode.metered,
      meteredRates: [rate('r1', '0.40000000', '2026-01-01T00:00:00Z'), rate('r2', '0.25000000', '2026-10-01T00:00:00Z')],
    };
    const g = grantFromVariant({ source: GrantSource.coupon, startsAt: at('2026-09-01T10:00:00Z') }, metered);
    expect(g.meteredRate?.toString()).toBe('0.4');
  });

  it('carries no rate on a prepaid variant, whatever its rate history says', () => {
    const priced = { ...variant, meteredRates: [rate('r1', '0.40000000', '2026-01-01T00:00:00Z')] };
    expect(grantFromVariant({ source: GrantSource.coupon, startsAt: at('2026-09-01T10:00:00Z') }, priced).meteredRate).toBeNull();
  });

  it('has no rate for a metered variant whose history starts later', () => {
    const metered = {
      ...variant,
      billingMode: VariantBillingMode.metered,
      meteredRates: [rate('r1', '0.40000000', '2026-10-01T00:00:00Z')],
    };
    expect(grantFromVariant({ source: GrantSource.coupon, startsAt: at('2026-09-01T10:00:00Z') }, metered).meteredRate).toBeNull();
  });

  it('is permanent with no duration, and pending while a purchase settles', () => {
    const g = grantFromVariant({ source: GrantSource.purchase, startsAt: at('2026-09-01T00:00:00Z') }, { ...variant, durationDays: null });
    expect(g.endsAt).toBeNull();
    expect(g.status).toBe(GrantStatus.pending);
  });

  it('does not share the variant\'s arrays with the Grant', () => {
    const g = grantFromVariant({ source: GrantSource.coupon, startsAt: at('2026-09-01T00:00:00Z') }, variant);
    g.featureKeys.push('x');
    expect(variant.product.featureKeys).toEqual(['vpn.access']);
  });
});

describe('the subscription token', () => {
  it('is 32 random bytes, and only its SHA-256 in hex is kept', () => {
    const { token, hash } = newSubscriptionToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashSubscriptionToken(token)).toBe(hash);
    expect(newSubscriptionToken().token).not.toBe(token);
  });
});

describe('GrantService.issue', () => {
  const variantRow = (visibility: VariantVisibility = VariantVisibility.public) => ({
    id: VARIANT,
    tenantId: null,
    isActive: true,
    visibility,
    billingMode: VariantBillingMode.prepaid,
    quotas: {},
    durationDays: 30,
    meteredRates: [] as Array<{ id: string; rate: Prisma.Decimal; effectiveFrom: Date; isActive: boolean }>,
    product: { isActive: true, featureKeys: ['vpn.access'], category: { isActive: true } },
  });

  function fakeTx(variant: ReturnType<typeof variantRow> | null) {
    const grants: Array<Record<string, unknown>> = [];
    const tx = {
      productVariant: { findUnique: vi.fn(async () => variant) },
      grant: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          grants.find((g) => g['source'] === where['source'] && g['sourceReferenceId'] === where['sourceReferenceId']) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `grant-${grants.length + 1}`, ...data };
          grants.push(row);
          return row;
        }),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, grants, calls: tx };
  }

  const service = new GrantService({} as never);
  const issue = (tx: Prisma.TransactionClient, over: Partial<Parameters<GrantService['issue']>[1]> = {}) =>
    runWithTenant({ id: TENANT }, () =>
      service.issue(tx, { userId: USER, variantId: VARIANT, source: GrantSource.coupon, sourceReferenceId: PAYMENT, ...over }),
    );

  it('writes the Grant in the caller\'s tenant with the token\'s hash, and answers the token once', async () => {
    const { tx, grants } = fakeTx(variantRow());

    const first = await issue(tx);

    expect(first.token).toEqual(expect.any(String));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ tenantId: TENANT, userId: USER, variantId: VARIANT, status: GrantStatus.active });
    expect(grants[0]['subscriptionTokenHash']).toBe(hashSubscriptionToken(first.token as string));
    expect(JSON.stringify(grants[0])).not.toContain(first.token as string);
  });

  it('answers the first Grant and no token when the same cause issues again', async () => {
    const { tx, grants, calls } = fakeTx(variantRow());

    const first = await issue(tx);
    const again = await issue(tx);

    expect(again.grant.id).toBe(first.grant.id);
    expect(again.token).toBeNull();
    expect(grants).toHaveLength(1);
    expect(calls.grant.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown variant and one the source may not assign', async () => {
    await expect(issue(fakeTx(null).tx)).rejects.toMatchObject({ reason: 'variant_not_found' });
    await expect(issue(fakeTx(variantRow(VariantVisibility.admin_only)).tx, { source: GrantSource.purchase })).rejects.toBeInstanceOf(
      EntitlementRefused,
    );
    await expect(
      issue(fakeTx(variantRow(VariantVisibility.admin_only)).tx, { source: GrantSource.purchase }),
    ).rejects.toMatchObject({ reason: 'variant_not_assignable' });
  });
});

describe('GrantService.issue locks the metered rate (F-027-p, ADR-0073)', () => {
  const meteredVariant = (rates: Array<{ effectiveFrom: string; rate: string }>) => ({
    id: VARIANT,
    tenantId: null,
    isActive: true,
    visibility: VariantVisibility.public,
    billingMode: VariantBillingMode.metered,
    quotas: {},
    durationDays: 30,
    meteredRates: rates.map((r, i) => ({
      id: `r${i + 1}`,
      rate: new Prisma.Decimal(r.rate),
      effectiveFrom: at(r.effectiveFrom),
      isActive: true,
    })),
    product: { isActive: true, featureKeys: ['vpn.access'], category: { isActive: true } },
  });

  function fakeTx(variant: ReturnType<typeof meteredVariant>) {
    const grants: Array<Record<string, unknown>> = [];
    const tx = {
      productVariant: { findUnique: vi.fn(async () => variant) },
      grant: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `grant-${grants.length + 1}`, ...data };
          grants.push(row);
          return row;
        }),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, grants };
  }

  const service = new GrantService({} as never);
  const issue = (tx: Prisma.TransactionClient, startsAt: Date) =>
    runWithTenant({ id: TENANT }, () =>
      service.issue(tx, { userId: USER, variantId: VARIANT, source: GrantSource.coupon, sourceReferenceId: PAYMENT, startsAt }),
    );

  it('writes the rate in effect at the sale, not the newest in the history', async () => {
    const { tx, grants } = fakeTx(
      meteredVariant([
        { effectiveFrom: '2026-01-01T00:00:00Z', rate: '0.40000000' },
        { effectiveFrom: '2026-10-01T00:00:00Z', rate: '0.25000000' },
      ]),
    );

    await issue(tx, at('2026-09-01T10:00:00Z'));

    expect((grants[0]['meteredRate'] as Prisma.Decimal).toString()).toBe('0.4');
  });

  it('refuses a metered variant with no rate in effect, rather than serving bytes at nothing', async () => {
    const { tx, grants } = fakeTx(meteredVariant([{ effectiveFrom: '2026-10-01T00:00:00Z', rate: '0.25000000' }]));

    await expect(issue(tx, at('2026-09-01T10:00:00Z'))).rejects.toMatchObject({ reason: 'metered_rate_missing' });
    expect(grants).toHaveLength(0);
  });
});
