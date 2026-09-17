/**
 * A campaign in every recipient's language (F-035-h).
 *
 * What would break silently here, and nowhere else:
 *  - **a machine draft is never sent.** The translator's answer is a draft an
 *    admin publishes; delivery reads published texts only, and a language with
 *    none gets the source text — never an unreviewed guess, never nothing;
 *  - **a translation never outlives the text it translates.** Editing the
 *    source body, subject or language drops every other language, so a stale
 *    translation of the old message cannot go out beside the new one;
 *  - **texts are the campaign's, and follow its access.** A tenant admin
 *    reaches them only through a campaign of their own tenant, on the app pool
 *    (invariant 7), and only while it is a draft (invariant 8);
 *  - **the subject always matches the body's language.** A text without a
 *    subject gets the translated default in *that* language, not the source's.
 */
import { CampaignStatus, CampaignTextState, Language, NotificationChannel, TenantType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { CampaignAdminService } from './campaign-admin.service';
import { CampaignTextService, textFor } from './campaign-texts';

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';
const UPDATED = new Date('2026-09-17T11:00:00Z');

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN,
    tenantId: TENANT,
    createdByAdminId: ADMIN,
    channel: NotificationChannel.email,
    filterCriteria: {},
    messageBody: 'سلام',
    subject: 'تخفیف',
    sourceLang: Language.fa,
    status: CampaignStatus.draft,
    sentCount: 0,
    failedCount: 0,
    createdAt: new Date('2026-09-17T10:00:00Z'),
    ...overrides,
  };
}

const textRow = (overrides: Record<string, unknown> = {}) => ({
  lang: Language.en,
  subject: 'Discount',
  body: 'Hello',
  state: CampaignTextState.draft,
  updatedAt: UPDATED,
  ...overrides,
});

function pool(texts: unknown[] = []) {
  const client = {
    tenant: { findUnique: vi.fn() },
    notificationCampaign: {
      findUnique: vi.fn().mockResolvedValue(campaignRow()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    notificationCampaignText: {
      findMany: vi.fn().mockResolvedValue(texts),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockImplementation(({ create }) => Promise.resolve(textRow({ ...create, state: CampaignTextState.published }))),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(textRow({ state: CampaignTextState.published })),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
  };
  // Runs an interactive body the way Prisma does, minus the database.
  client.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run({ ...client, $executeRaw: vi.fn() }));
  return client;
}

function fakes({ callerType = TenantType.reseller as TenantType, texts = [] as unknown[], translate = vi.fn() as ReturnType<typeof vi.fn> } = {}) {
  const prisma = pool(texts);
  prisma.tenant.findUnique.mockResolvedValue({ tenantType: callerType });
  const all = pool(texts);
  const campaigns = new CampaignAdminService(prisma as never, all as never, {} as never);
  const translator = { translate, languages: vi.fn().mockResolvedValue([]) };
  const locale = { getDefaultLanguage: () => 'fa' };
  return { prisma, all, translate, service: new CampaignTextService(campaigns, translator as never, locale as never) };
}

const as = <T>(tenantId: string, run: () => Promise<T>) => runWithTenant({ id: tenantId }, run);
const tenantAdmin = { adminId: ADMIN, tenantId: TENANT };

describe('textFor', () => {
  const campaign = { messageBody: 'سلام', subject: 'تخفیف', sourceLang: Language.fa };

  it("sends the published text in the recipient's language, and the source otherwise", () => {
    const published = [{ lang: Language.en, subject: 'Discount', body: 'Hello' }];
    expect(textFor(campaign, published, Language.en, Language.fa)).toEqual({ lang: 'en', subject: 'Discount', body: 'Hello' });
    expect(textFor(campaign, [], Language.en, Language.fa)).toEqual({ lang: 'fa', subject: 'تخفیف', body: 'سلام' });
  });

  it('reads a campaign with no source language as DEFAULT_LANGUAGE', () => {
    expect(textFor({ ...campaign, sourceLang: null }, [], Language.en, Language.fa).lang).toBe('fa');
    expect(textFor({ ...campaign, sourceLang: null }, [], Language.fa, Language.fa)).toEqual({ lang: 'fa', subject: 'تخفیف', body: 'سلام' });
  });

  it("never pairs one language's body with another's subject", () => {
    const published = [{ lang: Language.en, subject: null, body: 'Hello' }];
    expect(textFor(campaign, published, Language.en, Language.fa)).toEqual({ lang: 'en', subject: null, body: 'Hello' });
  });
});

describe('CampaignTextService', () => {
  it('lists the texts beside the source, and the languages still missing', async () => {
    const { prisma, all, service } = fakes({ texts: [] });

    const view = await as(TENANT, () => service.list(tenantAdmin, CAMPAIGN));

    expect(view).toEqual({ sourceLang: 'fa', subject: 'تخفیف', messageBody: 'سلام', texts: [], missing: ['en'] });
    expect(prisma.notificationCampaignText.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { campaignId: CAMPAIGN } }));
    expect(all.notificationCampaignText.findMany).not.toHaveBeenCalled();
  });

  it('drafts every missing language from the source, as a message, and publishes nothing', async () => {
    const translate = vi.fn().mockImplementation((text: string) => Promise.resolve(text === 'سلام' ? 'Hello' : 'Discount'));
    const { prisma, service } = fakes({ translate });

    const view = await as(TENANT, () => service.draftMissing(tenantAdmin, CAMPAIGN));

    expect(translate).toHaveBeenCalledWith('سلام', 'fa', 'en', 'message');
    expect(translate).toHaveBeenCalledWith('تخفیف', 'fa', 'en', 'message');
    expect(prisma.notificationCampaignText.createMany).toHaveBeenCalledWith({
      data: [{ campaignId: CAMPAIGN, lang: Language.en, subject: 'Discount', body: 'Hello', state: CampaignTextState.draft }],
      skipDuplicates: true,
    });
    expect(view.drafted).toBe(1);
  });

  it('drafts nothing for a language the engine could not translate whole, and leaves existing texts alone', async () => {
    const half = fakes({ translate: vi.fn().mockImplementation((text: string) => Promise.resolve(text === 'سلام' ? 'Hello' : null)) });
    expect((await as(TENANT, () => half.service.draftMissing(tenantAdmin, CAMPAIGN))).drafted).toBe(0);
    expect(half.prisma.notificationCampaignText.createMany).not.toHaveBeenCalled();

    const translate = vi.fn();
    const done = fakes({ texts: [textRow()], translate });
    await as(TENANT, () => done.service.draftMissing(tenantAdmin, CAMPAIGN));
    expect(translate).not.toHaveBeenCalled();
  });

  it("publishes an admin's own text, and refuses one in the source language", async () => {
    const { prisma, service } = fakes();

    await as(TENANT, () => service.write(tenantAdmin, CAMPAIGN, Language.en, { subject: 'Sale', body: 'Hi' }));
    expect(prisma.notificationCampaignText.upsert).toHaveBeenCalledWith({
      where: { campaignId_lang: { campaignId: CAMPAIGN, lang: Language.en } },
      create: { campaignId: CAMPAIGN, lang: Language.en, subject: 'Sale', body: 'Hi', state: CampaignTextState.published },
      update: { subject: 'Sale', body: 'Hi', state: CampaignTextState.published },
    });

    await expect(
      as(TENANT, () => service.write(tenantAdmin, CAMPAIGN, Language.fa, { subject: null, body: 'x' })),
    ).rejects.toMatchObject({ reason: 'text_is_source' });
  });

  it('publishes a draft as it is, and answers a language with no draft as not found', async () => {
    const { prisma, service } = fakes();
    await as(TENANT, () => service.publish(tenantAdmin, CAMPAIGN, Language.en));
    expect(prisma.notificationCampaignText.updateMany).toHaveBeenCalledWith({
      where: { campaignId: CAMPAIGN, lang: Language.en },
      data: { state: CampaignTextState.published },
    });

    const none = fakes();
    none.prisma.notificationCampaignText.updateMany.mockResolvedValue({ count: 0 });
    await expect(as(TENANT, () => none.service.publish(tenantAdmin, CAMPAIGN, Language.en))).rejects.toMatchObject({
      reason: 'text_not_found',
    });
  });

  it('touches no text of a campaign that is not a draft, or not the caller\'s', async () => {
    const sending = fakes();
    sending.prisma.notificationCampaign.findUnique.mockResolvedValue(campaignRow({ status: CampaignStatus.sending }));
    await expect(
      as(TENANT, () => sending.service.write(tenantAdmin, CAMPAIGN, Language.en, { subject: null, body: 'x' })),
    ).rejects.toMatchObject({ reason: 'campaign_not_draft' });
    expect(sending.prisma.notificationCampaignText.upsert).not.toHaveBeenCalled();

    const foreign = fakes();
    foreign.prisma.notificationCampaign.findUnique.mockResolvedValue(campaignRow({ tenantId: OWNER_TENANT }));
    await expect(as(TENANT, () => foreign.service.list(tenantAdmin, CAMPAIGN))).rejects.toMatchObject({ reason: 'campaign_not_found' });
    expect(foreign.prisma.notificationCampaignText.findMany).not.toHaveBeenCalled();
  });
});

describe('CampaignAdminService.update — the source changes', () => {
  it('drops every translation when the body, subject or source language changes, and keeps them otherwise', async () => {
    for (const patch of [{ messageBody: 'new' }, { subject: 'new' }, { sourceLang: Language.en }]) {
      const { prisma, all } = fakes();
      await as(TENANT, () => new CampaignAdminService(prisma as never, all as never, {} as never).update(tenantAdmin, CAMPAIGN, patch));
      expect(prisma.notificationCampaignText.deleteMany).toHaveBeenCalledWith({ where: { campaignId: CAMPAIGN } });
    }

    const { prisma, all } = fakes();
    await as(TENANT, () => new CampaignAdminService(prisma as never, all as never, {} as never).update(tenantAdmin, CAMPAIGN, { audience: {} }));
    expect(prisma.notificationCampaignText.deleteMany).not.toHaveBeenCalled();
  });
});
