/**
 * A buyer's own name for a service (F-307-x, user 2026-09-28).
 *
 * Five identical purchases read the same everywhere until the buyer names
 * them. What breaks without anyone seeing it:
 *  - **naming someone else's service.** The write is fenced by the gate's
 *    user in the query itself; another user's Grant is `grant_not_found`,
 *    exactly as a missing one;
 *  - **a name the search cannot find.** It is saved in one spelling
 *    (F-307-o), and `q` matches it as well as the config names;
 *  - **a notice that still cannot tell them apart.** The names a combined
 *    notice lists (`grants/names`) answer it, before the config labels.
 */
import { NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigStatus, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions, runWithTenant } from '@txnet-backend/shared-core';

import { GrantListController } from '../payment/gift/grant-list.controller';
import { grantLabelSchema } from '../payment/gift/grant-list.schema';

import { EntitlementRefused, GrantService } from './grant';
import { GrantNamesService } from './grant-names';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '22222222-2222-4222-8222-222222222222';

const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);

function grantRow(userLabel: string | null) {
  return {
    id: GRANT,
    userId: USER,
    userLabel,
    status: GrantStatus.active,
    startsAt: new Date('2026-09-14T10:00:00Z'),
    endsAt: null,
    featureKeys: [],
    variant: null,
    billingMode: VariantBillingMode.prepaid,
    consumedBytes: BigInt(0),
    purchasedBytes: BigInt(0),
    trafficUnlimited: false,
    quotas: {},
    suspendedAt: null,
    statusReason: null,
    frozenUntil: null,
    purgeAfterDays: null,
    usagePushedAt: null,
  };
}

function build(opts: { updated?: number; label?: string | null } = {}) {
  const asked: { update?: { where: unknown; data: unknown }; where?: Prisma.GrantWhereInput; select?: Record<string, unknown> } = {};
  const tx = {
    $executeRaw: async () => 0,
    tenantBranding: { findUnique: async () => null },
    config: { findMany: async () => [] },
    quotaAdjustment: { groupBy: async () => [] },
    grant: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        asked.update = args;
        return { count: opts.updated ?? 1 };
      },
      findMany: async (args: { where: Prisma.GrantWhereInput; select: Record<string, unknown> }) => {
        asked.where = args.where;
        asked.select = args.select;
        return [grantRow(opts.label ?? null)];
      },
      count: async () => 1,
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { grants: new GrantService(prisma as never), names: new GrantNamesService(prisma as never), asked };
}

describe('GrantService.setLabel (F-307-x)', () => {
  it('writes only the label, on the gate’s user’s own Grant, in one spelling', async () => {
    const { grants, asked } = build();
    await expect(inTenant(() => grants.setLabel(USER, GRANT, 'خانه علي ۲'))).resolves.toBe('خانه علی 2');
    expect(asked.update).toEqual({ where: { id: GRANT, userId: USER }, data: { userLabel: 'خانه علی 2' } });
  });

  it('clears it with null — the catalog name is the name again', async () => {
    const { grants, asked } = build();
    await expect(inTenant(() => grants.setLabel(USER, GRANT, null))).resolves.toBeNull();
    expect(asked.update?.data).toEqual({ userLabel: null });
  });

  it('refuses another user’s or a missing Grant as `grant_not_found`', async () => {
    const { grants } = build({ updated: 0 });
    const refused = inTenant(() => grants.setLabel(USER, GRANT, 'x'));
    await expect(refused).rejects.toBeInstanceOf(EntitlementRefused);
    await expect(refused).rejects.toMatchObject({ reason: 'grant_not_found' });
  });
});

describe('the list and its search answer the name (F-307-x)', () => {
  it('answers `label` on each row', async () => {
    const { grants, asked } = build({ label: 'Home' });
    const page = await inTenant(() => grants.listForUser(USER));
    expect(page.rows[0].label).toBe('Home');
    expect(asked.select?.userLabel).toBe(true);
  });

  it('keeps a Grant whose own name holds q, beside one holding a config named like it', async () => {
    const { grants, asked } = build();
    await inTenant(() => grants.listForUser(USER, { q: 'خانه ي' }));
    expect(asked.where).toEqual({
      userId: USER,
      status: { notIn: [GrantStatus.cancelled, GrantStatus.exhausted] },
      OR: [
        { userLabel: { contains: 'خانه ی', mode: 'insensitive' } },
        { configs: { some: { status: { not: ConfigStatus.retired }, OR: [{ userLabel: { contains: 'خانه ی', mode: 'insensitive' } }, { userLabel: null, panel: { region: { in: [] } } }] } } },
      ],
    });
  });
});

describe('GrantNamesService answers the name (F-307-x)', () => {
  it('answers `label` beside the config labels, null when unnamed', async () => {
    const { names } = build({ label: 'Home' });
    const [item] = await names.names({ tenantId: TENANT, userId: USER, grantIds: [GRANT] });
    expect(item).toEqual({ grantId: GRANT, label: 'Home', nameKey: null, sku: null, labels: [] });
  });
});

describe('PUT billing/gift/grants/:grantId/label (F-307-x)', () => {
  const req = { identity: { userId: USER, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions: [] } };

  it('is a PUT under the naming budget a config’s label spends', () => {
    const handler = GrantListController.prototype.setLabel;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(2); // RequestMethod.PUT
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':grantId/label');
    const limit = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions;
    expect(limit.configKey).toBe('CONFIG_ACTION_RATE_LIMIT');
    expect(limit.key(req as never)).toBe(`${RateLimitBucket.CONFIG_ACTION}:${USER}`);
  });

  it('names the gate’s user’s Grant and answers the name as saved; a refused one is 404', async () => {
    const grants = { setLabel: vi.fn(async () => 'Home') };
    await expect(new GrantListController(grants as never).setLabel(GRANT, { label: ' Home ' }, req as never)).resolves.toEqual({ grantId: GRANT, label: 'Home' });
    expect(grants.setLabel).toHaveBeenCalledWith(USER, GRANT, ' Home ');

    const refusing = { setLabel: vi.fn(async () => Promise.reject(new EntitlementRefused('grant_not_found'))) };
    await expect(new GrantListController(refusing as never).setLabel(GRANT, { label: null }, req as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('takes a name trimmed, 1..40 characters; empty or null is the catalog’s name again', () => {
    expect(grantLabelSchema.parse({ label: '  Home ' })).toEqual({ label: 'Home' });
    expect(grantLabelSchema.parse({ label: '   ' })).toEqual({ label: null });
    expect(grantLabelSchema.parse({ label: null })).toEqual({ label: null });
    expect(grantLabelSchema.safeParse({ label: 'x'.repeat(41) }).success).toBe(false);
  });
});
