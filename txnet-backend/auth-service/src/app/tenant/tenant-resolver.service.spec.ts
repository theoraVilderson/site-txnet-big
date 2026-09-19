import { TenantCacheService } from './tenant-cache.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantClaimConflict, normalizeHost } from './tenant';

/**
 * Resolution decides which tenant an account is written into (F-061-b), and
 * every way of getting it wrong is quiet: an unverified custom domain that
 * resolves hands a reseller's brand to whoever pointed a CNAME at it, and — up
 * to F-066-d — a fallback that fired when it should not wrote accounts into
 * the platform owner while looking exactly like success. Those are the cases
 * below, not the happy path, which the caller would notice.
 *
 * `null` is now the answer wherever the fallback used to be, and it is not a
 * degraded one: `TenantGuard` turns it into a neutral 404 (ADR-0025).
 */

const DOMAIN_TENANT = { id: 'tenant-reseller', slug: 'reseller' };
const OTHER_TENANT = { id: 'tenant-other', slug: 'other-reseller' };
/** Where the reseller's owner has their account (ADR-0059). */
const PLATFORM_TENANT = { id: 'tenant-platform', slug: 'platform_owner' };
const KNOWN = [DOMAIN_TENANT, OTHER_TENANT, PLATFORM_TENANT];
/** `tenant.ownerUserId` of DOMAIN_TENANT: an account of PLATFORM_TENANT. */
const OWNER = 'user-ali';

type DomainRow = {
  domainType: 'subdomain' | 'custom_domain';
  /** What the door is for (F-066-q). Every fixture here is a panel domain. */
  purpose: 'panel' | 'subscription' | 'assets';
  verificationStatus: 'pending' | 'verified' | 'failed';
  tenant: { id: string; slug: string; ownerUserId: string };
};

/**
 * The cache the resolver actually uses, over an in-memory Redis. Faking
 * `TenantCacheService` itself would leave the resolver's two lookups agreeing
 * with a fake instead of with the thing that decides what a hit is — and the
 * distinction between "not cached" and "cached as nothing" is exactly where a
 * stranger's host stops costing a database read (ADR-0025). Expiry is not
 * modelled: the TTL is a backstop, not the mechanism, and it is asserted in
 * `tenant-cache.service.spec.ts`.
 */
function memoryCache() {
  const store = new Map<string, string>();
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    del: async (...keys: string[]) => {
      keys.forEach((key) => store.delete(key));
    },
  };
  return new TenantCacheService(redis as never);
}

function resolver(rows: Record<string, DomainRow>) {
  const findUnique = vi.fn(async ({ where }: any) => rows[where.domainValue] ?? null);
  const tenantById = vi.fn(async ({ where, select }: any) => {
    const tenant = KNOWN.find((t) => t.id === where.id);
    if (!tenant || !select?.ownerUserId) return tenant ?? null;
    return { ...tenant, ownerUserId: tenant.id === DOMAIN_TENANT.id ? OWNER : `owner-of-${tenant.id}` };
  });
  const prisma = {
    tenantDomain: { findUnique },
    tenant: { findUnique: tenantById },
  };

  const cache = memoryCache();

  return {
    service: new TenantResolverService(prisma as never, cache),
    cache,
    findUnique,
    tenantById,
  };
}

const subdomain = (purpose: DomainRow['purpose'] = 'panel'): DomainRow => ({
  domainType: 'subdomain',
  purpose,
  verificationStatus: 'pending',
  tenant: { ...DOMAIN_TENANT, ownerUserId: OWNER },
});

const customDomain = (
  verificationStatus: DomainRow['verificationStatus'],
): DomainRow => ({
  domainType: 'custom_domain',
  purpose: 'panel',
  verificationStatus,
  tenant: { ...DOMAIN_TENANT, ownerUserId: OWNER },
});

describe('normalizeHost', () => {
  it.each([
    ['MyVPN.Com', 'myvpn.com'],
    ['myvpn.com:3001', 'myvpn.com'],
    ['myvpn.com.', 'myvpn.com'],
    ['  api.myvpn.com  ', 'api.myvpn.com'],
    ['[::1]:3001', '[::1]'],
  ])('reduces %s to %s', (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });

  it.each([undefined, null, '', '   ', ':3001'])(
    'answers null for %p rather than an empty host that could match a row',
    (raw) => {
      expect(normalizeHost(raw as never)).toBeNull();
    },
  );
});

describe('TenantResolverService — which tenant a host resolves to', () => {
  it('resolves a subdomain row as it stands: the platform issued it', async () => {
    const { service } = resolver({ 'reseller.txnet.app': subdomain() });

    await expect(service.resolve({ host: 'reseller.txnet.app' })).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
      surfacePurpose: 'panel',
      surfaceDomainType: 'subdomain',
    });
  });

  it("marks a reseller's CNAME target, which serves nothing (ADR-0063)", async () => {
    const { service } = resolver({ 'reseller.edge.txnet.app': subdomain() });

    await expect(service.resolve({ host: 'reseller.edge.txnet.app' })).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
      surfacePurpose: 'panel',
      surfaceDomainType: 'subdomain',
      surfaceIsTarget: true,
    });
  });

  it('marks the target however the host was sent, and from the cache too', async () => {
    const { service, findUnique } = resolver({ 'reseller.edge.txnet.app': subdomain() });

    await service.resolve({ host: 'reseller.edge.txnet.app' });
    await expect(service.resolve({ host: 'Reseller.EDGE.txnet.app:443' })).resolves.toMatchObject({
      surfaceIsTarget: true,
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('resolves a verified custom domain', async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(service.resolve({ host: 'myvpn.com' })).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
      surfacePurpose: 'panel',
      surfaceDomainType: 'custom_domain',
    });
  });

  it.each(['pending', 'failed'] as const)(
    'answers null for a %s custom domain, exactly as an unknown host does',
    async (status) => {
      const { service } = resolver({ 'myvpn.com': customDomain(status) });

      await expect(service.resolve({ host: 'myvpn.com' })).resolves.toBeNull();
    },
  );

  it('answers null for a host with no row at all', async () => {
    // The case F-066-d is about: before it, this was served as whichever
    // tenant DEFAULT_TENANT_SLUG named, and looked like success.
    const { service } = resolver({});

    await expect(service.resolve({ host: 'stranger.example' })).resolves.toBeNull();
  });

  it('answers null for a request with no usable host, without looking a domain up', async () => {
    const { service, findUnique } = resolver({});

    await expect(service.resolve({ host: undefined })).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('matches the row through the normalized host, not the header as sent', async () => {
    const { service, findUnique } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(service.resolve({ host: 'MyVPN.com:8443' })).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
      surfacePurpose: 'panel',
      surfaceDomainType: 'custom_domain',
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domainValue: 'myvpn.com' } }),
    );
  });
});

describe('TenantResolverService — the cache', () => {
  it('reads each host once', async () => {
    const { service, findUnique } = resolver({ 'myvpn.com': customDomain('verified') });

    await service.resolve({ host: 'myvpn.com' });
    await service.resolve({ host: 'myvpn.com' });

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('caches each host separately', async () => {
    const { service, findUnique } = resolver({ 'myvpn.com': customDomain('verified') });

    await service.resolve({ host: 'myvpn.com' });
    await service.resolve({ host: 'other.example' });

    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('re-reads a host once its domain is invalidated — verification works without a restart', async () => {
    // Up to F-066-e this was the 60s TTL's job, and a switchover inside that
    // window served the domain as its previous owner. Now the write that
    // changes the answer is what retracts it.
    const rows: Record<string, DomainRow> = { 'myvpn.com': customDomain('pending') };
    const { service, cache } = resolver(rows);

    await expect(service.resolve({ host: 'myvpn.com' })).resolves.toBeNull();

    rows['myvpn.com'] = customDomain('verified');
    await cache.invalidateDomain('myvpn.com');

    await expect(service.resolve({ host: 'myvpn.com' })).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
      surfacePurpose: 'panel',
      surfaceDomainType: 'custom_domain',
    });
  });
});

/**
 * The claim chain (ADR-0025, catalog F-1208/F-1209) and the refusal ADR-0024
 * decision 4 asks for. The case that matters is the last one: before this, a
 * tenant-A session presented on tenant-B's host resolved to B and kept working,
 * because nothing compared the two.
 */
describe('TenantResolverService — the claim chain', () => {
  it('lets a session claim answer, and says so in `via`', async () => {
    const { service } = resolver({});

    await expect(
      service.resolve({ host: 'stranger.example', session: DOMAIN_TENANT.id }),
    ).resolves.toEqual({ ...DOMAIN_TENANT, via: 'session' });
  });

  it('lets a bot claim answer when there is no session claim', async () => {
    const { service } = resolver({});

    await expect(
      service.resolve({ host: 'stranger.example', bot: OTHER_TENANT.id }),
    ).resolves.toEqual({ ...OTHER_TENANT, via: 'bot' });
  });

  it('refuses a session whose tenant is not the bot it came through', async () => {
    // A bot claim is a door like a host (ADR-0059 (6)): it used to be ignored
    // whenever a session claim was present, which served the session's tenant
    // through another tenant's bot without anyone deciding to.
    const { service } = resolver({});

    await expect(
      service.resolve({ session: DOMAIN_TENANT.id, bot: OTHER_TENANT.id, sessionUser: 'user-bob' }),
    ).rejects.toBeInstanceOf(TenantClaimConflict);
  });

  it('lets a session answer through its own tenant\'s bot', async () => {
    const { service } = resolver({});

    await expect(
      service.resolve({ session: DOMAIN_TENANT.id, bot: DOMAIN_TENANT.id }),
    ).resolves.toEqual({ ...DOMAIN_TENANT, via: 'session' });
  });

  it('answers null for a claim naming a tenant that no longer exists', async () => {
    // A token outliving its tenant resolves to nothing, never to an id nobody
    // owns — a scoped query on an unowned id is a silent read of no rows.
    const { service } = resolver({});

    await expect(service.resolve({ session: 'tenant-deleted' })).resolves.toBeNull();
  });

  it('refuses a session whose tenant is not the surface it arrived on', async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(
      service.resolve({ host: 'myvpn.com', session: OTHER_TENANT.id }),
    ).rejects.toBeInstanceOf(TenantClaimConflict);
  });

  it('refuses a bot claim that disagrees with the surface too', async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(
      service.resolve({ host: 'myvpn.com', bot: OTHER_TENANT.id }),
    ).rejects.toBeInstanceOf(TenantClaimConflict);
  });

  it('accepts a claim that agrees with its surface, without a second lookup', async () => {
    const { service, tenantById } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(
      service.resolve({ host: 'myvpn.com', session: DOMAIN_TENANT.id }),
      // The claim answered and the surface's purpose still travels with it:
      // `via` says which proof was used, `surfacePurpose` says which door it
      // arrived at, and F-066-q turns on the second, not the first.
    ).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'session',
      surfacePurpose: 'panel',
      surfaceDomainType: 'custom_domain',
    });
    expect(tenantById).not.toHaveBeenCalled();
  });
});

describe("TenantResolverService — the surface tenant's owner (ADR-0059)", () => {
  const OWNER_ANSWER = {
    ...PLATFORM_TENANT,
    via: 'session',
    surfacePurpose: 'panel',
    surfaceDomainType: 'custom_domain',
    brand: DOMAIN_TENANT,
  };

  it("admits the owner's own session on their domain, scoped to their own tenant", async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(
      service.resolve({ host: 'myvpn.com', session: PLATFORM_TENANT.id, sessionUser: OWNER }),
    ).resolves.toEqual(OWNER_ANSWER);
  });

  it('still refuses any other account of that tenant', async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(
      service.resolve({ host: 'myvpn.com', session: PLATFORM_TENANT.id, sessionUser: 'user-bob' }),
    ).rejects.toBeInstanceOf(TenantClaimConflict);
  });

  it('refuses the owner on a surface that is not a panel', async () => {
    const { service } = resolver({ 'sub.myvpn.com': subdomain('subscription') });

    await expect(
      service.resolve({ host: 'sub.myvpn.com', session: PLATFORM_TENANT.id, sessionUser: OWNER }),
    ).rejects.toBeInstanceOf(TenantClaimConflict);
  });

  it('never extends the exception to a bot claim', async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(
      service.resolve({ host: 'myvpn.com', bot: PLATFORM_TENANT.id, sessionUser: OWNER }),
    ).rejects.toBeInstanceOf(TenantClaimConflict);
  });

  it("admits the owner's own session through their reseller's bot, branded by it (ADR-0059 (6))", async () => {
    const { service } = resolver({});

    await expect(
      service.resolve({ session: PLATFORM_TENANT.id, bot: DOMAIN_TENANT.id, sessionUser: OWNER }),
    ).resolves.toEqual({ ...PLATFORM_TENANT, via: 'session', brand: DOMAIN_TENANT });
  });

  it("serves the owner's next chat message from the cache, and re-reads once the owner is invalidated (F-061-k)", async () => {
    const { service, tenantById, cache } = resolver({});
    const claim = { session: PLATFORM_TENANT.id, bot: DOMAIN_TENANT.id, sessionUser: OWNER };

    await service.resolve(claim);
    const reads = tenantById.mock.calls.length;
    await expect(service.resolve(claim)).resolves.toMatchObject({ id: PLATFORM_TENANT.id, brand: DOMAIN_TENANT });
    expect(tenantById).toHaveBeenCalledTimes(reads);

    await cache.invalidateTenant(DOMAIN_TENANT.id);
    await service.resolve(claim);
    expect(tenantById).toHaveBeenCalledTimes(reads + 1);
  });

  it('refuses any other account through that bot', async () => {
    const { service } = resolver({});

    await expect(
      service.resolve({ session: PLATFORM_TENANT.id, bot: DOMAIN_TENANT.id, sessionUser: 'user-bob' }),
    ).rejects.toBeInstanceOf(TenantClaimConflict);
  });

  it("answers a cookie-only request carrying the owner's session the same way", async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });
    const cookieSession = vi.fn(async () => ({ tenantId: PLATFORM_TENANT.id, userId: OWNER }));

    await expect(service.resolve({ host: 'myvpn.com', cookieSession })).resolves.toEqual(
      OWNER_ANSWER,
    );
  });

  it("ignores a cookie that is not the owner's, and the host decides as before", async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });
    const cookieSession = vi.fn(async () => ({ tenantId: OTHER_TENANT.id, userId: 'user-bob' }));

    await expect(service.resolve({ host: 'myvpn.com', cookieSession })).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
      surfacePurpose: 'panel',
      surfaceDomainType: 'custom_domain',
    });
  });

  it('does not read the cookie when a token already answered, or when there is no surface', async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });
    const cookieSession = vi.fn(async () => null);

    await service.resolve({ host: 'myvpn.com', session: DOMAIN_TENANT.id, cookieSession });
    await service.resolve({ host: 'stranger.example', cookieSession });

    expect(cookieSession).not.toHaveBeenCalled();
  });
});
