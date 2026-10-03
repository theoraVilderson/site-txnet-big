/**
 * A user's lottery entry (F-707-j, ADR-0111 point 6).
 *
 * What would break silently here, and nowhere else:
 *  - two entries for one user: twice the chance (the database unique holds
 *    it; a retried tap must answer the first entry, not fail);
 *  - an entry after the close time, or once the list is frozen: the close
 *    job (F-707-k) would draw from a list that moved under it — so the
 *    lottery row is read `FOR SHARE`, queueing behind the freeze;
 *  - an entry by someone outside the group, or into an `automatic` lottery;
 *  - a draft, or another group's lottery, shown to a user.
 */
import { LotteryEntryMode, LotteryStatus, Prisma, SpinPrizeType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { LotteryEntryRefused, LotteryEntryService } from './lottery-entry.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GROUP = '66666666-6666-4666-8666-666666666666';
const OTHER_GROUP = '66666666-6666-4666-8666-666666666667';
const AT = new Date('2026-10-03T12:00:00Z');

type Lot = { id: string; tenantId: string; status: LotteryStatus; entryMode: LotteryEntryMode; closesAt: Date; userGroupId: string; publishedAt: Date | null; [k: string]: unknown };
type Entrant = { lotteryId: string; userId: string; optedInAt: Date | null; ticketNumber: number | null; excludedReason: string | null; tenantId: string };

const lot = (id: string, o: Partial<Lot> = {}): Lot => ({
  id,
  tenantId: TENANT,
  status: LotteryStatus.published,
  entryMode: LotteryEntryMode.opt_in,
  closesAt: new Date('2026-10-10T12:00:00Z'),
  userGroupId: GROUP,
  publishedAt: new Date('2026-10-01T00:00:00Z'),
  title: `Lottery ${id}`,
  description: null,
  cancelReason: null,
  ...o,
});

function build(o: { lotteries?: Lot[]; entrants?: Entrant[]; groups?: string[]; raceOnInsert?: boolean } = {}) {
  const lotteries = o.lotteries ?? [lot('lot-1')];
  const entrants: Entrant[] = [...(o.entrants ?? [])];
  const groups = o.groups ?? [GROUP];
  const locks: string[] = [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FOR SHARE')) locks.push(String(values[0]));
      return lotteries.filter((l) => l.id === values[0]);
    },
    userGroupMember: {
      findFirst: async ({ where }: { where: { groupId: string; userId: string } }) => (where.userId === USER && groups.includes(where.groupId) ? { id: 'm' } : null),
      findMany: async () => groups.map((groupId) => ({ groupId })),
    },
    lotteryEntrant: {
      findFirst: async ({ where }: { where: { lotteryId: string; userId: string } }) => entrants.find((e) => e.lotteryId === where.lotteryId && e.userId === where.userId) ?? null,
      findMany: async () => entrants.filter((e) => e.userId === USER),
      create: async ({ data }: { data: Entrant }) => {
        if (o.raceOnInsert) {
          entrants.push({ ...data, optedInAt: new Date('2026-10-03T11:59:59Z') });
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });
        }
        entrants.push({ ticketNumber: null, excludedReason: null, ...data });
        return data;
      },
      deleteMany: async ({ where }: { where: { lotteryId: string; userId: string } }) => {
        const gone = entrants.filter((e) => e.lotteryId === where.lotteryId && e.userId === where.userId);
        gone.forEach((g) => entrants.splice(entrants.indexOf(g), 1));
        return { count: gone.length };
      },
    },
    lottery: {
      findMany: async ({ where }: { where: { OR: Array<{ userGroupId?: { in: string[] }; id?: { in: string[] } }> } }) => {
        const [byGroup, byEntry] = where.OR;
        return lotteries
          .filter((l) => l.publishedAt !== null && (byGroup.userGroupId?.in.includes(l.userGroupId) || byEntry.id?.in.includes(l.id)))
          .map((l) => ({ ...l, prizes: [{ rank: 1, label: '50 GB', prizeType: SpinPrizeType.bonus_traffic_gb, prizeValue: new Prisma.Decimal(50), winnersCount: 1 }] }));
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { service: new LotteryEntryService(prisma as never, () => AT), entrants, locks };
}

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const caller = { userId: USER, tenantId: TENANT };

describe('LotteryEntryService.join', () => {
  it('enters a group member into an open opt-in lottery, behind a share lock on the lottery', async () => {
    const { service, entrants, locks } = build();
    const out = await asTenant(() => service.join(caller, 'lot-1'));
    expect(out).toEqual({ lotteryId: 'lot-1', joined: true, optedInAt: AT, replay: false });
    expect(entrants).toEqual([expect.objectContaining({ tenantId: TENANT, lotteryId: 'lot-1', userId: USER, optedInAt: AT })]);
    expect(locks).toEqual(['lot-1']);
  });

  it('answers a second join with the first entry: one entry per user', async () => {
    const first = new Date('2026-10-02T08:00:00Z');
    const { service, entrants } = build({ entrants: [{ tenantId: TENANT, lotteryId: 'lot-1', userId: USER, optedInAt: first, ticketNumber: null, excludedReason: null }] });
    const out = await asTenant(() => service.join(caller, 'lot-1'));
    expect(out).toEqual({ lotteryId: 'lot-1', joined: true, optedInAt: first, replay: true });
    expect(entrants).toHaveLength(1);
  });

  it('answers a join that lost a race to its own retry with the entry the database kept', async () => {
    const { service } = build({ raceOnInsert: true });
    const out = await asTenant(() => service.join(caller, 'lot-1'));
    expect(out).toMatchObject({ joined: true, replay: true, optedInAt: new Date('2026-10-03T11:59:59Z') });
  });

  it.each([
    ['a lottery that does not exist', { lotteries: [] }, 'lottery_not_found'],
    ['a draft', { lotteries: [lot('lot-1', { status: LotteryStatus.draft, publishedAt: null })] }, 'lottery_not_found'],
    ['someone outside the group', { groups: [OTHER_GROUP] }, 'lottery_not_found'],
    ['an automatic lottery', { lotteries: [lot('lot-1', { entryMode: LotteryEntryMode.automatic })] }, 'not_opt_in'],
    ['a lottery past its close time, not yet frozen', { lotteries: [lot('lot-1', { closesAt: AT })] }, 'closed'],
    ['a frozen lottery', { lotteries: [lot('lot-1', { status: LotteryStatus.frozen })] }, 'closed'],
    ['a cancelled lottery', { lotteries: [lot('lot-1', { status: LotteryStatus.cancelled })] }, 'closed'],
  ])('refuses %s, writing nothing', async (_why, opts, reason) => {
    const { service, entrants } = build(opts as never);
    const run = asTenant(() => service.join(caller, 'lot-1'));
    await expect(run).rejects.toBeInstanceOf(LotteryEntryRefused);
    await expect(run).rejects.toMatchObject({ reason });
    expect(entrants).toEqual([]);
  });
});

describe('LotteryEntryService.leave', () => {
  const mine: Entrant = { tenantId: TENANT, lotteryId: 'lot-1', userId: USER, optedInAt: AT, ticketNumber: null, excludedReason: null };

  it('takes the entry out while the lottery is open', async () => {
    const { service, entrants, locks } = build({ entrants: [mine] });
    expect(await asTenant(() => service.leave(caller, 'lot-1'))).toEqual({ lotteryId: 'lot-1', joined: false, replay: false });
    expect(entrants).toEqual([]);
    expect(locks).toEqual(['lot-1']);
  });

  it('answers a second leave as done', async () => {
    const { service } = build();
    expect(await asTenant(() => service.leave(caller, 'lot-1'))).toEqual({ lotteryId: 'lot-1', joined: false, replay: true });
  });

  it('lets an entrant leave after being taken out of the group', async () => {
    const { service, entrants } = build({ entrants: [mine], groups: [] });
    await asTenant(() => service.leave(caller, 'lot-1'));
    expect(entrants).toEqual([]);
  });

  it('refuses once the close time has passed: the list is about to be frozen', async () => {
    const { service, entrants } = build({ entrants: [mine], lotteries: [lot('lot-1', { closesAt: new Date('2026-10-03T11:00:00Z') })] });
    await expect(asTenant(() => service.leave(caller, 'lot-1'))).rejects.toMatchObject({ reason: 'closed' });
    expect(entrants).toHaveLength(1);
  });
});

describe('LotteryEntryService.list', () => {
  it('shows the published lotteries of the caller’s groups and those it entered, never a draft, with its own entry', async () => {
    const { service } = build({
      lotteries: [
        lot('open'),
        lot('draft', { status: LotteryStatus.draft, publishedAt: null }),
        lot('other-group', { userGroupId: OTHER_GROUP }),
        lot('entered-elsewhere', { userGroupId: OTHER_GROUP, status: LotteryStatus.drawn }),
        lot('closed', { closesAt: new Date('2026-10-03T11:00:00Z') }),
      ],
      entrants: [{ tenantId: TENANT, lotteryId: 'entered-elsewhere', userId: USER, optedInAt: null, ticketNumber: 7, excludedReason: null }],
    });
    const views = await asTenant(() => service.list(caller));
    expect(views.map((v) => [v.id, v.open, v.entry?.ticketNumber ?? null])).toEqual([
      ['open', true, null],
      ['entered-elsewhere', false, 7],
      ['closed', false, null],
    ]);
    expect(views[0].prizes).toEqual([{ rank: 1, label: '50 GB', prizeType: SpinPrizeType.bonus_traffic_gb, prizeValue: '50.00', winnersCount: 1 }]);
  });
});
