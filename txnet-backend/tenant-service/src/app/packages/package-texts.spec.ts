import { currencyRegistry } from '../../../../test-support/currency-registry';
import { markingTranslator, memoryItemTextStore } from '../../../../test-support/item-text-store';
import { PACKAGE_TEXT_NAMESPACE, PackageTextService, packageTextKey } from './package-texts';
import { PackageTranslationsService } from './package-translations.service';
import { TenantPackageService } from './tenant-package.service';

/**
 * A package's name and description are locale-service text, as a product's are
 * (ADR-0154 decision 5, PK-1-c).
 *
 * What the package row alone cannot show:
 *
 *  - **the key is the server's**: `packages.p_<id, no dashes>.name` /
 *    `.description`, never taken from a caller;
 *  - **the owner writes one language**, the package's source language
 *    (`DEFAULT_LANGUAGE` when none is chosen), published as written; every
 *    other language gets a machine draft that a human publishes;
 *  - **the text is written in the package's transaction**: a locale-service
 *    that does not answer leaves no package behind;
 *  - **a package from before this row still reads**: no source language means
 *    `DEFAULT_LANGUAGE`, and "translate missing" publishes its `name` column
 *    as its source text before drafting the rest.
 */
describe('TenantPackageService — name and description in locale-service', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const PKG = '33333333-3333-4333-8333-333333333333';
  const OLD_PKG = '44444444-4444-4444-8444-444444444444';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };
  const NAME_ENTRY = 'p_33333333333343338333333333333333.name';
  const DESCRIPTION_ENTRY = 'p_33333333333343338333333333333333.description';

  type Row = { id: string; name: string; sourceLang: string | null; monthlyPrice: { toString(): string } | null; yearlyPrice: null; currencyCode: string; includedFeatureKeys: string[]; isActive: boolean };

  const build = () => {
    const locale = memoryItemTextStore(PACKAGE_TEXT_NAMESPACE, ['en', 'fa', 'de'], 'en');
    const rows = new Map<string, Row>();
    const committed: string[] = [];
    const row = (data: Record<string, unknown>, id = PKG): Row => ({
      id,
      name: String(data['name']),
      sourceLang: (data['sourceLang'] as string | null) ?? null,
      monthlyPrice: { toString: () => '10' },
      yearlyPrice: null,
      currencyCode: 'USD',
      includedFeatureKeys: [],
      isActive: true,
    });
    const tx = {
      ...currencyRegistry,
      $queryRaw: vi.fn(async () => []),
      tenant: { findFirst: vi.fn(async () => ({ id: OWNER_TENANT, operatingCurrencyCode: 'USD' })) },
      tenantFeaturePackage: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ ...(rows.get(where.id) as Row), ...data })),
        findUnique: vi.fn(async () => ({ includedFeatureKeys: [] })),
      },
      adminAuditLog: { create: vi.fn(async () => ({})) },
      tenantPackageMeterRate: { findMany: vi.fn(async () => []) },
      packageProduct: { groupBy: vi.fn(async () => []) },
    };
    const prisma = {
      tenant: { findUnique: vi.fn(async () => ({ tenantType: 'platform_owner' })) },
      tenantFeaturePackage: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string; name?: string } }) => (where.id ? (rows.get(where.id) ?? null) : null)),
        findMany: vi.fn(async () => [...rows.values()]),
      },
      tenantPackageMeterRate: { findMany: vi.fn(async () => []) },
      packageProduct: { groupBy: vi.fn(async () => []) },
    };
    const all = {
      ...prisma,
      adminAuditLog: { createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<{ id: string }>) => {
        const result = await fn(tx);
        committed.push(result.id ?? 'tx');
        return result;
      }),
    };
    const texts = new PackageTextService(locale.store, markingTranslator);
    const service = new TenantPackageService(prisma as never, all as never, texts);
    const translations = new PackageTranslationsService(prisma as never, all as never, texts);
    return { service, translations, locale, rows, row, tx, all, committed };
  };

  it('derives the keys from the package id, and nothing else', () => {
    expect(packageTextKey(PKG, 'name')).toBe(`packages.${NAME_ENTRY}`);
    expect(packageTextKey(PKG, 'description')).toBe(`packages.${DESCRIPTION_ENTRY}`);
  });

  it('publishes the source language as written, drafts every other language, and says so in the view', async () => {
    const { service, locale, tx } = build();
    const view = await service.create(actor, { name: 'طلایی', description: 'برای شروع', sourceLang: 'fa', monthlyPrice: '10.00', includedFeatureKeys: [] });

    expect(view).toMatchObject({ name: 'طلایی', sourceLang: 'fa', nameKey: `packages.${NAME_ENTRY}`, descriptionKey: `packages.${DESCRIPTION_ENTRY}` });
    expect(tx.tenantFeaturePackage.create.mock.calls[0][0].data).toMatchObject({ sourceLang: 'fa' });
    expect(locale.published['fa']).toEqual({ [NAME_ENTRY]: 'طلایی', [DESCRIPTION_ENTRY]: 'برای شروع' });
    await vi.waitFor(() => expect(locale.drafts['en']).toEqual({ [NAME_ENTRY]: '[fa>en] طلایی', [DESCRIPTION_ENTRY]: '[fa>en] برای شروع' }));
    expect(locale.drafts['de']?.[NAME_ENTRY]).toBe('[fa>de] طلایی');
    expect(locale.published['en']).toBeUndefined(); // a draft is never served
  });

  it('takes DEFAULT_LANGUAGE when no source language is chosen; no description means no description key', async () => {
    const { service, locale } = build();
    const view = await service.create(actor, { name: 'Gold', monthlyPrice: '10.00', includedFeatureKeys: [] });
    expect(view).toMatchObject({ sourceLang: 'en', descriptionKey: null });
    expect(locale.published['en']).toEqual({ [NAME_ENTRY]: 'Gold' });
  });

  it('refuses a language locale-service does not have, before anything is written', async () => {
    const { service, locale, committed } = build();
    await expect(service.create(actor, { name: 'Gold', sourceLang: 'xx', monthlyPrice: '10.00', includedFeatureKeys: [] })).rejects.toMatchObject({ reason: 'lang_unknown' });
    expect(committed).toEqual([]);
    expect(locale.published).toEqual({});
  });

  it('leaves no package behind when locale-service does not answer', async () => {
    const { service, locale, committed } = build();
    locale.state.fail = true;
    await expect(service.create(actor, { name: 'Gold', monthlyPrice: '10.00', includedFeatureKeys: [] })).rejects.toMatchObject({ reason: 'texts_unavailable' });
    expect(committed).toEqual([]);
  });

  it('a rename republishes the source text and redrafts; a description set to null is removed in every language', async () => {
    const { service, locale, rows, row } = build();
    rows.set(PKG, row({ name: 'Gold', sourceLang: 'en' }));
    locale.published['en'] = { [NAME_ENTRY]: 'Gold', [DESCRIPTION_ENTRY]: 'old' };
    locale.published['fa'] = { [DESCRIPTION_ENTRY]: 'قدیمی' };

    const view = await service.update(actor, PKG, { name: 'Platinum', description: null });

    expect(view).toMatchObject({ name: 'Platinum', descriptionKey: null });
    expect(locale.published['en']).toEqual({ [NAME_ENTRY]: 'Platinum' });
    expect(locale.published['fa']).toEqual({});
    await vi.waitFor(() => expect(locale.drafts['fa']?.[NAME_ENTRY]).toBe('[en>fa] Platinum'));
  });

  it('reads a package from before PK-1-c: its key, DEFAULT_LANGUAGE, and translate-missing publishes its name first', async () => {
    const { service, translations, locale, rows, row } = build();
    rows.set(OLD_PKG, row({ name: 'Starter', sourceLang: null }, OLD_PKG));
    const oldName = packageTextKey(OLD_PKG, 'name');

    expect(await service.read(actor, OLD_PKG)).toMatchObject({ nameKey: oldName, sourceLang: 'en', descriptionKey: null });
    expect(await translations.draftMissingTexts(actor)).toEqual({ drafted: 2 });
    expect(locale.published['en']).toEqual({ [oldName.slice('packages.'.length)]: 'Starter' });
    expect(locale.drafts['fa']).toEqual({ [oldName.slice('packages.'.length)]: '[en>fa] Starter' });
  });

  it('reviews package drafts with catalog’s shapes, publishes only keys it derived, and audits each package', async () => {
    const { translations: service, locale, rows, row, all } = build();
    rows.set(PKG, row({ name: 'Gold', sourceLang: 'en' }));
    locale.published['en'] = { [NAME_ENTRY]: 'Gold' };
    locale.drafts['fa'] = { [NAME_ENTRY]: 'طلایی' };

    expect(await service.listTextDrafts(actor, 'fa')).toEqual([
      { lang: 'fa', key: `packages.${NAME_ENTRY}`, draft: 'طلایی', published: null, source: { lang: 'en', text: 'Gold' } },
    ]);
    expect(await service.publishTextDrafts(actor, { lang: 'fa', keys: [`packages.${NAME_ENTRY}`] })).toEqual({ published: 1 });
    expect(locale.published['fa']).toEqual({ [NAME_ENTRY]: 'طلایی' });
    expect(await service.editTexts(actor, { lang: 'de', texts: { [`packages.${NAME_ENTRY}`]: 'Gold (de)' } })).toEqual({ published: 1 });
    expect(all.adminAuditLog.createMany).toHaveBeenCalledTimes(2);
    await expect(service.publishTextDrafts(actor, { lang: 'fa', keys: ['catalog.product.vpn.name'] })).rejects.toMatchObject({ reason: 'text_key_invalid' });
    await expect(service.publishTextDrafts(actor, { lang: 'fa', keys: [packageTextKey(OLD_PKG, 'name')] })).rejects.toMatchObject({ reason: 'text_key_invalid' });
  });
});
