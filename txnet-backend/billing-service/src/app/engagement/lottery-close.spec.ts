/**
 * A lottery's close (F-707-k, ADR-0111 points 5, 6).
 *
 * What would break silently here, and nowhere else:
 *  - a seed that exists while the list can still move: the freeze writes the
 *    tickets and the list hash first, and only then makes the seed, all in
 *    the one transaction that moves the lottery to `frozen`;
 *  - a seed stored in the clear, or made twice: it is sealed (ADR-0022) into
 *    the draw row, whose key is the lottery — a second close finds nothing;
 *  - an ineligible member with a ticket, or an eligible one without: every
 *    candidate is judged on what is true at the close, and the reason kept;
 *  - a list hash that depends on anything but the tickets: the verify page
 *    (F-707-n) recomputes it from what is published;
 *  - a reseller member of a platform group entered, or silently dropped.
 */
import { createHash } from 'node:crypto';

import { LotteryEntryMode, LotteryStatus, UserStatus } from '@prisma/client';
import { LOTTERY_ALGORITHM, lotteryListHash } from '@txnet-backend/shared-core';

import { LotteryCloseService, judgeCandidate } from './lottery-close.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = '66666666-6666-4666-8666-666666666666';
const LOT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const AT = new Date('2026-10-10T12:00:00Z');
const OLD = new Date('2026-01-01T00:00:00Z');
const u = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

const rules = { requiresPhoneVerified: true, requiresMinAccountAgeHours: 24 };
const fine = { status: UserStatus.active, deletedAt: null, createdAt: OLD, phoneVerifiedAt: OLD, openFlags: 0, accountsOnFingerprint: 1 };

describe('judgeCandidate', () => {
  it.each([
    ['an eligible member', { inGroup: true }, fine, null],
    ['a member with no fingerprint recorded (user, 2026-10-03)', { inGroup: true }, { ...fine, accountsOnFingerprint: 0 }, null],
    ['an opt-in since taken out of the group', { inGroup: false }, fine, 'not_in_group'],
    ['a deleted account', { inGroup: true }, undefined, 'inactive'],
    ['a banned account', { inGroup: true }, { ...fine, status: UserStatus.banned }, 'inactive'],
    ['an account under the minimum age', { inGroup: true }, { ...fine, createdAt: new Date('2026-10-10T00:00:00Z') }, 'account_too_new'],
    ['an unverified phone', { inGroup: true }, { ...fine, phoneVerifiedAt: null }, 'phone_unverified'],
    ['an open fraud flag', { inGroup: true }, { ...fine, openFlags: 1 }, 'flagged'],
    ['a device behind 5 accounts in 30 days', { inGroup: true }, { ...fine, accountsOnFingerprint: 5 }, 'shared_device'],
  ])('%s', (_why, c, facts, reason) => {
    expect(judgeCandidate(c, facts, rules, AT)).toBe(reason);
  });

  it('skips the phone rule when the lottery does not ask for it', () => {
    expect(judgeCandidate({ inGroup: true }, { ...fine, phoneVerifiedAt: null }, { ...rules, requiresPhoneVerified: false }, AT)).toBeNull();
  });
});

describe('lotteryListHash', () => {
  it('is the SHA-256 of the lottery and its tickets in ticket order, whatever order they come in', async () => {
    const a = await lotteryListHash(LOT, [
      { ticketNumber: 2, entrantId: 'e-2' },
      { ticketNumber: 1, entrantId: 'e-1' },
    ]);
    const expected = createHash('sha256').update(`txnet-lottery-list-v1\n${LOT}\n1:e-1\n2:e-2\n`).digest('hex');
    expect(a).toBe(expected);
    expect(await lotteryListHash(LOT, [{ ticketNumber: 1, entrantId: 'e-1' }, { ticketNumber: 2, entrantId: 'e-2' }])).toBe(expected);
    expect(await lotteryListHash(LOT, [{ ticketNumber: 1, entrantId: 'e-2' }, { ticketNumber: 2, entrantId: 'e-1' }])).not.toBe(expected);
  });
});

type Lot = { id: string; tenantId: string; userGroupId: string; entryMode: LotteryEntryMode; status: LotteryStatus; closesAt: Date; requiresPhoneVerified: boolean; requiresMinAccountAgeHours: number };
type Entrant = { id: string; tenantId: string; lotteryId: string; userId: string; optedInAt: Date | null; ticketNumber: number | null; excludedReason: string | null };

function build(o: {
  lot?: Partial<Lot>;
  members?: Array<{ memberType: 'user' | 'tenant'; userId: string | null }>;
  entrants?: Entrant[];
  users?: Record<string, Partial<typeof fine>>;
  flagged?: string[];
  shared?: Record<string, number>;
  sealing?: boolean;
} = {}) {
  const lot: Lot = { id: LOT, tenantId: TENANT, userGroupId: GROUP, entryMode: LotteryEntryMode.automatic, status: LotteryStatus.published, closesAt: AT, requiresPhoneVerified: true, requiresMinAccountAgeHours: 24, ...o.lot };
  const entrants: Entrant[] = [...(o.entrants ?? [])];
  const draws: Record<string, unknown>[] = [];
  const events: string[] = [];
  const users = o.users ?? {};
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE')) {
        events.push('lock');
        return lot.status === LotteryStatus.published && lot.closesAt.getTime() <= AT.getTime() ? [lot] : [];
      }
      if (sql.includes('device_fingerprint')) return Object.entries(o.shared ?? {}).map(([userId, accounts]) => ({ userId, accounts }));
      throw new Error(`unexpected sql ${sql}`);
    },
    userGroupMember: { findMany: async () => o.members ?? [] },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => users[id] !== undefined || !(o.users && id in o.users)).map((id) => ({ id, ...fine, ...users[id] })),
    },
    fraudFlag: { findMany: async () => (o.flagged ?? []).map((subjectId) => ({ subjectId })) },
    lotteryEntrant: {
      findMany: async () => entrants.map((e) => ({ id: e.id, userId: e.userId, optedInAt: e.optedInAt })),
      createMany: async ({ data }: { data: Entrant[] }) => {
        events.push('entrants');
        entrants.push(...data.map((d) => ({ ticketNumber: null, excludedReason: null, optedInAt: null, ...d })));
        return { count: data.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Entrant> }) => {
        events.push('entrants');
        Object.assign(entrants.find((e) => e.id === where.id) as Entrant, data);
        return {};
      },
    },
    lotteryDraw: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push('draw');
        draws.push(data);
        return data;
      },
    },
    lottery: {
      updateMany: async ({ where, data }: { where: { status: LotteryStatus }; data: { status: LotteryStatus } }) => {
        events.push('frozen');
        if (lot.status !== where.status) return { count: 0 };
        lot.status = data.status;
        return { count: 1 };
      },
    },
  };
  const sealed: string[] = [];
  const seal = {
    seal: (seed: string) => {
      events.push('seed');
      sealed.push(seed);
      return o.sealing === false ? null : { kekId: 'kek-1', iv: 'iv', authTag: 'tag', ciphertext: `sealed(${seed.length})` };
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const crossTenant = { lottery: { findMany: async () => (lot.status === LotteryStatus.published && lot.closesAt <= AT ? [{ id: LOT, tenantId: TENANT }] : []) } };
  const service = new LotteryCloseService(prisma as never, crossTenant as never, seal as never);
  return { service, lot, entrants, draws, events, sealed };
}

describe('LotteryCloseService.closeDue', () => {
  it('freezes an automatic lottery: every user member judged, tickets 1..n, resellers skipped and counted, then the seed, sealed', async () => {
    const { service, lot, entrants, draws, events, sealed } = build({
      members: [
        { memberType: 'user', userId: u(3) },
        { memberType: 'user', userId: u(1) },
        { memberType: 'user', userId: u(2) },
        { memberType: 'tenant', userId: null },
        { memberType: 'tenant', userId: null },
      ],
      flagged: [u(2)],
    });
    expect(await service.closeDue(AT)).toEqual({ scanned: 1, frozen: 1, failed: 0 });

    expect(lot.status).toBe(LotteryStatus.frozen);
    const byUser = Object.fromEntries(entrants.map((e) => [e.userId, [e.ticketNumber, e.excludedReason]]));
    expect(byUser).toEqual({ [u(1)]: [1, null], [u(3)]: [2, null], [u(2)]: [null, 'flagged'] });

    const tickets = entrants.filter((e) => e.ticketNumber !== null).map((e) => ({ ticketNumber: e.ticketNumber as number, entrantId: e.id }));
    expect(draws).toEqual([
      {
        lotteryId: LOT,
        tenantId: TENANT,
        entrantCount: 2,
        skippedResellerCount: 2,
        listHash: await lotteryListHash(LOT, tickets),
        seedSealed: { kekId: 'kek-1', iv: 'iv', authTag: 'tag', ciphertext: 'sealed(64)' },
        algorithm: LOTTERY_ALGORITHM,
        frozenAt: AT,
        drawnAt: null,
      },
    ]);
    // 32 random bytes, hex; never the same twice.
    expect(sealed[0]).toMatch(/^[0-9a-f]{64}$/);
    // The list is written and hashed before the seed exists; the status moves last.
    expect(events).toEqual(['lock', 'entrants', 'seed', 'draw', 'frozen']);
  });

  it('freezes an opt-in lottery from its entrants only, numbering by entry time', async () => {
    const e = (n: number, at: string): Entrant => ({ id: `e-${n}`, tenantId: TENANT, lotteryId: LOT, userId: u(n), optedInAt: new Date(at), ticketNumber: null, excludedReason: null });
    const { service, entrants, draws } = build({
      lot: { entryMode: LotteryEntryMode.opt_in },
      members: [{ memberType: 'user', userId: u(1) }, { memberType: 'user', userId: u(2) }, { memberType: 'user', userId: u(9) }],
      entrants: [e(2, '2026-10-05T00:00:00Z'), e(1, '2026-10-06T00:00:00Z'), e(4, '2026-10-04T00:00:00Z')],
      shared: { [u(1)]: 6 },
    });
    await service.closeDue(AT);
    expect(entrants.map((x) => [x.id, x.ticketNumber, x.excludedReason])).toEqual([
      ['e-2', 1, null],
      ['e-1', null, 'shared_device'],
      ['e-4', null, 'not_in_group'],
    ]);
    expect(draws[0]).toMatchObject({ entrantCount: 1, skippedResellerCount: 0 });
  });

  it('freezes with no eligible entrant: an empty list still has its hash and its seed', async () => {
    const { service, lot, draws } = build({ members: [] });
    await service.closeDue(AT);
    expect(lot.status).toBe(LotteryStatus.frozen);
    expect(draws[0]).toMatchObject({ entrantCount: 0, listHash: await lotteryListHash(LOT, []) });
  });

  it('leaves the lottery open, and counts a failure, when no key can seal the seed', async () => {
    const { service, lot, draws } = build({ members: [{ memberType: 'user', userId: u(1) }], sealing: false });
    expect(await service.closeDue(AT)).toEqual({ scanned: 1, frozen: 0, failed: 1 });
    expect(lot.status).toBe(LotteryStatus.published);
    expect(draws).toEqual([]);
  });

  it('does nothing to a lottery another run froze first', async () => {
    const { service, draws } = build({ lot: { status: LotteryStatus.frozen } });
    expect(await service.closeDue(AT)).toEqual({ scanned: 0, frozen: 0, failed: 0 });
    expect(draws).toEqual([]);
  });
});
