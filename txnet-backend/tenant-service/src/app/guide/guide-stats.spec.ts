/**
 * Guide views and votes (F-414-l, ADR-0119): a view counts once per viewer,
 * guide, UTC day and surface; Redis down counts nothing rather than twice; a
 * vote names the guide the voter's tenant sees now, one per user; the numbers
 * are the reading tenant's — a reseller its own, the platform owner every
 * tenant's for the platform's guides.
 *
 * The RLS half (a tenant's rows are its own) is the migration's; this is the
 * service's.
 */
import { runWithTenant } from '@txnet-backend/shared-core';

import { GuideRefused } from './guide-admin';
import { GuideStats, statsOf, viewerHash } from './guide-stats';

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // a platform guide
const AG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // A's own guide

type View = { tenantId: string; guideId: string; day: Date; surface: 'panel' | 'bot'; views: number };
type Vote = { tenantId: string; guideId: string; userId: string; helpful: boolean };

function harness(opts: { redisDown?: boolean } = {}) {
  const marks = new Set<string>();
  const views: View[] = [];
  const votes: Vote[] = [];
  const owners = new Map<string, string | null>([
    [PG, null],
    [AG, A],
  ]);
  const ownerOf = (id: string) => owners.get(id);
  const tx = {
    $executeRaw: async () => 0,
    guideViewDaily: {
      upsert: async ({ where, create }: any) => {
        const k = where.tenantId_guideId_day_surface;
        const hit = views.find((v) => v.tenantId === k.tenantId && v.guideId === k.guideId && +v.day === +k.day && v.surface === k.surface);
        if (hit) hit.views += 1;
        else views.push({ ...create });
      },
      groupBy: async ({ where }: any) => viewsWhere(where),
    },
    guideVote: {
      upsert: async ({ where, create, update }: any) => {
        const k = where.tenantId_guideId_userId;
        const hit = votes.find((v) => v.tenantId === k.tenantId && v.guideId === k.guideId && v.userId === k.userId);
        if (hit) hit.helpful = update.helpful;
        else votes.push({ ...create });
        return { helpful: (hit ?? create).helpful };
      },
      findUnique: async ({ where }: any) => {
        const k = where.tenantId_guideId_userId;
        return votes.find((v) => v.tenantId === k.tenantId && v.guideId === k.guideId && v.userId === k.userId) ?? null;
      },
      groupBy: async ({ where }: any) => votesWhere(where),
    },
  };
  const matchesOwner = (guideId: string, where: any) => (where.guide ? ownerOf(guideId) === where.guide.tenantId : true);
  const viewsWhere = (where: any) =>
    views
      .filter((v) => (where.tenantId ? v.tenantId === where.tenantId : true) && v.day >= where.day.gte && matchesOwner(v.guideId, where))
      .map((v) => ({ guideId: v.guideId, surface: v.surface, _sum: { views: v.views } }));
  const votesWhere = (where: any) =>
    votes
      .filter((v) => (where.tenantId ? v.tenantId === where.tenantId : true) && matchesOwner(v.guideId, where))
      .map((v) => ({ guideId: v.guideId, helpful: v.helpful, _count: { _all: 1 } }));

  const prisma = { $transaction: (fn: any) => fn(tx) } as any;
  const all = { $transaction: (fn: any) => fn(tx) } as any;
  const redis = {
    setIfAbsentWithTtl: async (key: string) => {
      if (opts.redisDown) throw new Error('redis down');
      if (marks.has(key)) return false;
      marks.add(key);
      return true;
    },
  } as any;
  // A sees the platform guide and its own; B sees only the platform's.
  const reader = {
    one: async (tenantId: string, key: string) => ({
      etag: null,
      body: {
        guide:
          key === 'android' ? { id: PG, key } : key === 'mine' && tenantId === A ? { id: AG, key } : null,
      },
    }),
  } as any;
  const platform = { id: async () => PLATFORM } as any;
  const stats = new GuideStats(prisma, all, redis, reader, platform);
  return { stats, views, votes };
}

const at = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => runWithTenant({ id: tenantId }, fn);
const DAY1 = new Date('2026-10-04T10:00:00Z');
const DAY2 = new Date('2026-10-05T01:00:00Z');

describe('a view', () => {
  it('counts once per viewer, guide, UTC day and surface', async () => {
    const { stats, views } = harness();
    const one = viewerHash('1.2.3.4', 'Firefox');
    expect(await at(A, () => stats.view(A, 'android', 'panel', one, 'fa', DAY1))).toBe('counted');
    expect(await at(A, () => stats.view(A, 'android', 'panel', one, 'fa', DAY1))).toBe('seen');
    expect(await at(A, () => stats.view(A, 'android', 'bot', one, 'fa', DAY1))).toBe('counted');
    expect(await at(A, () => stats.view(A, 'android', 'panel', viewerHash('5.6.7.8', 'Firefox'), 'fa', DAY1))).toBe('counted');
    expect(await at(A, () => stats.view(A, 'android', 'panel', one, 'fa', DAY2))).toBe('counted');
    expect(views.map((v) => `${v.day.toISOString().slice(0, 10)}:${v.surface}:${v.views}`)).toEqual([
      '2026-10-04:panel:2',
      '2026-10-04:bot:1',
      '2026-10-05:panel:1',
    ]);
  });

  it('is counted against the reading tenant and the guide row it showed', async () => {
    const { stats, views } = harness();
    await at(B, () => stats.view(B, 'android', 'panel', 'v', 'fa', DAY1));
    expect(views).toEqual([expect.objectContaining({ tenantId: B, guideId: PG })]);
  });

  it('counts nothing when Redis cannot say whether it was seen — never twice', async () => {
    const { stats, views } = harness({ redisDown: true });
    expect(await at(A, () => stats.view(A, 'android', 'panel', 'v', 'fa', DAY1))).toBe('skipped');
    expect(views).toEqual([]);
  });

  it('counts nothing for a guide the tenant does not see', async () => {
    const { stats, views } = harness();
    expect(await at(B, () => stats.view(B, 'mine', 'panel', 'v', 'fa', DAY1))).toBe('unknown');
    expect(views).toEqual([]);
  });

  it('hashes a viewer, never keeping the IP', () => {
    const h = viewerHash('1.2.3.4', 'Firefox');
    expect(h).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(h).not.toContain('1.2.3.4');
    expect(viewerHash('1.2.3.4', 'Chrome')).not.toBe(h);
  });
});

describe('a vote', () => {
  it('is one per user per guide, and can be changed', async () => {
    const { stats, votes } = harness();
    await at(A, () => stats.vote(A, 'u1', 'android', true, 'fa'));
    await at(A, () => stats.vote(A, 'u1', 'android', false, 'fa'));
    expect(votes).toEqual([expect.objectContaining({ tenantId: A, guideId: PG, userId: 'u1', helpful: false })]);
    expect(await at(A, () => stats.myVote(A, 'u1', 'android', 'fa'))).toEqual({ helpful: false });
    expect(await at(A, () => stats.myVote(A, 'u2', 'android', 'fa'))).toEqual({ helpful: null });
  });

  it('is refused on a guide the voter’s tenant does not see', async () => {
    const { stats, votes } = harness();
    const refused = await at(B, () => stats.vote(B, 'u1', 'mine', true, 'fa')).catch((e) => e);
    expect(refused).toBeInstanceOf(GuideRefused);
    expect((refused as GuideRefused).reason).toBe('guide_unknown');
    expect(votes).toEqual([]);
  });
});

describe('the numbers', () => {
  async function seeded() {
    const h = harness();
    await at(A, () => h.stats.view(A, 'android', 'panel', 'a1', 'fa', DAY1));
    await at(A, () => h.stats.view(A, 'mine', 'bot', 'a1', 'fa', DAY1));
    await at(B, () => h.stats.view(B, 'android', 'panel', 'b1', 'fa', DAY1));
    await at(B, () => h.stats.view(B, 'android', 'bot', 'b1', 'fa', DAY1));
    await at(A, () => h.stats.vote(A, 'ua', 'android', true, 'fa'));
    await at(A, () => h.stats.vote(A, 'ua', 'mine', false, 'fa'));
    await at(B, () => h.stats.vote(B, 'ub', 'android', false, 'fa'));
    return h;
  }
  const NOW = new Date('2026-10-05T12:00:00Z');

  it('a reseller reads its own tenant’s, for its guides and the platform’s it shows', async () => {
    const { stats } = await seeded();
    const out = await at(A, () => stats.stats({ userId: 'x', tenantId: A, permissions: [] }, 30, NOW));
    expect(out.stats).toEqual([
      { guideId: PG, views: 1, panelViews: 1, botViews: 0, helpful: 1, notHelpful: 0 },
      { guideId: AG, views: 1, panelViews: 0, botViews: 1, helpful: 0, notHelpful: 1 },
    ]);
  });

  it('the platform owner reads every tenant’s, for the platform’s guides only', async () => {
    const { stats } = await seeded();
    const out = await at(PLATFORM, () => stats.stats({ userId: 'x', tenantId: PLATFORM, permissions: [] }, 30, NOW));
    expect(out.stats).toEqual([{ guideId: PG, views: 3, panelViews: 2, botViews: 1, helpful: 1, notHelpful: 1 }]);
  });

  it('counts only the days asked for', async () => {
    const { stats } = await seeded();
    const later = new Date('2026-11-20T12:00:00Z');
    const out = await at(A, () => stats.stats({ userId: 'x', tenantId: A, permissions: [] }, 7, later));
    expect(out.stats.map((s) => s.views)).toEqual([0, 0]);
  });

  it('sums rows into one line per guide', () => {
    expect(
      statsOf(
        [
          { guideId: 'g', surface: 'panel', _sum: { views: 2 } },
          { guideId: 'g', surface: 'bot', _sum: { views: 3 } },
        ],
        [{ guideId: 'g', helpful: true, _count: { _all: 4 } }],
      ),
    ).toEqual([{ guideId: 'g', views: 5, panelViews: 2, botViews: 3, helpful: 4, notHelpful: 0 }]);
  });
});
