import {
  TENANT_CACHE_TTL_MS,
  TenantResolverService,
} from './tenant-resolver.service';
import { normalizeHost } from './tenant';

/**
 * Resolution decides which tenant an account is written into (F-061-b), and
 * every way of getting it wrong is quiet: an unverified custom domain that
 * resolves hands a reseller's brand to whoever pointed a CNAME at it, and a
 * fallback that fires when it should not writes accounts into the platform
 * owner while looking exactly like success. Those are the cases below —
 * not the happy path, which the caller would notice.
 */

const DOMAIN_TENANT = { id: 'tenant-reseller', slug: 'reseller' };
const DEFAULT_TENANT = { id: 'tenant-platform', slug: 'platform_owner' };

type DomainRow = {
  domainType: 'subdomain' | 'custom_domain';
  verificationStatus: 'pending' | 'verified' | 'failed';
  tenant: { id: string; slug: string };
};

function resolver(rows: Record<string, DomainRow>, defaultSlug = 'platform_owner') {
  const findUnique = jest.fn(async ({ where }: any) => rows[where.domainValue] ?? null);
  const findFirst = jest.fn(async ({ where }: any) =>
    where.slug === DEFAULT_TENANT.slug ? DEFAULT_TENANT : null,
  );
  const prisma = { tenantDomain: { findUnique }, tenant: { findFirst } };
  const config = { get: jest.fn(() => defaultSlug) };

  return {
    service: new TenantResolverService(prisma as never, config as never),
    findUnique,
    findFirst,
  };
}

const subdomain = (): DomainRow => ({
  domainType: 'subdomain',
  verificationStatus: 'pending',
  tenant: DOMAIN_TENANT,
});

const customDomain = (
  verificationStatus: DomainRow['verificationStatus'],
): DomainRow => ({
  domainType: 'custom_domain',
  verificationStatus,
  tenant: DOMAIN_TENANT,
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

    await expect(service.resolve('reseller.txnet.app')).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
    });
  });

  it('resolves a verified custom domain', async () => {
    const { service } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(service.resolve('myvpn.com')).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
    });
  });

  it.each(['pending', 'failed'] as const)(
    'refuses a %s custom domain and falls back, exactly as an unknown host does',
    async (status) => {
      const { service } = resolver({ 'myvpn.com': customDomain(status) });

      await expect(service.resolve('myvpn.com')).resolves.toEqual({
        ...DEFAULT_TENANT,
        via: 'default',
      });
    },
  );

  it('falls back for a host with no row at all', async () => {
    const { service } = resolver({});

    await expect(service.resolve('stranger.example')).resolves.toEqual({
      ...DEFAULT_TENANT,
      via: 'default',
    });
  });

  it('falls back for a request with no usable host, without looking a domain up', async () => {
    const { service, findUnique } = resolver({});

    await expect(service.resolve(undefined)).resolves.toEqual({
      ...DEFAULT_TENANT,
      via: 'default',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('matches the row through the normalized host, not the header as sent', async () => {
    const { service, findUnique } = resolver({ 'myvpn.com': customDomain('verified') });

    await expect(service.resolve('MyVPN.com:8443')).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domainValue: 'myvpn.com' } }),
    );
  });

  it('answers null when the configured fallback tenant does not exist', async () => {
    // A configuration bug, and the only honest answer is "no tenant". Inventing
    // `platform_owner` here would write accounts into a tenant nobody named.
    const { service } = resolver({}, 'no-such-tenant');

    await expect(service.resolve('stranger.example')).resolves.toBeNull();
  });
});

describe('TenantResolverService — the cache', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reads each host once within the TTL', async () => {
    const { service, findUnique } = resolver({ 'myvpn.com': customDomain('verified') });

    await service.resolve('myvpn.com');
    await service.resolve('myvpn.com');

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not outlive the TTL — a domain verified elsewhere works without a restart', async () => {
    const rows: Record<string, DomainRow> = { 'myvpn.com': customDomain('pending') };
    const { service } = resolver(rows);

    await expect(service.resolve('myvpn.com')).resolves.toEqual({
      ...DEFAULT_TENANT,
      via: 'default',
    });

    rows['myvpn.com'] = customDomain('verified');
    jest.advanceTimersByTime(TENANT_CACHE_TTL_MS + 1);

    await expect(service.resolve('myvpn.com')).resolves.toEqual({
      ...DOMAIN_TENANT,
      via: 'domain',
    });
  });

  it('caches each host separately', async () => {
    const { service, findUnique } = resolver({ 'myvpn.com': customDomain('verified') });

    await service.resolve('myvpn.com');
    await service.resolve('other.example');

    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
