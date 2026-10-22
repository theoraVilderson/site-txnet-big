import { runWithTenant } from '@txnet-backend/shared-core';

import { claimChats, proveLink, redeemClaim } from './link-writes';

/**
 * F-210 (ADR-0157): an import writes a source's Telegram id as a claim, never
 * a proof. What fails silently here: a claim that moves a chat already linked
 * to someone else (one customer's bot user handed to another), a claim that
 * replaces the link a person proved themselves, a claim that blocks the real
 * owner's contact card with a unique-key error, and a redemption that hands a
 * claimed account to a chat whose phone already decides who it is.
 */
describe('imported chat claims', () => {
  const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
  type Link = { id: string; tenantId: string; userId: string; platform: string; platformUserId: string; phoneNumber: string | null; claimedAt: Date | null; contactVerifiedAt: Date | null };
  type Person = { id: string; phoneNumber: string | null; phoneVerifiedAt: Date | null; deletedAt: Date | null };
  type Where = Record<string, unknown>;

  const build = (links: Array<Partial<Link> & Pick<Link, 'userId' | 'platformUserId'>> = [], people: Person[] = []) => {
    const rows: Link[] = links.map((l, i) => ({ id: `l-${i}`, tenantId: TENANT, platform: 'telegram', phoneNumber: null, claimedAt: null, contactVerifiedAt: null, ...l }));
    const users = new Map(people.map((p) => [p.id, { ...p }]));
    // Enough of Prisma's `where` for the filters link-writes uses: equality, `in`, `not`, `OR` and the user relation.
    const matches = (l: Link, where: Where): boolean =>
      Object.entries(where).every(([k, v]) => {
        if (k === 'OR') return (v as Where[]).some((w) => matches(l, w));
        if (k === 'user') return Object.entries(v as Partial<Person>).every(([uk, uv]) => users.get(l.userId)?.[uk as keyof Person] === uv);
        const have = l[k as keyof Link];
        if (v && typeof v === 'object' && 'in' in v) return (v as { in: unknown[] }).in.includes(have);
        if (v && typeof v === 'object' && 'not' in v) return have !== (v as { not: unknown }).not;
        return have === v;
      });
    const db = {
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)),
      linkedBotAccount: {
        findMany: vi.fn(async ({ where }: { where: Where }) => rows.filter((l) => matches(l, where))),
        findFirst: vi.fn(async ({ where }: { where: Where }) => rows.find((l) => matches(l, where)) ?? null),
        createMany: vi.fn(async ({ data }: { data: Link[] }) => {
          rows.push(...data.map((d, i) => ({ id: `new-${rows.length + i}`, phoneNumber: null, contactVerifiedAt: null, ...d })));
          return { count: data.length };
        }),
        deleteMany: vi.fn(async ({ where }: { where: Where }) => {
          const gone = rows.filter((l) => matches(l, where));
          for (const l of gone) rows.splice(rows.indexOf(l), 1);
          return { count: gone.length };
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Link> }) => Object.assign(rows.find((l) => l.id === where.id) ?? {}, data)),
        upsert: vi.fn(async ({ where, create, update }: { where: { userId_platform: { userId: string; platform: string } }; create: Link; update: Partial<Link> }) => {
          const { userId, platform } = where.userId_platform;
          const found = rows.find((l) => l.userId === userId && l.platform === platform);
          if (found) return Object.assign(found, update);
          // linked_bot_account_tenantId_platform_platformUserId_key, as Postgres would refuse it.
          if (rows.some((l) => l.platform === create.platform && l.platformUserId === create.platformUserId)) throw new Error('P2002');
          rows.push({ ...create, id: `new-${rows.length}`, claimedAt: null });
          return create;
        }),
      },
      user: {
        updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Person> }) => {
          const u = users.get(where.id);
          if (!u || u.phoneNumber !== null) return { count: 0 };
          Object.assign(u, data);
          return { count: 1 };
        }),
      },
    };
    const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT } as never, fn);
    return { db, rows, users, inTenant };
  };

  describe('claimChats (the import)', () => {
    it('writes a claim — claimed, never verified — for a person with no Telegram link', async () => {
      const { db, rows } = build();
      const outcome = await claimChats(db as never, TENANT, 'telegram', [{ userId: 'u-1', chatId: '123456' }]);
      expect(outcome.get('u-1')).toBe('claimed');
      expect(rows).toEqual([expect.objectContaining({ userId: 'u-1', platformUserId: '123456', tenantId: TENANT, claimedAt: expect.any(Date), contactVerifiedAt: null })]);
    });

    it('reports a chat already linked to another person and never moves it', async () => {
      const { db, rows } = build([{ userId: 'u-other', platformUserId: '123456', contactVerifiedAt: new Date() }]);
      const outcome = await claimChats(db as never, TENANT, 'telegram', [{ userId: 'u-1', chatId: '123456' }]);
      expect(outcome.get('u-1')).toBe('taken');
      expect(rows.map((l) => l.userId)).toEqual(['u-other']);
    });

    it('keeps the chat a person already linked to, over the one the source names', async () => {
      const { db, rows } = build([{ userId: 'u-1', platformUserId: '999', contactVerifiedAt: new Date() }]);
      const outcome = await claimChats(db as never, TENANT, 'telegram', [{ userId: 'u-1', chatId: '123456' }]);
      expect(outcome.get('u-1')).toBe('has_other');
      expect(rows.map((l) => l.platformUserId)).toEqual(['999']);
    });

    it('answers a re-run claimed and writes nothing twice; two people naming one chat, the first holds it', async () => {
      const { db, rows } = build([{ userId: 'u-1', platformUserId: '123456', claimedAt: new Date() }]);
      const outcome = await claimChats(db as never, TENANT, 'telegram', [
        { userId: 'u-1', chatId: '123456' },
        { userId: 'u-2', chatId: '777' },
        { userId: 'u-3', chatId: '777' },
      ]);
      expect(Object.fromEntries(outcome)).toEqual({ 'u-1': 'claimed', 'u-2': 'claimed', 'u-3': 'taken' });
      expect(rows.map((l) => [l.userId, l.platformUserId])).toEqual([['u-1', '123456'], ['u-2', '777']]);
    });
  });

  describe('redeemClaim (the chat shares its own contact card)', () => {
    it('gives the claimed person the card phone as verified and proves the link', async () => {
      const { db, rows, users, inTenant } = build([{ userId: 'u-1', platformUserId: '123456', claimedAt: new Date() }], [{ id: 'u-1', phoneNumber: null, phoneVerifiedAt: null, deletedAt: null }]);
      const userId = await inTenant(() => redeemClaim(db as never, { platform: 'telegram', chatId: '123456', phoneNumber: '+989121234567' }));
      expect(userId).toBe('u-1');
      expect(users.get('u-1')).toEqual(expect.objectContaining({ phoneNumber: '+989121234567', phoneVerifiedAt: expect.any(Date) }));
      expect(rows[0]).toEqual(expect.objectContaining({ phoneNumber: '+989121234567', contactVerifiedAt: expect.any(Date) }));
    });

    it('never redeems a person who has a phone: the phone already decides who they are', async () => {
      const { db, rows, inTenant } = build([{ userId: 'u-1', platformUserId: '123456', claimedAt: new Date() }], [{ id: 'u-1', phoneNumber: '+989120000000', phoneVerifiedAt: new Date(), deletedAt: null }]);
      const userId = await inTenant(() => redeemClaim(db as never, { platform: 'telegram', chatId: '123456', phoneNumber: '+989121234567' }));
      expect(userId).toBeNull();
      expect(rows[0].contactVerifiedAt).toBeNull();
    });
  });

  describe('proveLink (a contact card proves the chat is another person)', () => {
    it("releases another person's claim on the chat instead of failing on the unique key", async () => {
      const { db, rows, inTenant } = build([{ userId: 'u-imported', platformUserId: '123456', claimedAt: new Date() }]);
      await inTenant(() => proveLink(db as never, { userId: 'u-real', platform: 'telegram', chatId: '123456', phoneNumber: '+989121234567' }));
      expect(rows).toEqual([expect.objectContaining({ userId: 'u-real', platformUserId: '123456', contactVerifiedAt: expect.any(Date) })]);
    });

    it("never releases another person's proven link", async () => {
      const { db, inTenant } = build([{ userId: 'u-other', platformUserId: '123456', contactVerifiedAt: new Date() }]);
      await expect(inTenant(() => proveLink(db as never, { userId: 'u-real', platform: 'telegram', chatId: '123456', phoneNumber: '+989121234567' }))).rejects.toThrow('P2002');
    });
  });
});
