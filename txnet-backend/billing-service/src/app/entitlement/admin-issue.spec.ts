/**
 * An admin issues a service to a user by hand (F-311-o, spec F-311): a Grant
 * of a variant with `source = admin_grant`, no invoice, no money.
 *
 * Each case below is a way it breaks quietly:
 *
 *  - **provisioned like a purchase.** The Grant is born `active` and group
 *    fulfilment's sweep places its configs, exactly as for a purchase's once
 *    delivered — so a variant nothing could deliver (a kind with no handler,
 *    a network variant with no group or no placeable group, a prepaid network
 *    variant stating no traffic) is refused **before** a Grant exists, the
 *    same gates invoice create holds; otherwise the user holds a service that
 *    never gets a config and nobody is told;
 *  - **`admin_only` is assignable.** A hand-issued Grant is how a variant kept
 *    out of the shop reaches a user (F-506);
 *  - **one request, one Grant.** A double click or a bot callback fired twice
 *    carries the same `requestId`, and answers the first Grant — a free
 *    service issued twice is money given away; the same id for another user
 *    or another variant is refused, never answered with someone else's Grant;
 *  - **the admin is on the Grant** (`issuedByAdminId`), who issued it.
 */
import { FulfilmentKind, GrantSource, GrantStatus, Prisma, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { issueGrantByAdmin } from './admin-issue';
import { GrantService } from './grant';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '66666666-6666-4666-8666-666666666666';
const OTHER_USER = '77777777-7777-4777-8777-777777777777';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const VARIANT = '99999999-9999-4999-8999-999999999999';
const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = new Date('2026-09-28T10:00:00Z');
const GIB = 1024 ** 3;

type VariantOver = {
  visibility?: VariantVisibility;
  kind?: FulfilmentKind;
  panelGroupId?: string | null;
  billingMode?: VariantBillingMode;
  quotas?: Record<string, unknown>;
};

const variantRow = (over: VariantOver = {}) => ({
  id: VARIANT,
  tenantId: null,
  isActive: true,
  visibility: over.visibility ?? VariantVisibility.public,
  panelGroupId: over.panelGroupId === undefined ? GROUP : over.panelGroupId,
  billingMode: over.billingMode ?? VariantBillingMode.prepaid,
  quotas: over.quotas ?? { traffic_bytes: { limit: 50 * GIB, resetPolicy: 'none' } },
  durationDays: 30,
  rateCards: [],
  product: {
    isActive: true,
    fulfilmentKind: over.kind ?? FulfilmentKind.network_access,
    featureKeys: ['vpn.access'],
    categories: [{ position: 0, category: { isActive: true, parentId: null } }],
  },
});

/** `placeable`: how many members of the group could ever place a config (`deliverableGroupIds`). */
function fakeTx(variant: ReturnType<typeof variantRow> | null, placeable = 1) {
  const grants: Array<Record<string, unknown>> = [];
  const tx = {
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }) },
    productVariant: { findUnique: vi.fn(async () => variant) },
    panelGroup: {
      findMany: vi.fn(async () => [{ id: GROUP, minHealthyPanels: 1, members: Array.from({ length: placeable }, (_, i) => ({ panelId: `p${i}` })) }]),
    },
    grant: {
      findFirst: vi.fn(async ({ where }: { where: { source: GrantSource; sourceReferenceId: string } }) =>
        grants.find((g) => g['source'] === where.source && g['sourceReferenceId'] === where.sourceReferenceId) ?? null,
      ),
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
const issue = (tx: Prisma.TransactionClient, over: Partial<Parameters<typeof issueGrantByAdmin>[2]> = {}) =>
  runWithTenant({ id: TENANT }, () =>
    issueGrantByAdmin(tx, service, { userId: USER, variantId: VARIANT, requestId: REQUEST, actorUserId: ADMIN, at: AT, ...over }),
  );

/** The same issue in a reseller's tenant whose limit on services issued by hand (F-019-p) is `limit`, with `issued` already this month. */
function boundedTx(limit: number, issued: number) {
  const base = fakeTx(variantRow());
  const tx = base.tx as unknown as Record<string, unknown>;
  Object.assign(tx, {
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD', tenantType: 'reseller' }) },
    tenantSubscription: { findUnique: async () => null },
    resellerLimit: { findMany: async () => [] },
    packageLimit: { findMany: async () => [] },
    resellerLimitSetting: { findMany: async () => [{ key: 'admin_issues_30d_max', value: limit }] },
    $executeRaw: async () => 1,
    // The reseller's own panels: the platform's room (F-019-o) is not asked.
    panelGroupMember: { findFirst: async () => null },
  });
  (tx['grant'] as Record<string, unknown>)['count'] = async () => issued;
  return base;
}

describe('issueGrantByAdmin — the reseller\'s limits (F-019-p, F-019-o, ADR-0106)', () => {
  it('refuses the reseller\'s own people past the limit on services issued by hand, writing nothing', async () => {
    const { tx, grants } = boundedTx(2, 2);
    await expect(issue(tx, { bounded: true })).rejects.toMatchObject({ reason: 'reseller_limit_reached', key: 'admin_issues_30d_max', limit: 2, used: 2 });
    expect(grants).toHaveLength(0);
  });

  it('lets the platform\'s staff through, and below the limit the reseller\'s people too', async () => {
    await expect(issue(boundedTx(2, 2).tx, { bounded: false })).resolves.toMatchObject({ issued: true });
    await expect(issue(boundedTx(2, 1).tx, { bounded: true })).resolves.toMatchObject({ issued: true });
  });

  it('never refuses asking again for an issue already made', async () => {
    const { tx, grants } = boundedTx(1, 0);
    const first = await issue(tx, { bounded: true });
    (tx as unknown as { grant: Record<string, unknown> }).grant['count'] = async () => 1;
    await expect(issue(tx, { bounded: true })).resolves.toMatchObject({ grantId: first.grantId, issued: false });
    expect(grants).toHaveLength(1);
  });
});

describe('issueGrantByAdmin (F-311-o)', () => {
  it('issues an active admin_grant Grant, the request as its cause and the admin on it', async () => {
    const { tx, grants } = fakeTx(variantRow());

    const done = await issue(tx);

    expect(done).toMatchObject({ grantId: 'grant-1', status: GrantStatus.active, issued: true, startsAt: AT, endsAt: new Date(AT.getTime() + 30 * 86_400_000) });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      userId: USER,
      tenantId: TENANT,
      source: GrantSource.admin_grant,
      sourceReferenceId: REQUEST,
      issuedByAdminId: ADMIN,
      status: GrantStatus.active,
      purchasedBytes: BigInt(50 * GIB),
    });
  });

  it('assigns a variant kept out of the shop (admin_only)', async () => {
    const { tx, grants } = fakeTx(variantRow({ visibility: VariantVisibility.admin_only }));

    await expect(issue(tx)).resolves.toMatchObject({ issued: true });
    expect(grants).toHaveLength(1);
  });

  it('answers the first Grant, and writes none, when the same request comes again', async () => {
    const { tx, grants } = fakeTx(variantRow());

    const first = await issue(tx);
    const again = await issue(tx);

    expect(again).toMatchObject({ grantId: first.grantId, issued: false });
    expect(grants).toHaveLength(1);
  });

  it('refuses the same request id for another user or another variant, never answering that Grant', async () => {
    const { tx, grants } = fakeTx(variantRow());
    await issue(tx);

    await expect(issue(tx, { userId: OTHER_USER })).rejects.toMatchObject({ reason: 'request_reused' });
    await expect(issue(tx, { variantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).rejects.toMatchObject({ reason: 'request_reused' });
    expect(grants).toHaveLength(1);
  });

  it('refuses, writing nothing, a variant nothing could deliver', async () => {
    const cases: Array<[string, ReturnType<typeof fakeTx>]> = [
      ['a network variant with no panel group', fakeTx(variantRow({ panelGroupId: null }))],
      ['a group no member of which could ever place one', fakeTx(variantRow(), 0)],
      ['a prepaid network variant stating no traffic', fakeTx(variantRow({ quotas: {} }))],
      ['a retired kind with no handler', fakeTx(variantRow({ kind: FulfilmentKind.external_order, panelGroupId: null }))],
    ];
    for (const [what, { tx, grants }] of cases) {
      await expect(issue(tx), what).rejects.toMatchObject({ reason: 'variant_not_deliverable' });
      expect(grants, what).toHaveLength(0);
    }
  });

  it('issues a feature-only variant, which has nothing to place', async () => {
    const { tx, grants } = fakeTx(variantRow({ kind: FulfilmentKind.feature_access, panelGroupId: null, quotas: {} }));

    await expect(issue(tx)).resolves.toMatchObject({ issued: true, status: GrantStatus.active });
    expect(grants).toHaveLength(1);
  });

  it('refuses an unknown variant', async () => {
    await expect(issue(fakeTx(null).tx)).rejects.toMatchObject({ reason: 'variant_not_found' });
  });
});
