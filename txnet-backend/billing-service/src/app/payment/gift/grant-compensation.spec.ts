import { ResellerAccessRefused } from '@txnet-backend/shared-core';

import { claimCompensation, COMPENSATION_WINDOW_DAYS, CompensationOverCap, PLATFORM_COMPENSATION_CAP } from './grant-compensation';
import { GrantLimitsService } from './grant-limits.service';
import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

/**
 * KS-1-c (ADR-0140 (2)): `grant.compensate` adds days or traffic to a user's
 * service, up to a per-tenant cap a `grant.assign` holder sets. What this pins:
 *  - the key each act asks: compensating `grant.compensate` alone, setting the
 *    cap `grant.assign`, reading it either;
 *  - the cap is per Grant over a rolling 30 days, counted from the ledger, so
 *    ten small acts cannot pass it; with no tenant row the platform's applies;
 *  - an act over it is refused before anything is written, with the figures.
 */
const T = '22222222-2222-4222-8222-222222222222';
const U = '66666666-6666-4666-8666-666666666666';
const G = '88888888-8888-4888-8888-888888888888';
const GIB = BigInt(1024 ** 3);
const actor = { userId: '44444444-4444-4444-8444-444444444444', tenantId: T, permissions: [] as string[], ip: '1.1.1.1' } as never;

describe('the keys of a compensation', () => {
  function door() {
    const asked: string[][] = [];
    const access = {
      for: (...keys: string[]) => {
        asked.push(keys);
        return {
          runIncludingPlatform: async () => {
            throw new ResellerAccessRefused('not_allowed', T);
          },
        };
      },
    };
    return { asked, access };
  }

  it('asks grant.compensate, and only it, to compensate', async () => {
    const { asked, access } = door();
    const service = new ResellerUserGrantsService({} as never, access as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.compensate(actor, T, U, G, { days: 1 }, 'outage')).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    await expect(service.compensate(actor, T, U, G, { bytes: GIB }, 'outage')).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    expect(asked).toEqual([['grant.compensate'], ['grant.compensate']]);
  });

  it('asks grant.assign to set the cap, and either to read it', async () => {
    const { asked, access } = door();
    const limits = new GrantLimitsService({} as never, access as never);
    await expect(limits.setCompensationCap(actor, T, { days: 5, bytes: GIB })).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    await expect(limits.compensationCap(actor, T)).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    expect(asked).toEqual([['grant.assign'], ['grant.compensate', 'grant.assign']]);
  });
});

describe('claimCompensation', () => {
  const at = new Date('2026-10-13T12:00:00Z');
  const by = { tenantId: T, actorUserId: 'a', reason: 'outage', at };

  function tx(cap: { days: number; bytes: bigint } | null, used: { days: number; bytes: bigint }) {
    const calls: string[] = [];
    const created: unknown[] = [];
    let since: Date | undefined;
    const fake = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        calls.push(strings.join('?').includes('FOR UPDATE') ? 'lock' : 'query');
        return [{ id: G }];
      },
      grantCompensationCap: { findUnique: async () => (cap ? { tenantId: T, ...cap } : null) },
      grantCompensation: {
        aggregate: async (q: { where: { grantId: string; createdAt: { gte: Date } } }) => {
          calls.push('sum');
          since = q.where.createdAt.gte;
          return { _sum: { days: used.days, bytes: used.bytes } };
        },
        create: async (q: { data: unknown }) => {
          calls.push('create');
          created.push(q.data);
          return { id: 'c1' };
        },
      },
    };
    return { fake: fake as never, calls, created, since: () => since };
  }

  it('locks the Grant before counting, so two acts at once cannot both fit', async () => {
    const t = tx(null, { days: 0, bytes: BigInt(0) });
    await claimCompensation(t.fake, G, { days: 1 }, by);
    expect(t.calls.slice(0, 2)).toEqual(['lock', 'sum']);
  });

  it('counts the last 30 days of this Grant', async () => {
    const t = tx(null, { days: 0, bytes: BigInt(0) });
    await claimCompensation(t.fake, G, { days: 1 }, by);
    expect(t.since()).toEqual(new Date(at.getTime() - COMPENSATION_WINDOW_DAYS * 86_400_000));
  });

  it('applies the platform default when the tenant set none', async () => {
    const t = tx(null, { days: PLATFORM_COMPENSATION_CAP.days - 1, bytes: BigInt(0) });
    await expect(claimCompensation(t.fake, G, { days: 1 }, by)).resolves.toEqual({ id: 'c1' });
    const over = tx(null, { days: PLATFORM_COMPENSATION_CAP.days, bytes: BigInt(0) });
    await expect(claimCompensation(over.fake, G, { days: 1 }, by)).rejects.toBeInstanceOf(CompensationOverCap);
  });

  it('refuses what passes the tenant cap with the figures, and writes nothing', async () => {
    const t = tx({ days: 10, bytes: BigInt(20) * GIB }, { days: 0, bytes: BigInt(15) * GIB });
    const refused = await claimCompensation(t.fake, G, { bytes: BigInt(6) * GIB }, by).catch((e) => e);
    expect(refused).toBeInstanceOf(CompensationOverCap);
    expect(refused.facts).toEqual({ windowDays: 30, capDays: 10, capBytes: String(BigInt(20) * GIB), usedDays: 0, usedBytes: String(BigInt(15) * GIB) });
    expect(t.created).toEqual([]);
  });

  it('a tenant cap of 0 closes that kind and leaves the other open', async () => {
    const t = tx({ days: 0, bytes: GIB }, { days: 0, bytes: BigInt(0) });
    await expect(claimCompensation(t.fake, G, { days: 1 }, by)).rejects.toBeInstanceOf(CompensationOverCap);
    await expect(claimCompensation(t.fake, G, { bytes: GIB }, by)).resolves.toEqual({ id: 'c1' });
  });

  it('writes one ledger row for what it admits', async () => {
    const t = tx({ days: 10, bytes: GIB }, { days: 3, bytes: BigInt(0) });
    await claimCompensation(t.fake, G, { days: 7 }, by);
    expect(t.created).toEqual([{ tenantId: T, grantId: G, actorUserId: 'a', reason: 'outage', days: 7, bytes: BigInt(0), createdAt: at }]);
  });
});
