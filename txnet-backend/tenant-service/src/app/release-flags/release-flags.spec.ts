import { ReleaseFlagsRefused, ReleaseFlagsService } from './release-flags.service';

/**
 * The invariants OPS-1-ag turns on (ADR-0164 point 4, `tenant/contract.release-flags.md`).
 *
 * - A flag ships `off`; `platform` is on for the platform's own tenant only,
 *   `everyone` for all; a reseller's exception wins over the stage, both ways.
 * - A switch is seen on the next read, though the old state was cached: every
 *   write drops the cached copy. With no Redis to drop it, the switch is refused
 *   and nothing is written.
 * - Only the platform's own staff switch, only a declared flag, an exception
 *   only for a reseller; every switch is audited.
 */
describe('ReleaseFlagsService', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const ALI = '22222222-2222-2222-2222-222222222222';
  const SARA = '33333333-3333-3333-3333-333333333333';
  const admin = { adminId: '44444444-4444-4444-4444-444444444444', tenantId: PLATFORM, ip: '10.0.0.1' };
  const reseller = { ...admin, tenantId: ALI };
  const KEY = 'new_checkout';

  const build = () => {
    const tenants: Record<string, { tenantType: string; deletedAt: null }> = {
      [PLATFORM]: { tenantType: 'platform_owner', deletedAt: null },
      [ALI]: { tenantType: 'reseller', deletedAt: null },
      [SARA]: { tenantType: 'reseller', deletedAt: null },
    };
    let db = { flags: new Map<string, string>(), exceptions: new Map<string, boolean>(), audit: [] as string[] };
    type ExceptionWhere = { where: { tenantId_key: { tenantId: string; key: string } } };
    const exKey = ({ where }: ExceptionWhere) => `${where.tenantId_key.tenantId}|${where.tenantId_key.key}`;
    const client = {
      tenant: {
        findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
        findFirst: async () => ({ id: PLATFORM }),
      },
      releaseFlag: {
        findUnique: async ({ where }: { where: { key: string } }) => (db.flags.has(where.key) ? { stage: db.flags.get(where.key) } : null),
        findMany: async () => [...db.flags].map(([key, stage]) => ({ key, stage })),
        upsert: async ({ where, update }: { where: { key: string }; update: { stage: string } }) => db.flags.set(where.key, update.stage),
      },
      releaseFlagException: {
        findUnique: async (q: ExceptionWhere) => (db.exceptions.has(exKey(q)) ? { isOn: db.exceptions.get(exKey(q)) } : null),
        findMany: async () => [...db.exceptions].map(([k, isOn]) => ({ key: k.split('|')[1], tenantId: k.split('|')[0], isOn })),
        upsert: async (q: ExceptionWhere & { update: { isOn: boolean } }) => db.exceptions.set(exKey(q), q.update.isOn),
        delete: async (q: ExceptionWhere) => db.exceptions.delete(exKey(q)),
      },
      adminAuditLog: { create: async ({ data }: { data: { action: string } }) => db.audit.push(data.action) },
      // A transaction: every write inside it is undone when it throws.
      $transaction: async (work: (tx: unknown) => Promise<void>) => {
        const saved = { flags: new Map(db.flags), exceptions: new Map(db.exceptions), audit: [...db.audit] };
        try {
          await work(client);
        } catch (e) {
          db = saved;
          throw e;
        }
      },
    };
    const cache = new Map<string, string>();
    const redis = {
      reachable: true,
      get: async (k: string) => cache.get(k) ?? null,
      setWithTtl: async (k: string, v: string) => void cache.set(k, v),
      del: async (k: string) => {
        if (!redis.reachable) throw new Error('redis unreachable');
        cache.delete(k);
      },
    };
    const service = new ReleaseFlagsService(client as never, redis as never, [KEY]);
    return { service, redis, audit: () => db.audit };
  };

  const answers = async (service: ReleaseFlagsService) =>
    Object.fromEntries(await Promise.all([PLATFORM, ALI, SARA].map(async (t) => [t, (await service.answersFor(t))[KEY]])));

  const refusal = (p: Promise<unknown>) => p.then(() => 'accepted', (e) => (e instanceof ReleaseFlagsRefused ? e.reason : Promise.reject(e)));

  it('ships off, then on for the platform only, then for everyone', async () => {
    const { service } = build();
    expect(await answers(service)).toEqual({ [PLATFORM]: false, [ALI]: false, [SARA]: false });
    await service.setStage(admin, KEY, 'platform');
    expect(await answers(service)).toEqual({ [PLATFORM]: true, [ALI]: false, [SARA]: false });
    await service.setStage(admin, KEY, 'everyone');
    expect(await answers(service)).toEqual({ [PLATFORM]: true, [ALI]: true, [SARA]: true });
  });

  it("lets a reseller's exception win over the stage both ways, until it is cleared", async () => {
    const { service } = build();
    await service.setException(admin, KEY, ALI, true);
    expect(await answers(service)).toEqual({ [PLATFORM]: false, [ALI]: true, [SARA]: false });
    await service.setStage(admin, KEY, 'everyone');
    await service.setException(admin, KEY, SARA, false);
    expect(await answers(service)).toEqual({ [PLATFORM]: true, [ALI]: true, [SARA]: false });
    await service.clearException(admin, KEY, SARA);
    expect((await service.answersFor(SARA))[KEY]).toBe(true);
  });

  it('refuses a switch it cannot make visible, and writes nothing', async () => {
    const { service, redis, audit } = build();
    await service.answersFor(ALI);
    redis.reachable = false;
    await expect(service.setStage(admin, KEY, 'everyone')).rejects.toThrow('redis unreachable');
    redis.reachable = true;
    expect((await service.table(admin))[0].stage).toBe('off');
    expect(audit()).toEqual([]);
  });

  it('lets only the platform switch, only a declared flag, an exception only for a reseller — audited', async () => {
    const { service, audit } = build();
    expect(await refusal(service.setStage(reseller, KEY, 'everyone'))).toBe('not_platform_owner');
    expect(await refusal(service.setStage(admin, 'undeclared', 'everyone'))).toBe('unknown_flag');
    expect(await refusal(service.setException(admin, KEY, PLATFORM, true))).toBe('reseller_not_found');
    await service.setStage(admin, KEY, 'platform');
    await service.setException(admin, KEY, ALI, true);
    await service.clearException(admin, KEY, ALI);
    expect(audit()).toEqual(['release_flag_stage_set', 'release_flag_exception_set', 'release_flag_exception_clear']);
  });
});
