import { ObjectStorage, TenantContext, type ObjectDriver, type StoredObjectRow, type StoredObjectStore, ResellerAccess } from '@txnet-backend/shared-core';

import { lineNamePreviewSchema, lineNameTemplateSchema, updateBrandingSchema } from './tenant-branding.schema';
import { BrandingRefused, TenantBrandingService } from './tenant-branding.service';

/**
 * The invariants F-018-h turns on (catalog 13.8, D-42 (3)).
 *
 * - `tenant_branding` holds asset **keys**, each in the reseller's own prefix;
 *   a URL is built at read time from the reseller's current `assets` or
 *   `panel` domain — never the caller's, never a CNAME target.
 * - An upload is PNG or WebP, under its slot's cap, and is what it says it is;
 *   a refused one changes nothing.
 * - Every text value is narrowed before it is stored: `https` links only,
 *   `#rrggbb` colours, no control characters, no field the schema does not name.
 * - Only the reseller's owner (by its status) or the platform owner's staff
 *   reaches it; the public read takes its tenant from the Host alone.
 */
describe('TenantBrandingService', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'] };
  const stranger = { userId: STAFF, tenantId: PLATFORM, permissions: [] as string[] };

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  type Domain = { tenantId: string; domainValue: string; domainType: 'subdomain' | 'custom_domain'; purpose: string; verificationStatus: string };

  const build = (opts: { status?: string; domains?: Domain[] } = {}) => {
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform_owner', ownerUserId: STAFF, status: 'active', deletedAt: null },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status: opts.status ?? 'active', graceEndsAt: null, deletedAt: null },
    };
    const appPrisma = {
      tenant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
      },
    };

    const branding = new Map<string, Record<string, unknown>>();
    const domains: Domain[] = opts.domains ?? [
      { tenantId: RESELLER, domainValue: 'ali.txnet.app', domainType: 'subdomain', purpose: 'panel', verificationStatus: 'pending' },
      { tenantId: RESELLER, domainValue: 'ali.edge.txnet.app', domainType: 'subdomain', purpose: 'panel', verificationStatus: 'pending' },
    ];
    const all = {
      tenant: { findUnique: appPrisma.tenant.findUnique },
      tenantBranding: {
        findUnique: vi.fn(async ({ where }: { where: { tenantId: string } }) => branding.get(where.tenantId) ?? null),
        upsert: vi.fn(async ({ where, create, update }: { where: { tenantId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const row = branding.has(where.tenantId) ? { ...branding.get(where.tenantId), ...update } : { socials: {}, ...create };
          branding.set(where.tenantId, { ...row, updatedAt: new Date('2026-09-18T10:00:00Z') });
          return branding.get(where.tenantId);
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { tenantId: string }; data: Record<string, unknown> }) => {
          const row = branding.get(where.tenantId);
          if (row) Object.assign(row, data);
          return { count: row ? 1 : 0 };
        }),
      },
      tenantDomain: {
        findMany: vi.fn(async ({ where }: { where: { tenantId: string } }) => domains.filter((d) => d.tenantId === where.tenantId)),
      },
    };

    // The real port over memory: the policy, the sniffing and the scope are the ones production runs.
    const bytes = new Map<string, Buffer>();
    const driver: ObjectDriver = {
      write: async (k, b) => void bytes.set(k, b),
      read: async (k) => bytes.get(k) ?? null,
      remove: async (k) => void bytes.delete(k),
    };
    const objects = new Map<string, StoredObjectRow>();
    const scopes: string[] = [];
    const rows: StoredObjectStore = {
      upsert: async ({ create }) => {
        scopes.push(TenantContext.current('test').id);
        objects.set(create.key, create);
        return create;
      },
      findUnique: async ({ where }) => objects.get(where.key) ?? null,
      deleteMany: async ({ where }) => ({ count: objects.delete(where.key) ? 1 : 0 }),
    };
    const storage = new ObjectStorage(driver, rows);
    const config = { get: () => 'api' };

    const service = new TenantBrandingService(
      new ResellerAccess(appPrisma as never),
      all as never,
      storage,
      config as never,
    );
    return { service, branding, bytes, objects, scopes };
  };

  const text = (over: Record<string, unknown> = {}) =>
    updateBrandingSchema.parse({ brandName: 'Ali VPN', primaryColorHex: '#1A2B3C', socials: { telegram: 'https://t.me/alivpn' }, ...over });

  describe('the text', () => {
    it('stores what the owner sent, narrowed, and reads it back', async () => {
      const { service } = build();
      const view = await service.update(owner, RESELLER, text({ supportUrl: 'https://t.me/ali_support', defaultLanguage: 'en' }));
      expect(view).toMatchObject({
        brandName: 'Ali VPN',
        primaryColorHex: '#1a2b3c',
        secondaryColorHex: null,
        supportUrl: 'https://t.me/ali_support',
        socials: { telegram: 'https://t.me/alivpn' },
        defaultLanguage: 'en',
        logoLightUrl: null,
      });
      expect(await service.read(staff, RESELLER)).toMatchObject({ brandName: 'Ali VPN' });
    });

    it.each([
      ['a javascript: link', { supportUrl: 'javascript:alert(1)' }],
      ['an http link', { termsUrl: 'http://ali.example/terms' }],
      ['a colour that is not #rrggbb', { primaryColorHex: 'red;background:url(x)' }],
      ['a bidi override in the name', { brandName: 'Ali‮NPV' }],
      ['a newline in the name', { brandName: 'Ali\n<b>VPN</b>' }],
      ['an empty name', { brandName: '   ' }],
      ['an unknown network', { socials: { myspace: 'https://myspace.com/ali' } }],
      ['an asset key in the body', { logoLightKey: 'tenants/33333333-3333-3333-3333-333333333333/branding/logo-light' }],
    ])('refuses %s', (_what, over) => {
      expect(updateBrandingSchema.safeParse({ brandName: 'Ali VPN', ...over }).success).toBe(false);
    });

    it('reads a reseller with no row as its slug and nothing else', async () => {
      const { service } = build();
      expect(await service.read(owner, RESELLER)).toMatchObject({ brandName: 'ali', logoLightUrl: null, socials: {}, defaultLanguage: 'fa' });
    });
  });

  describe('the line-name template (F-307-j, ADR-0089 rule 4)', () => {
    const template = (t: unknown) => lineNameTemplateSchema.parse({ template: t }).template;

    it('stores a template trimmed, reads it back, and an empty one is the platform default', async () => {
      const { service } = build();
      expect(await service.read(owner, RESELLER)).toMatchObject({ lineNameTemplate: null });
      // No row yet: the slug stands in for the name, as for a first upload.
      expect(await service.setLineNameTemplate(owner, RESELLER, template('  {brand} · {region} '))).toMatchObject({
        brandName: 'ali',
        lineNameTemplate: '{brand} · {region}',
      });
      expect(await service.setLineNameTemplate(owner, RESELLER, template(''))).toMatchObject({ lineNameTemplate: null });
    });

    it('is left alone by the whole-text PUT, which does not name it', async () => {
      const { service } = build();
      await service.setLineNameTemplate(owner, RESELLER, template('{brand}'));
      expect(await service.update(owner, RESELLER, text())).toMatchObject({ brandName: 'Ali VPN', lineNameTemplate: '{brand}' });
    });

    it.each([
      ['a placeholder it does not know', '{brand} {n}'],
      ['a stray brace', '{brand'],
      ['more than 40 characters', 'x'.repeat(41)],
      ['a bidi override', '{brand}\u202e'],
    ])('refuses %s', (_what, t) => {
      expect(lineNameTemplateSchema.safeParse({ template: t }).success).toBe(false);
    });

    it('is written by the owner or staff, never a suspended owner', async () => {
      const { service } = build({ status: 'suspended' });
      await expect(service.setLineNameTemplate(owner, RESELLER, '{brand}')).rejects.toMatchObject({ reason: 'reseller_suspended' });
      await expect(service.setLineNameTemplate(stranger, RESELLER, '{brand}')).rejects.toMatchObject({ reason: 'not_allowed' });
      await expect(service.setLineNameTemplate(staff, RESELLER, '{brand}')).resolves.toMatchObject({ lineNameTemplate: '{brand}' });
    });

    it('previews one line\'s name with the reseller\'s brand, or says what is wrong', async () => {
      const { service } = build();
      await service.update(owner, RESELLER, text());
      const preview = (t: string | null) => service.previewLineName(owner, RESELLER, lineNamePreviewSchema.parse({ template: t, region: 'آلمان' }));
      expect(await preview('{brand} · {region}')).toEqual({ name: 'Ali VPN · آلمان', problem: null });
      expect(await preview(null)).toEqual({ name: 'آلمان', problem: null });
      expect(await preview('{brand} {n}')).toEqual({ name: null, problem: 'unknown_placeholder' });
      await expect(service.previewLineName(stranger, RESELLER, { template: null, region: 'x' })).rejects.toMatchObject({ reason: 'not_allowed' });
    });
  });

  describe('the assets', () => {
    it('stores an upload in the reseller\'s own prefix and keeps only its key', async () => {
      const { service, branding, scopes } = build();
      const view = await service.upload(owner, RESELLER, 'logo-light', { buffer: PNG, mimetype: 'image/png' });

      const key = `tenants/${RESELLER}/branding/logo-light`;
      expect(branding.get(RESELLER)?.['logoLightKey']).toBe(key);
      // Scoped to the path's reseller, not the owner's platform tenant.
      expect(scopes).toEqual([RESELLER]);
      // Its platform subdomains serve nothing (ADR-0063) — the target nor a
      // pre-ADR-0063 `ali.txnet.app` — so with no own domain there is no URL
      // yet, rather than one that 404s (F-018-aj).
      expect(view.logoLightUrl).toBeNull();
      expect(view.brandName).toBe('ali');
    });

    it('builds the URL on a proven assets domain first, then a proven custom panel domain', async () => {
      const base: Domain[] = [
        { tenantId: RESELLER, domainValue: 'ali.txnet.app', domainType: 'subdomain', purpose: 'panel', verificationStatus: 'pending' },
        { tenantId: RESELLER, domainValue: 'panel.ali.ir', domainType: 'custom_domain', purpose: 'panel', verificationStatus: 'verified' },
        { tenantId: RESELLER, domainValue: 'cdn.ali.ir', domainType: 'custom_domain', purpose: 'assets', verificationStatus: 'failed' },
      ];
      const one = build({ domains: base });
      const panel = await one.service.upload(owner, RESELLER, 'favicon', { buffer: WEBP, mimetype: 'image/webp' });
      expect(panel.faviconUrl).toMatch(/^https:\/\/panel\.ali\.ir\/api\/public\/tenant\/files\//);

      const two = build({ domains: [...base.slice(0, 2), { ...base[2], verificationStatus: 'verified' }] });
      const assets = await two.service.upload(owner, RESELLER, 'favicon', { buffer: WEBP, mimetype: 'image/webp' });
      expect(assets.faviconUrl).toMatch(/^https:\/\/cdn\.ali\.ir\/api\/public\/tenant\/files\//);
    });

    it.each([
      ['an SVG', 'image/svg+xml', SVG, 'type_not_allowed'],
      ['a JPEG (the port allows it; branding does not)', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'type_not_allowed'],
      ['an SVG declared a PNG', 'image/png', SVG, 'type_mismatch'],
      ['a favicon over its cap', 'image/png', Buffer.concat([PNG, Buffer.alloc(200 * 1024)]), 'too_large'],
    ])('refuses %s and changes nothing', async (_what, mimetype, buffer, reason) => {
      const { service, branding, bytes } = build();
      await expect(service.upload(owner, RESELLER, 'favicon', { buffer, mimetype })).rejects.toMatchObject({ reason });
      expect(branding.size).toBe(0);
      expect(bytes.size).toBe(0);
    });

    it('removes an asset: the key first, then the file', async () => {
      const { service, branding, bytes, objects } = build();
      await service.upload(owner, RESELLER, 'og-image', { buffer: PNG, mimetype: 'image/png' });
      const view = await service.remove(owner, RESELLER, 'og-image');
      expect(view.ogImageUrl).toBeNull();
      expect(branding.get(RESELLER)?.['ogImageKey']).toBeNull();
      expect(bytes.size).toBe(0);
      expect(objects.size).toBe(0);
      // Twice is harmless.
      await expect(service.remove(owner, RESELLER, 'og-image')).resolves.toMatchObject({ ogImageUrl: null });
    });
  });

  describe('who', () => {
    it('refuses anyone who is neither the owner nor the platform owner\'s staff', async () => {
      const { service } = build();
      await expect(service.read(stranger, RESELLER)).rejects.toBeInstanceOf(BrandingRefused);
      await expect(service.update(stranger, RESELLER, text())).rejects.toMatchObject({ reason: 'not_allowed' });
    });

    it('lets a suspended reseller\'s owner read but not write; staff still write', async () => {
      const { service } = build({ status: 'suspended' });
      await expect(service.read(owner, RESELLER)).resolves.toMatchObject({ brandName: 'ali' });
      await expect(service.upload(owner, RESELLER, 'logo-dark', { buffer: PNG, mimetype: 'image/png' })).rejects.toMatchObject({ reason: 'reseller_suspended' });
      await expect(service.update(staff, RESELLER, text())).resolves.toMatchObject({ brandName: 'Ali VPN' });
    });

    it('serves the public read for the tenant the Host resolved to', async () => {
      const { service } = build();
      await service.update(owner, RESELLER, text());
      expect(await service.ofTenant(RESELLER)).toMatchObject({ brandName: 'Ali VPN', primaryColorHex: '#1a2b3c' });
    });
  });
});
