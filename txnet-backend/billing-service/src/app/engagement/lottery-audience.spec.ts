/**
 * A lottery's announcement audience (F-707-q) names each member's prize-service
 * choice when they have one to make (F-707-z, user 2026-10-22).
 *
 * What would break silently: a member with one service told to choose (noise,
 * and a bot message they did not get before); a member with two not told, so
 * an automatic lottery's GB lands where they did not mean it; the choice named
 * as one that no longer applies (an ended service), while billing would go
 * automatic.
 */
import { GrantStatus, LotteryEntryMode, LotteryStatus } from '@prisma/client';

import { LotteryAudienceService } from './lottery-audience.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOT = '22222222-2222-4222-8222-222222222222';
const AT = new Date('2026-10-22T12:00:00Z');

type G = { id: string; userId: string; status: GrantStatus; trafficUnlimited: boolean; endsAt: Date | null; userLabel: string | null };
const g = (id: string, userId: string, o: Partial<G> = {}): G => ({ id, userId, status: GrantStatus.active, trafficUnlimited: false, endsAt: AT, userLabel: null, ...o });

function build(o: { members: string[]; grants: G[]; chosen?: Record<string, string> }) {
  const tx = {
    $executeRaw: async () => 0,
    userGroupMember: { findMany: async () => o.members.map((userId) => ({ userId })) },
    grant: {
      findMany: async ({ where }: { where: { userId: { in: string[] }; status: GrantStatus } }) =>
        o.grants
          .filter((x) => where.userId.in.includes(x.userId) && x.status === where.status && (!x.trafficUnlimited || x.endsAt !== null))
          .map((x) => ({ ...x, variant: { sku: `SKU-${x.id}`, nameKey: null, product: { nameKey: 'catalog.p.gold' } } })),
    },
    rewardTarget: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
        Object.entries(o.chosen ?? {}).filter(([u]) => where.userId.in.includes(u)).map(([userId, grantId]) => ({ userId, grantId })),
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const crossTenant = {
    lottery: {
      findUnique: async () => ({ tenantId: TENANT, status: LotteryStatus.published, closesAt: new Date('2026-10-30T00:00:00Z'), title: 'Autumn', entryMode: LotteryEntryMode.automatic, userGroupId: 'grp' }),
    },
  };
  return new LotteryAudienceService(prisma as never, crossTenant as never);
}

describe('LotteryAudienceService.page — the prize-service choice (F-707-z)', () => {
  it('names a choice only for members with two services or more a prize can reach', async () => {
    const service = build({
      members: ['u-one', 'u-two', 'u-unlimited'],
      grants: [g('a', 'u-one'), g('b', 'u-two'), g('c', 'u-two', { userLabel: 'Family' }), g('d', 'u-unlimited'), g('e', 'u-unlimited', { trafficUnlimited: true, endsAt: null })],
      chosen: { 'u-two': 'c' },
    });
    const page = await service.page(LOT, null, 500, AT);
    expect(page.prizeChoices).toEqual({ 'u-two': { label: 'Family', sku: 'SKU-c', nameKey: 'catalog.p.gold' } });
  });

  it('reads automatic (null) when nothing is chosen or the choice no longer applies', async () => {
    const service = build({
      members: ['u-a', 'u-b'],
      grants: [g('a1', 'u-a'), g('a2', 'u-a'), g('b1', 'u-b'), g('b2', 'u-b'), g('b3', 'u-b', { status: GrantStatus.expired })],
      chosen: { 'u-b': 'b3' },
    });
    expect((await service.page(LOT, null, 500, AT)).prizeChoices).toEqual({ 'u-a': null, 'u-b': null });
  });
});
