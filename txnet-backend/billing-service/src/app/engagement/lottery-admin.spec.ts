/**
 * A tenant's lotteries (F-707-i, ADR-0111 points 5, 6).
 *
 * What would break silently here, and nowhere else:
 *  - a published lottery whose prizes, close time or group still move: the
 *    admin could steer the draw after users saw it (point 5) — every write
 *    but cancel is refused once it leaves `draft`;
 *  - a cancel with no public reason, or one after the freeze;
 *  - a prize that pays cash, or names another tenant's group, template or
 *    variant;
 *  - a close time already past, or too close for anyone to opt in;
 *  - an unaudited act;
 *  - a preview that counts otherwise than the freeze will, or a winners list
 *    shown before the draw (F-707-o).
 */
import { LotteryEntryMode, LotteryStatus, Prisma, SpinPrizeType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { LotteryAdminReportService } from './lottery-admin-report.service';
import { LotteryAdminRefused, LotteryAdminService, LotteryDraftInput } from './lottery-admin.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const GROUP = '66666666-6666-4666-8666-666666666666';
const OTHER_GROUP = '66666666-6666-4666-8666-666666666667';
const AT = new Date('2026-10-03T12:00:00Z');
const IN_A_WEEK = '2026-10-10T12:00:00.000Z';

type Row = Record<string, unknown> & { id: string; status: LotteryStatus };

function build(o: { lotteries?: Row[] } = {}) {
  const lotteries: Row[] = [...(o.lotteries ?? [])];
  const prizes: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const match = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(row[k]);
      if (v && typeof v === 'object' && 'gte' in v) return (row[k] as Date).getTime() >= (v.gte as Date).getTime();
      return row[k] === v;
    });
  const withParts = (row: Row) => ({ ...row, prizes: prizes.filter((p) => p.lotteryId === row.id), _count: { entrants: 0 } });
  const tx = {
    $executeRaw: async () => 0,
    coupon: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === TEMPLATE ? { id: TEMPLATE } : null) },
    productVariant: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === VARIANT ? { id: VARIANT } : null) },
    userGroup: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === GROUP ? { id: GROUP } : null) },
    lottery: {
      findMany: async () => [...lotteries].reverse().map(withParts),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const row = lotteries.find((l) => match(l, where));
        return row ? withParts(row) : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `lot-${lotteries.length + 1}`, status: LotteryStatus.draft, createdAt: AT, publishedAt: null, cancelledAt: null, cancelReason: null, ...data } as Row;
        lotteries.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = lotteries.filter((l) => match(l, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const gone = lotteries.filter((l) => match(l, where));
        gone.forEach((g) => lotteries.splice(lotteries.indexOf(g), 1));
        return { count: gone.length };
      },
    },
    lotteryPrize: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        prizes.push(...data.map((p, i) => ({ id: `pz-${prizes.length + i + 1}`, ...p })));
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: { lotteryId: string } }) => {
        const gone = prizes.filter((p) => p.lotteryId === where.lotteryId);
        gone.forEach((g) => prizes.splice(prizes.indexOf(g), 1));
        return { count: gone.length };
      },
    },
    adminAuditLog: { create: async ({ data }: { data: Record<string, unknown> }) => audits.push(data) },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { service: new LotteryAdminService(prisma as never, () => AT), lotteries, prizes, audits };
}

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const actor = { adminId: ADMIN, tenantId: TENANT, ip: '203.0.113.9' };

const draft: LotteryDraftInput = {
  userGroupId: GROUP,
  title: 'October draw',
  entryMode: LotteryEntryMode.opt_in,
  closesAt: IN_A_WEEK,
  reservesCount: 2,
  prizes: [
    { label: '50 GB', prizeType: SpinPrizeType.bonus_traffic_gb, prizeValue: '50', winnersCount: 1 },
    { label: '20% off', prizeType: SpinPrizeType.discount_coupon, prizeValue: '20', couponTemplateId: TEMPLATE, couponValidDays: 14, winnersCount: 5 },
  ],
};

const stored = (status: LotteryStatus, extra: Record<string, unknown> = {}): Row => ({
  id: 'lot-x',
  tenantId: TENANT,
  status,
  userGroupId: GROUP,
  title: 'Stored',
  description: null,
  entryMode: LotteryEntryMode.automatic,
  closesAt: new Date(IN_A_WEEK),
  requiresPhoneVerified: true,
  requiresMinAccountAgeHours: 24,
  reservesCount: 0,
  publishedAt: status === LotteryStatus.draft ? null : AT,
  cancelledAt: null,
  cancelReason: null,
  createdByAdminId: ADMIN,
  createdAt: AT,
  ...extra,
});

describe('LotteryAdminService.create', () => {
  it('writes a draft, its prizes ranked in the order sent, audited', async () => {
    const { service, lotteries, prizes, audits } = build();
    const view = await asTenant(() => service.create(actor, draft));

    expect(lotteries[0]).toMatchObject({ tenantId: TENANT, userGroupId: GROUP, status: LotteryStatus.draft, entryMode: LotteryEntryMode.opt_in, reservesCount: 2, createdByAdminId: ADMIN });
    expect((lotteries[0].closesAt as Date).toISOString()).toBe(IN_A_WEEK);
    expect(prizes.map((p) => [p.rank, p.prizeType, p.winnersCount, p.tenantId])).toEqual([
      [1, SpinPrizeType.bonus_traffic_gb, 1, TENANT],
      [2, SpinPrizeType.discount_coupon, 5, TENANT],
    ]);
    expect(view).toMatchObject({ status: LotteryStatus.draft, winnersTotal: 6, entrantCount: 0 });
    expect(audits).toEqual([expect.objectContaining({ tenantId: TENANT, adminId: ADMIN, action: 'lottery_create', targetEntityType: 'lottery', targetEntityId: 'lot-1' })]);
  });

  it.each([
    ['cash', { prizes: [{ label: 'cash', prizeType: SpinPrizeType.wallet_credit, prizeValue: '5', winnersCount: 1 }] }, 'invalid_prize'],
    ['an empty prize', { prizes: [{ label: 'none', prizeType: SpinPrizeType.empty, prizeValue: '0', winnersCount: 1 }] }, 'invalid_prize'],
    ['days that are not whole', { prizes: [{ label: 'd', prizeType: SpinPrizeType.extra_days, prizeValue: '1.5', winnersCount: 1 }] }, 'invalid_prize'],
    ['a coupon template that is not the tenant’s', { prizes: [{ ...draft.prizes[1], couponTemplateId: OTHER_GROUP }] }, 'coupon_template_not_found'],
    ['a variant the tenant cannot see', { prizes: [{ label: 'g', prizeType: SpinPrizeType.free_grant, prizeValue: '0', variantId: OTHER_GROUP, winnersCount: 1 }] }, 'variant_not_found'],
    ['a user group that is not the tenant’s', { userGroupId: OTHER_GROUP }, 'group_not_found'],
    ['a close time already past', { closesAt: '2026-10-01T00:00:00.000Z' }, 'invalid_close_time'],
    ['a close time under an hour away', { closesAt: '2026-10-03T12:30:00.000Z' }, 'invalid_close_time'],
  ])('refuses %s, writing nothing', async (_why, patch, reason) => {
    const { service, lotteries, prizes, audits } = build();
    const run = asTenant(() => service.create(actor, { ...draft, ...patch } as LotteryDraftInput));
    await expect(run).rejects.toBeInstanceOf(LotteryAdminRefused);
    await expect(run).rejects.toMatchObject({ reason });
    expect([lotteries, prizes, audits]).toEqual([[], [], []]);
  });
});

describe('LotteryAdminService.replace', () => {
  it('rewrites a draft and its prizes whole', async () => {
    const { service, lotteries, prizes, audits } = build({ lotteries: [stored(LotteryStatus.draft)] });
    await asTenant(() => service.replace(actor, 'lot-x', { ...draft, title: 'Renamed', prizes: [draft.prizes[0]] }));
    expect(lotteries[0]).toMatchObject({ title: 'Renamed', entryMode: LotteryEntryMode.opt_in });
    expect(prizes.map((p) => p.rank)).toEqual([1]);
    expect(audits).toEqual([expect.objectContaining({ action: 'lottery_update', targetEntityId: 'lot-x' })]);
  });

  it.each([LotteryStatus.published, LotteryStatus.frozen, LotteryStatus.drawn, LotteryStatus.cancelled])('refuses a %s lottery: its prizes and times are fixed', async (status) => {
    const { service, lotteries, audits } = build({ lotteries: [stored(status)] });
    await expect(asTenant(() => service.replace(actor, 'lot-x', draft))).rejects.toMatchObject({ reason: 'not_a_draft' });
    expect(lotteries[0].title).toBe('Stored');
    expect(audits).toEqual([]);
  });

  it('answers another tenant’s lottery, or none, as not found', async () => {
    const { service } = build();
    await expect(asTenant(() => service.replace(actor, 'lot-x', draft))).rejects.toMatchObject({ reason: 'lottery_not_found' });
  });
});

describe('LotteryAdminService.publish', () => {
  it('opens a draft for entry, stamped and audited', async () => {
    const { service, lotteries, audits } = build({ lotteries: [stored(LotteryStatus.draft)] });
    const view = await asTenant(() => service.publish(actor, 'lot-x'));
    expect(view).toMatchObject({ status: LotteryStatus.published, publishedAt: AT });
    expect(lotteries[0].status).toBe(LotteryStatus.published);
    expect(audits).toEqual([expect.objectContaining({ action: 'lottery_publish', targetEntityId: 'lot-x' })]);
  });

  it('refuses a draft whose close time has come too near since it was saved', async () => {
    const { service, lotteries } = build({ lotteries: [stored(LotteryStatus.draft, { closesAt: new Date('2026-10-03T12:20:00Z') })] });
    await expect(asTenant(() => service.publish(actor, 'lot-x'))).rejects.toMatchObject({ reason: 'invalid_close_time' });
    expect(lotteries[0].status).toBe(LotteryStatus.draft);
  });

  it('refuses a draft whose group has since been deleted', async () => {
    const { service } = build({ lotteries: [stored(LotteryStatus.draft, { userGroupId: OTHER_GROUP })] });
    await expect(asTenant(() => service.publish(actor, 'lot-x'))).rejects.toMatchObject({ reason: 'group_not_found' });
  });

  it('refuses a second publish', async () => {
    const { service } = build({ lotteries: [stored(LotteryStatus.published)] });
    await expect(asTenant(() => service.publish(actor, 'lot-x'))).rejects.toMatchObject({ reason: 'not_a_draft' });
  });
});

describe('LotteryAdminService.cancel', () => {
  it.each([LotteryStatus.draft, LotteryStatus.published])('cancels a %s lottery with its public reason, audited', async (status) => {
    const { service, lotteries, audits } = build({ lotteries: [stored(status)] });
    const view = await asTenant(() => service.cancel(actor, 'lot-x', '  The prize supplier withdrew.  '));
    expect(lotteries[0]).toMatchObject({ status: LotteryStatus.cancelled, cancelledAt: AT, cancelReason: 'The prize supplier withdrew.' });
    expect(view.cancelReason).toBe('The prize supplier withdrew.');
    expect(audits).toEqual([expect.objectContaining({ action: 'lottery_cancel', targetEntityId: 'lot-x' })]);
  });

  it.each([LotteryStatus.frozen, LotteryStatus.drawn, LotteryStatus.cancelled])('refuses a %s lottery: its list is fixed or its draw made', async (status) => {
    const { service, audits } = build({ lotteries: [stored(status)] });
    await expect(asTenant(() => service.cancel(actor, 'lot-x', 'Changed our mind'))).rejects.toMatchObject({ reason: 'not_cancellable' });
    expect(audits).toEqual([]);
  });

  it('refuses a blank reason', async () => {
    const { service } = build({ lotteries: [stored(LotteryStatus.published)] });
    await expect(asTenant(() => service.cancel(actor, 'lot-x', '   '))).rejects.toMatchObject({ reason: 'cancel_reason_required' });
  });
});

describe('LotteryAdminService.remove', () => {
  it('deletes a draft, audited', async () => {
    const { service, lotteries, audits } = build({ lotteries: [stored(LotteryStatus.draft)] });
    await asTenant(() => service.remove(actor, 'lot-x'));
    expect(lotteries).toEqual([]);
    expect(audits).toEqual([expect.objectContaining({ action: 'lottery_delete', targetEntityId: 'lot-x' })]);
  });

  it('refuses a published lottery: it is cancelled with a reason, never deleted', async () => {
    const { service, lotteries } = build({ lotteries: [stored(LotteryStatus.published)] });
    await expect(asTenant(() => service.remove(actor, 'lot-x'))).rejects.toMatchObject({ reason: 'not_a_draft' });
    expect(lotteries).toHaveLength(1);
  });
});

describe('LotteryAdminService.list', () => {
  it('shows prizes in rank order and money-free values as decimal strings', async () => {
    const { service, prizes } = build({ lotteries: [stored(LotteryStatus.draft)] });
    prizes.push({ id: 'p2', lotteryId: 'lot-x', rank: 2, label: 'b', prizeType: SpinPrizeType.extra_days, prizeValue: new Prisma.Decimal(7), winnersCount: 3 });
    prizes.push({ id: 'p1', lotteryId: 'lot-x', rank: 1, label: 'a', prizeType: SpinPrizeType.bonus_traffic_gb, prizeValue: new Prisma.Decimal(10), winnersCount: 1 });
    const [view] = await asTenant(() => service.list(actor));
    expect(view.prizes.map((p) => [p.rank, p.prizeValue])).toEqual([
      [1, '10.00'],
      [2, '7.00'],
    ]);
    expect(view.winnersTotal).toBe(4);
  });
});

// ------------------------------------------------- the admin's reads (F-707-o)

const OLD = new Date('2026-01-01T00:00:00Z');
const fineUser = { status: 'active', deletedAt: null, createdAt: OLD, phoneVerifiedAt: OLD, fullName: 'A User', username: null as string | null };

function buildReport(o: {
  lottery?: Row | null;
  members?: Array<{ memberType: 'user' | 'tenant'; userId: string | null }>;
  entrants?: Array<{ id: string; userId: string; optedInAt?: Date | null; ticketNumber?: number | null; excludedReason?: string | null }>;
  users?: Record<string, Partial<typeof fineUser>>;
  draw?: Record<string, unknown> | null;
  winners?: Array<Record<string, unknown>>;
} = {}) {
  const lot = o.lottery === undefined ? stored(LotteryStatus.draft) : o.lottery;
  const users = o.users ?? {};
  const entrants = (o.entrants ?? []).map((e) => ({ optedInAt: null, ticketNumber: null, excludedReason: null, ...e }));
  const tx = {
    $executeRaw: async () => 0,
    // No device behind several accounts in these cases.
    $queryRaw: async () => [],
    lottery: { findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => (lot && lot.id === where.id && where.tenantId === TENANT ? lot : null) },
    userGroupMember: { findMany: async () => o.members ?? [] },
    lotteryEntrant: { findMany: async () => entrants },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => id in users).map((id) => ({ id, ...fineUser, ...users[id] })),
    },
    fraudFlag: { findMany: async () => [] },
    lotteryDraw: { findUnique: async () => o.draw ?? null },
    lotteryWinner: { findMany: async () => o.winners ?? [] },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  return new LotteryAdminReportService(prisma as never, () => AT);
}

describe('LotteryAdminReportService.eligibility', () => {
  const members = [
    { memberType: 'user' as const, userId: 'u1' },
    { memberType: 'user' as const, userId: 'u2' },
    { memberType: 'user' as const, userId: 'u3' },
    { memberType: 'tenant' as const, userId: null },
  ];
  const users = { u1: {}, u2: { phoneVerifiedAt: null }, u3: { createdAt: new Date(AT.getTime() - 3_600_000) }, u4: {} };

  it('judges an automatic draft’s members as the freeze would, now; a reseller member is counted, not judged', async () => {
    const report = buildReport({ members, users });
    const e = await asTenant(() => report.eligibility(actor, 'lot-x'));
    expect(e).toMatchObject({ final: false, members: 3, eligibleMembers: 1, candidates: 3, eligible: 1, skippedResellerCount: 1 });
    expect(e.excluded).toEqual({ phone_unverified: 1, account_too_new: 1 });
  });

  it('judges an open opt-in lottery’s entrants so far, and still says how many members could enter', async () => {
    const report = buildReport({
      lottery: stored(LotteryStatus.published, { entryMode: LotteryEntryMode.opt_in }),
      members,
      users,
      entrants: [
        { id: 'e1', userId: 'u1', optedInAt: AT },
        { id: 'e4', userId: 'u4', optedInAt: AT },
      ],
    });
    const e = await asTenant(() => report.eligibility(actor, 'lot-x'));
    expect(e).toMatchObject({ final: false, members: 3, eligibleMembers: 1, candidates: 2, eligible: 1 });
    expect(e.excluded).toEqual({ not_in_group: 1 });
  });

  it('after the freeze reads the frozen list, never judges again', async () => {
    const report = buildReport({
      lottery: stored(LotteryStatus.drawn),
      members,
      users: {},
      entrants: [
        { id: 'e1', userId: 'u1', ticketNumber: 1 },
        { id: 'e2', userId: 'u2', ticketNumber: 2 },
        { id: 'e3', userId: 'u3', excludedReason: 'flagged' },
      ],
      draw: { skippedResellerCount: 4, frozenAt: AT },
    });
    const e = await asTenant(() => report.eligibility(actor, 'lot-x'));
    expect(e).toMatchObject({ final: true, members: null, eligibleMembers: null, candidates: 3, eligible: 2, skippedResellerCount: 4, excluded: { flagged: 1 } });
  });

  it('is lottery_not_found for another tenant’s lottery', async () => {
    const report = buildReport({ lottery: null });
    await expect(asTenant(() => report.eligibility(actor, 'lot-x'))).rejects.toMatchObject({ reason: 'lottery_not_found' });
  });
});

describe('LotteryAdminReportService.winners', () => {
  it('is not_drawn before the draw: the admin sees no place the users cannot', async () => {
    const report = buildReport({ lottery: stored(LotteryStatus.frozen), draw: { frozenAt: AT, drawnAt: null } });
    await expect(asTenant(() => report.winners(actor, 'lot-x'))).rejects.toMatchObject({ reason: 'not_drawn' });
  });

  it('names each place’s user, its ticket, prize and delivery, and which place a reserve took over', async () => {
    const report = buildReport({
      lottery: stored(LotteryStatus.drawn),
      entrants: [
        { id: 'e1', userId: 'u1', ticketNumber: 3 },
        { id: 'e2', userId: 'u2', ticketNumber: 1 },
      ],
      users: { u1: { fullName: 'Winner One', username: 'w1' }, u2: { fullName: 'Reserve Two' } },
      draw: { entrantCount: 2, frozenAt: AT, drawnAt: AT, publishedAt: AT },
      winners: [
        { id: 'w-1', position: 1, entrantId: 'e1', delivery: 'passed_on', deliveredAt: null, passedOnReason: 'inactive', replacesWinnerId: null, prize: { rank: 1, label: '50 GB' } },
        { id: 'w-2', position: 2, entrantId: 'e2', delivery: 'delivered', deliveredAt: AT, passedOnReason: null, replacesWinnerId: 'w-1', prize: { rank: 1, label: '50 GB' } },
      ],
    });
    const w = await asTenant(() => report.winners(actor, 'lot-x'));
    expect(w).toMatchObject({ lotteryId: 'lot-x', entrantCount: 2, drawnAt: AT, publishedAt: AT });
    expect(w.places).toEqual([
      { position: 1, ticketNumber: 3, user: { id: 'u1', fullName: 'Winner One', username: 'w1' }, prize: { rank: 1, label: '50 GB' }, delivery: 'passed_on', deliveredAt: null, passedOnReason: 'inactive', replacesPosition: null },
      { position: 2, ticketNumber: 1, user: { id: 'u2', fullName: 'Reserve Two', username: null }, prize: { rank: 1, label: '50 GB' }, delivery: 'delivered', deliveredAt: AT, passedOnReason: null, replacesPosition: 1 },
    ]);
  });
});
