import { HandoffService } from './handoff.service';
import { SurfaceOwnerService } from '../surface-owner/surface-owner.service';
import { TenantContext, runWithTenant } from '../../tenant-context/tenant-context';

/**
 * From the platform panel to the reseller's own domain without signing in
 * again (F-061-f, ADR-0059). The code is a bearer credential for a whole
 * session, so what it must never do is the point: be minted for a reseller the
 * caller does not own, be spent on any domain but that reseller's, be spent
 * twice, or outlive a change of owner.
 */

const PLATFORM = { id: 'tenant-platform', slug: 'platform_owner', via: 'session' } as const;
const RESELLER_DOOR = { id: 'tenant-reseller', slug: 'arian-vpn', via: 'domain', surfacePurpose: 'panel' } as const;
const CLAIMS = { sub: 'user-ali', tenantId: PLATFORM.id, sessionId: 's-1' };
const ALI = {
  id: 'user-ali',
  tenantId: PLATFORM.id,
  status: 'active',
  deletedAt: null,
  role: { rolePermissions: [] },
  tenant: { slug: PLATFORM.slug },
};

function harness(opts: { reseller?: unknown; ownerUserId?: string | null; user?: unknown; stored?: string | null } = {}) {
  const reseller =
    'reseller' in opts
      ? opts.reseller
      : {
          id: RESELLER_DOOR.id,
          domains: [
            { domainValue: 'arian-vpn.edge.txnet.test', domainType: 'subdomain' },
            { domainValue: 'arian-vpn.txnet.test', domainType: 'subdomain' },
            { domainValue: 'arianvpn.ir', domainType: 'custom_domain' },
          ],
        };
  const all = {
    tenant: {
      findFirst: vi.fn().mockResolvedValue(reseller),
      findMany: vi.fn().mockResolvedValue([{ id: RESELLER_DOOR.id, slug: RESELLER_DOOR.slug }]),
      findUnique: vi.fn().mockResolvedValue(
        opts.ownerUserId === null ? null : { ownerUserId: opts.ownerUserId ?? 'user-ali' },
      ),
    },
    user: { findFirst: vi.fn().mockResolvedValue('user' in opts ? opts.user : ALI) },
  };
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string, _ttl?: number) => void store.set(key, value)),
    client: {
      get: vi.fn(async (key: string) => ('stored' in opts ? opts.stored : store.get(key) ?? null)),
      del: vi.fn(async (key: string) => (store.delete(key) || 'stored' in opts ? 1 : 0)),
    },
  };
  const seenScope: unknown[] = [];
  const auth = {
    createSessionForUser: vi.fn(async () => {
      seenScope.push(TenantContext.currentOrNull());
      return { accessToken: 'at', refreshToken: 'rt', expiresIn: 900 };
    }),
  };
  const owners = new SurfaceOwnerService(all as never);
  const service = new HandoffService(all as never, redis as never, owners, auth as never);
  return { service, all, redis, auth, store, seenScope };
}

async function mint(h: ReturnType<typeof harness>) {
  const issued = await runWithTenant(PLATFORM as never, () =>
    h.service.issue(CLAIMS as never, RESELLER_DOOR.id),
  );
  return issued as unknown as { ok: boolean; msg: string; data: { origin: string; code: string; expiresIn: number } };
}

describe('HandoffService.issue', () => {
  it('mints a code for a reseller the caller owns, bound to that account and that tenant', async () => {
    const h = harness();

    const issued = await mint(h);

    expect(issued.ok).toBe(true);
    expect(h.all.tenant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: RESELLER_DOOR.id, ownerUserId: 'user-ali', deletedAt: null }),
      }),
    );
    expect(issued.data.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [key, value, ttl] = h.redis.set.mock.calls[0];
    expect(key).toBe(`handoff:${issued.data.code}`);
    expect(JSON.parse(value)).toEqual({ userId: 'user-ali', tenantId: RESELLER_DOOR.id });
    expect(ttl).toBe(issued.data.expiresIn);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("sends them to the reseller's own domain first, and never to a CNAME target", async () => {
    const issued = await mint(harness());
    expect(issued.data.origin).toBe('https://arianvpn.ir');

    const onlySubdomains = await mint(
      harness({
        reseller: {
          id: RESELLER_DOOR.id,
          domains: [
            { domainValue: 'arian-vpn.edge.txnet.test', domainType: 'subdomain' },
            { domainValue: 'arian-vpn.txnet.test', domainType: 'subdomain' },
          ],
        },
      }),
    );
    expect(onlySubdomains.data.origin).toBe('https://arian-vpn.txnet.test');
  });

  it('refuses, and writes nothing, for a reseller the caller does not own', async () => {
    const h = harness({ reseller: null });

    const issued = await mint(h);

    expect(issued).toMatchObject({ ok: false, msg: 'auth.handoffRefused' });
    expect(h.redis.set).not.toHaveBeenCalled();
  });

  it('refuses an impersonated session: a handed-off session would outlive its audit window', async () => {
    const h = harness();

    const issued = await runWithTenant(PLATFORM as never, () =>
      h.service.issue({ ...CLAIMS, isImpersonated: true } as never, RESELLER_DOOR.id),
    );

    expect(issued).toMatchObject({ ok: false, msg: 'auth.handoffRefused' });
    expect(h.all.tenant.findFirst).not.toHaveBeenCalled();
  });

  it('lists the resellers the caller owns', async () => {
    const h = harness();

    const listed = await runWithTenant(PLATFORM as never, () => h.service.owned(CLAIMS as never));

    expect(h.all.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerUserId: 'user-ali', deletedAt: null }) }),
    );
    expect(listed).toMatchObject({ ok: true, data: { resellers: [{ id: RESELLER_DOOR.id, slug: 'arian-vpn' }] } });
  });
});

describe('HandoffService.redeem', () => {
  it("opens a session of the same account, in the owner's own tenant branded by the door", async () => {
    const h = harness();
    const { data } = await mint(h);

    const redeemed = await runWithTenant(RESELLER_DOOR as never, () =>
      h.service.redeem(data.code, '1.2.3.4', 'ua', null),
    );

    expect(redeemed).toMatchObject({ ok: true, msg: 'auth.loginSuccess', data: { accessToken: 'at' } });
    expect(h.auth.createSessionForUser).toHaveBeenCalledWith(ALI, '1.2.3.4', 'ua', null);
    expect(h.seenScope[0]).toMatchObject({
      id: PLATFORM.id,
      brand: { id: RESELLER_DOOR.id, slug: RESELLER_DOOR.slug },
    });
  });

  it('is single-use', async () => {
    const h = harness();
    const { data } = await mint(h);
    const redeem = () =>
      runWithTenant(RESELLER_DOOR as never, () => h.service.redeem(data.code, 'ip', 'ua', null));

    await redeem();
    expect(await redeem()).toMatchObject({ ok: false, msg: 'auth.handoffInvalid' });
    expect(h.auth.createSessionForUser).toHaveBeenCalledTimes(1);
  });

  it("is refused on any domain but the reseller's, and is not spent there", async () => {
    const h = harness();
    const { data } = await mint(h);
    const other = { ...RESELLER_DOOR, id: 'tenant-other', slug: 'other' };

    const redeemed = await runWithTenant(other as never, () => h.service.redeem(data.code, 'ip', 'ua', null));

    expect(redeemed).toMatchObject({ ok: false, msg: 'auth.handoffInvalid' });
    expect(h.redis.client.del).not.toHaveBeenCalled();
    expect(h.auth.createSessionForUser).not.toHaveBeenCalled();
  });

  it('is refused on a subscription host of that same reseller', async () => {
    const h = harness();
    const { data } = await mint(h);
    const sub = { ...RESELLER_DOOR, surfacePurpose: 'subscription' };

    expect(
      await runWithTenant(sub as never, () => h.service.redeem(data.code, 'ip', 'ua', null)),
    ).toMatchObject({ ok: false, msg: 'auth.handoffInvalid' });
  });

  it('is refused when the reseller changed owner after the code was minted', async () => {
    const h = harness({ ownerUserId: 'user-sara' });
    const { data } = await mint(h);

    const redeemed = await runWithTenant(RESELLER_DOOR as never, () =>
      h.service.redeem(data.code, 'ip', 'ua', null),
    );

    expect(redeemed).toMatchObject({ ok: false, msg: 'auth.handoffInvalid' });
    expect(h.auth.createSessionForUser).not.toHaveBeenCalled();
  });

  it('is refused for an account that is no longer active', async () => {
    const h = harness({ user: { ...ALI, status: 'suspended' } });
    const { data } = await mint(h);

    expect(
      await runWithTenant(RESELLER_DOOR as never, () => h.service.redeem(data.code, 'ip', 'ua', null)),
    ).toMatchObject({ ok: false, msg: 'auth.handoffInvalid' });
  });

  it('is refused for a code that was never minted, or whose value is not a grant', async () => {
    const h = harness({ stored: 'not json' });

    expect(
      await runWithTenant(RESELLER_DOOR as never, () => h.service.redeem('x'.repeat(43), 'ip', 'ua', null)),
    ).toMatchObject({ ok: false, msg: 'auth.handoffInvalid' });
  });
});
