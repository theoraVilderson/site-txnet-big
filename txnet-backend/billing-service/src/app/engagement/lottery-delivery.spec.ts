/**
 * A drawn lottery's delivery and its public result (F-707-m, ADR-0111 point 5).
 *
 * What would break silently here, and nowhere else:
 *  - a prize given to an account that is gone or banned, or lost with it: the
 *    winner is passed on, its reason kept, and the next reserve in place order
 *    takes the prize, naming whom it replaces;
 *  - a winner with no active Grant for a GB or days prize kept waiting for a
 *    purchase: passed on at once (user, 2026-10-03), never queued;
 *  - a refusal that is the tenant's (a template gone, no wholesale funds)
 *    handed to a reserve who would be refused the same: kept `pending`, tried
 *    next minute;
 *  - a prize given twice: the issuer's reference is the winner row, and a
 *    delivered row is never taken again;
 *  - a winner not told, or told of a prize it did not get;
 *  - a result shown before the draw is published, or to someone outside the
 *    lottery; or a published result without the seed that makes it checkable.
 */
import { LotteryStatus, LotteryWinnerDelivery, Prisma, SpinPrizeType, UserStatus } from '@prisma/client';
import { OutboxEventType, runWithTenant } from '@txnet-backend/shared-core';

import { LotteryDeliveryService } from './lottery-delivery.service';
import { LotteryEntryRefused } from './lottery-entry.service';
import { LotteryResultService } from './lottery-result.service';
import { issueReward, RewardRefused } from './reward-issuer';

vi.mock('./reward-issuer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reward-issuer')>()),
  issueReward: vi.fn(async () => ({ rewardId: 'rw-1', prizeType: 'bonus_traffic_gb', replay: false, grantId: 'g-1', coupon: null })),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const GROUP = '66666666-6666-4666-8666-666666666666';
const AT = new Date('2026-10-10T12:02:00Z');

type Winner = { id: string; position: number; prizeId: string | null; delivery: LotteryWinnerDelivery; deliveredAt: Date | null; passedOnReason: string | null; replacesWinnerId: string | null; entrantId: string; userId: string };

const prizes = [
  { id: 'p-1', rank: 1, label: '20 GB', prizeType: SpinPrizeType.bonus_traffic_gb, prizeValue: new Prisma.Decimal(20), couponTemplateId: null, couponValidDays: null, variantId: null, winnersCount: 1 },
  { id: 'p-2', rank: 2, label: '10% off', prizeType: SpinPrizeType.discount_coupon, prizeValue: new Prisma.Decimal(10), couponTemplateId: 'c-1', couponValidDays: 7, variantId: null, winnersCount: 1 },
];

const place = (position: number, prizeId: string | null, extra: Partial<Winner> = {}): Winner => ({
  id: `w-${position}`,
  position,
  prizeId,
  delivery: LotteryWinnerDelivery.pending,
  deliveredAt: null,
  passedOnReason: null,
  replacesWinnerId: null,
  entrantId: `e-${position}`,
  userId: `u-${position}`,
  ...extra,
});

function build(o: { status?: LotteryStatus; winners?: Winner[]; users?: Record<string, { status: UserStatus; deletedAt: Date | null }> } = {}) {
  const lot = { id: LOT, tenantId: TENANT, title: 'Autumn draw', createdByAdminId: ADMIN, status: o.status ?? LotteryStatus.drawn };
  const winners = o.winners ?? [place(1, 'p-1'), place(2, 'p-2'), place(3, null), place(4, null)];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const savepoints: string[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (/SAVEPOINT/.test(sql)) savepoints.push(sql.split(' ')[0]);
      return 0;
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      expect(strings.join('?')).toContain('FOR UPDATE');
      return lot.status === LotteryStatus.drawn ? [lot] : [];
    },
    lotteryWinner: {
      findMany: async () => winners.map((w) => ({ ...w, entrant: { userId: w.userId } })),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Winner> }) => {
        Object.assign(winners.find((w) => w.id === where.id) as Winner, data);
        return {};
      },
    },
    lotteryPrize: { findMany: async () => prizes },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, status: UserStatus.active, deletedAt: null, ...(o.users ?? {})[id] })),
    },
    outboxEvent: {
      create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
        events.push(data);
        return { id: `ev-${events.length}` };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const crossTenant = {
    lottery: {
      findMany: async () => (lot.status === LotteryStatus.drawn && winners.some((w) => w.prizeId && w.delivery === LotteryWinnerDelivery.pending) ? [{ id: LOT, tenantId: TENANT }] : []),
    },
  };
  const service = new LotteryDeliveryService(prisma as never, crossTenant as never, {} as never);
  return { service, winners, events, savepoints };
}

beforeEach(() => vi.mocked(issueReward).mockClear());

describe('LotteryDeliveryService.deliverDue', () => {
  it('gives each winner its prize, as the lottery, by its admin, and tells the winner', async () => {
    const { service, winners, events } = build();
    expect(await service.deliverDue(AT)).toEqual({ scanned: 1, delivered: 2, passedOn: 0, held: 0, failed: 0 });

    const calls = vi.mocked(issueReward).mock.calls.map((c) => c[2]);
    expect(calls).toEqual([
      expect.objectContaining({ tenantId: TENANT, userId: 'u-1', source: 'lottery', referenceId: 'w-1', actorUserId: ADMIN, at: AT, prize: expect.objectContaining({ prizeType: SpinPrizeType.bonus_traffic_gb }) }),
      expect.objectContaining({ userId: 'u-2', referenceId: 'w-2', prize: expect.objectContaining({ prizeType: SpinPrizeType.discount_coupon, couponTemplateId: 'c-1' }) }),
    ]);
    expect(winners.map((w) => [w.id, w.delivery, w.deliveredAt])).toEqual([
      ['w-1', LotteryWinnerDelivery.delivered, AT],
      ['w-2', LotteryWinnerDelivery.delivered, AT],
      ['w-3', LotteryWinnerDelivery.pending, null],
      ['w-4', LotteryWinnerDelivery.pending, null],
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: OutboxEventType.LOTTERY_WON, payload: { tenantId: TENANT, userId: 'u-1', lotteryId: LOT, title: 'Autumn draw', prize: '20 GB', rank: 1 } }),
      expect.objectContaining({ type: OutboxEventType.LOTTERY_WON, payload: { tenantId: TENANT, userId: 'u-2', lotteryId: LOT, title: 'Autumn draw', prize: '10% off', rank: 2 } }),
    ]);

    // Nothing left to give: the next run finds nothing.
    vi.mocked(issueReward).mockClear();
    expect(await service.deliverDue(AT)).toEqual({ scanned: 0, delivered: 0, passedOn: 0, held: 0, failed: 0 });
    expect(issueReward).not.toHaveBeenCalled();
  });

  it('passes a banned or deleted winner on to the next reserve in place order, which then gets the prize', async () => {
    const { service, winners, events } = build({ users: { 'u-1': { status: UserStatus.banned, deletedAt: null }, 'u-3': { status: UserStatus.active, deletedAt: AT } } });
    expect(await service.deliverDue(AT)).toEqual({ scanned: 1, delivered: 2, passedOn: 2, held: 0, failed: 0 });
    expect(winners.map((w) => [w.id, w.prizeId, w.delivery, w.passedOnReason, w.replacesWinnerId])).toEqual([
      ['w-1', 'p-1', LotteryWinnerDelivery.passed_on, 'inactive', null],
      ['w-2', 'p-2', LotteryWinnerDelivery.delivered, null, null],
      // The first reserve is gone too: it takes the prize and passes it on.
      ['w-3', 'p-1', LotteryWinnerDelivery.passed_on, 'inactive', 'w-1'],
      ['w-4', 'p-1', LotteryWinnerDelivery.delivered, null, 'w-3'],
    ]);
    expect(events.map((e) => e.payload.userId)).toEqual(['u-2', 'u-4']);
  });

  it('passes on, never queues, a GB prize whose winner has no active Grant (user, 2026-10-03)', async () => {
    vi.mocked(issueReward).mockRejectedValueOnce(new RewardRefused('no_active_grant'));
    const { service, winners, savepoints } = build();
    await service.deliverDue(AT);
    expect(winners.map((w) => [w.id, w.prizeId, w.delivery, w.passedOnReason, w.replacesWinnerId])).toEqual([
      ['w-1', 'p-1', LotteryWinnerDelivery.passed_on, 'no_active_grant', null],
      ['w-2', 'p-2', LotteryWinnerDelivery.delivered, null, null],
      ['w-3', 'p-1', LotteryWinnerDelivery.delivered, null, 'w-1'],
      ['w-4', null, LotteryWinnerDelivery.pending, null, null],
    ]);
    // Whatever the issuer wrote before refusing is undone.
    expect(savepoints).toContain('ROLLBACK');
  });

  it('with no reserve left, records the pass and leaves the prize unawarded', async () => {
    const { service, winners } = build({ winners: [place(1, 'p-1')], users: { 'u-1': { status: UserStatus.banned, deletedAt: null } } });
    expect(await service.deliverDue(AT)).toEqual({ scanned: 1, delivered: 0, passedOn: 1, held: 0, failed: 0 });
    expect(winners[0]).toMatchObject({ delivery: LotteryWinnerDelivery.passed_on, passedOnReason: 'inactive' });
  });

  it("keeps a winner pending, not passed on, when the refusal is the tenant's", async () => {
    vi.mocked(issueReward).mockImplementation(async (_tx, _g, input) => {
      if (input.referenceId === 'w-2') throw new RewardRefused('coupon_template_unavailable');
      return { rewardId: 'rw', prizeType: input.prize.prizeType, replay: false, grantId: null, coupon: null };
    });
    const { service, winners, events } = build();
    expect(await service.deliverDue(AT)).toEqual({ scanned: 1, delivered: 1, passedOn: 0, held: 1, failed: 0 });
    expect(winners.find((w) => w.id === 'w-2')).toMatchObject({ delivery: LotteryWinnerDelivery.pending, passedOnReason: null });
    expect(winners.find((w) => w.id === 'w-3')).toMatchObject({ prizeId: null });
    expect(events).toHaveLength(1);
    vi.mocked(issueReward).mockReset();
    vi.mocked(issueReward).mockImplementation(async () => ({ rewardId: 'rw-1', prizeType: 'bonus_traffic_gb', replay: false, grantId: 'g-1', coupon: null }));
  });

  it('touches only a drawn lottery', async () => {
    const { service } = build({ status: LotteryStatus.frozen });
    expect(await service.deliverDue(AT)).toEqual({ scanned: 0, delivered: 0, passedOn: 0, held: 0, failed: 0 });
  });
});

describe('LotteryResultService.result', () => {
  const caller = { userId: 'u-me', tenantId: TENANT };
  const SEED = 'ab'.repeat(32);

  function result(o: { status?: LotteryStatus; publishedAt?: Date | null; member?: boolean; entrant?: boolean } = {}) {
    const tx = {
      $executeRaw: async () => 0,
      lottery: { findFirst: async () => ({ id: LOT, title: 'Autumn draw', status: o.status ?? LotteryStatus.drawn, userGroupId: GROUP }) },
      userGroupMember: { findFirst: async () => (o.member === false ? null : { id: 'm-1' }) },
      lotteryEntrant: {
        findFirst: async () => (o.entrant === false ? null : { id: 'e-2', ticketNumber: 2, excludedReason: null }),
        findMany: async () => [
          { id: 'e-1', ticketNumber: 1 },
          { id: 'e-2', ticketNumber: 2 },
        ],
      },
      lotteryDraw: {
        findUnique: async () => ({ listHash: 'cd'.repeat(32), seedSealed: { kekId: 'kek-1' }, algorithm: 'hmac-sha256-fisher-yates-v1', entrantCount: 2, frozenAt: AT, drawnAt: AT, publishedAt: o.publishedAt === undefined ? AT : o.publishedAt }),
      },
      lotteryWinner: {
        findMany: async () => [
          { id: 'w-1', position: 1, entrantId: 'e-2', delivery: LotteryWinnerDelivery.passed_on, passedOnReason: 'inactive', replacesWinnerId: null, prize: { rank: 1, label: '20 GB' } },
          { id: 'w-2', position: 2, entrantId: 'e-1', delivery: LotteryWinnerDelivery.delivered, passedOnReason: null, replacesWinnerId: 'w-1', prize: { rank: 1, label: '20 GB' } },
        ],
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    const service = new LotteryResultService(prisma as never, { open: () => SEED } as never);
    return { result: (c: typeof caller, id: string) => runWithTenant({ id: TENANT }, () => service.result(c, id)) };
  }

  it('publishes the seed, the list, its hash and the places, with the caller’s own ticket', async () => {
    expect(await result().result(caller, LOT)).toEqual({
      lotteryId: LOT,
      title: 'Autumn draw',
      algorithm: 'hmac-sha256-fisher-yates-v1',
      seed: SEED,
      listHash: 'cd'.repeat(32),
      entrantCount: 2,
      frozenAt: AT,
      drawnAt: AT,
      tickets: [
        { ticketNumber: 1, entrantId: 'e-1' },
        { ticketNumber: 2, entrantId: 'e-2' },
      ],
      places: [
        { position: 1, ticketNumber: 2, prize: { rank: 1, label: '20 GB' }, delivery: LotteryWinnerDelivery.passed_on, passedOnReason: 'inactive', replacesPosition: null },
        { position: 2, ticketNumber: 1, prize: { rank: 1, label: '20 GB' }, delivery: LotteryWinnerDelivery.delivered, passedOnReason: null, replacesPosition: 1 },
      ],
      mine: { entrantId: 'e-2', ticketNumber: 2, excludedReason: null },
    });
  });

  it('shows nothing before the draw is published', async () => {
    await expect(result({ status: LotteryStatus.frozen }).result(caller, LOT)).rejects.toMatchObject({ reason: 'not_drawn' });
    await expect(result({ publishedAt: null }).result(caller, LOT)).rejects.toMatchObject({ reason: 'not_drawn' });
  });

  it('shows nothing to someone neither in the group nor in the list', async () => {
    await expect(result({ member: false, entrant: false }).result(caller, LOT)).rejects.toBeInstanceOf(LotteryEntryRefused);
    await expect(result({ member: false, entrant: false }).result(caller, LOT)).rejects.toMatchObject({ reason: 'lottery_not_found' });
    // An entrant since taken out of the group still sees the lottery it was in.
    await expect(result({ member: false }).result(caller, LOT)).resolves.toMatchObject({ mine: { entrantId: 'e-2' } });
  });
});
