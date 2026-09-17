/**
 * Delivering a campaign to Telegram and Bale (F-035-e): a claimed `queued` row
 * is sent through `messenger` and moves to `sent` or `failed` — or stays
 * `queued` for the next run.
 *
 * What would break silently here, and nowhere else:
 *  - **a message goes out as the recipient's own tenant's primary bot, to a
 *    chat that user proved in that tenant** (invariant 9). This path runs on
 *    the cross-tenant pool, so nothing below the query stops a chat linked in
 *    another reseller's bot from being picked;
 *  - **a row is sent at most once per claim** (invariant 4). Two runs can
 *    overlap, so the claim skips locked rows and rows another run still holds;
 *  - **only a refusal is final.** A blocked bot or a missing chat is `failed`;
 *    a rate limit, an unreachable platform or a token that cannot be read
 *    leaves the row `queued`, so the campaign is not burned by an outage;
 *  - **a counter moves only through `recordOutcome`** (invariant 2);
 *  - **an SMS goes out on the platform's line only from the platform owner's
 *    own campaign, to its own users' verified phones** (F-035-f, D-38,
 *    invariant 10). Nothing meters or bills that line yet, so a reseller's
 *    campaign — or a platform-wide one reaching a reseller's user — would cost
 *    the platform and show a reseller's customer the platform's number;
 *  - **email goes out on the same terms, to a verified address** (F-035-h), and
 *  - **every channel sends the recipient's own language when an admin
 *    published it**, the source otherwise — never a machine draft.
 */
import { DeliveryStatus, NotificationChannel } from '@prisma/client';

import { CHANNEL_PLATFORM, CampaignDeliveryService, DELIVERY_CALLER } from './campaign-delivery.service';
import { MailLineResolver, platformMailLine } from './mail-line';
import { SmsLineResolver, platformSmsLine } from './sms-line';

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-09-17T12:00:00Z');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const integration = (overrides: Record<string, unknown> = {}) => ({
  id: 'bot-1',
  tenantId: TENANT,
  platform: 'telegram',
  botUsername: 'shop_bot',
  webhookPath: 'path',
  credentialRef: 'ref',
  role: 'primary',
  status: 'active',
  ...overrides,
});

type Row = { id: string; campaignId: string; userId: string };

function fakes({
  rows = [{ id: id(101), campaignId: CAMPAIGN, userId: id(1) }] as Row[],
  channel = NotificationChannel.telegram_bot as NotificationChannel,
  users = [{ id: id(1), tenantId: TENANT }],
  links = [{ userId: id(1), tenantId: TENANT, platform: 'telegram', platformUserId: '9001' }],
  primary = vi.fn().mockResolvedValue(integration()) as ReturnType<typeof vi.fn>,
  sendText = vi.fn().mockResolvedValue({ ok: true, messageId: 1 }) as ReturnType<typeof vi.fn>,
  client = true,
  campaignTenant = TENANT as string | null,
  owner = { id: OWNER_TENANT } as { id: string } | null,
  smsSend = vi.fn().mockResolvedValue({ status: 'sent' }) as ReturnType<typeof vi.fn>,
  smsLine = true,
  mailSend = vi.fn().mockResolvedValue({ status: 'sent' }) as ReturnType<typeof vi.fn>,
  mailLine = true,
  texts = [] as unknown[],
  subject = null as string | null,
} = {}) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(rows),
    notificationCampaign: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: CAMPAIGN, tenantId: campaignTenant, channel, messageBody: 'Hello <b>you</b>', subject, sourceLang: null }]),
    },
    notificationCampaignText: { findMany: vi.fn().mockResolvedValue(texts) },
    tenant: { findFirst: vi.fn().mockResolvedValue(owner) },
    user: { findMany: vi.fn().mockResolvedValue(users) },
    linkedBotAccount: { findMany: vi.fn().mockResolvedValue(links) },
    notificationCampaignRecipient: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const bots = {
    primaryFor: primary,
    client: vi.fn().mockResolvedValue(client ? { sendText } : null),
  };
  const outcomes = { recordOutcome: vi.fn().mockResolvedValue({ changed: true }) };
  const sms = new SmsLineResolver(smsLine ? ({ send: smsSend } as never) : null);
  const mail = new MailLineResolver(mailLine ? ({ send: mailSend } as never) : null);
  const locale = {
    getDefaultLanguage: () => 'fa',
    getKey: (lang: string, _ns: string, key: string) => (key === 'campaign.emailSubject' ? `subject:${lang}` : undefined),
  };
  const service = new CampaignDeliveryService(db as never, bots as never, outcomes as never, sms, mail, locale as never, { now: () => NOW });
  return { db, bots, outcomes, sendText, smsSend, mailSend, service };
}

describe('CHANNEL_PLATFORM', () => {
  it('sends the two bot channels through messenger; SMS is this unit\'s own line (F-035-f)', () => {
    expect(CHANNEL_PLATFORM).toEqual({ telegram_bot: 'telegram', bale_bot: 'bale', push: null, sms: null, email: null });
  });
});

describe('CampaignDeliveryService.deliver', () => {
  it('claims queued rows of sending bot campaigns, skipping locked and still-held rows', async () => {
    const { db, service } = fakes();

    await service.deliver();

    const sql = db.$queryRaw.mock.calls[0][0];
    const text = sql.strings.join('?');
    expect(text).toContain('SKIP LOCKED');
    expect(text).toContain('"claimedUntil" IS NULL OR r."claimedUntil" <');
    expect(text).toContain(`"deliveryStatus" = 'queued'`);
    expect(text).toContain(`c."status" = 'sending'`);
    expect(sql.values).toEqual(expect.arrayContaining(['telegram_bot', 'bale_bot', 'sms', 'email']));
    expect(sql.values).not.toContain('push');
  });

  it("sends as the recipient's own tenant's primary bot, to their verified chat, as plain text (invariant 9)", async () => {
    const { db, bots, outcomes, sendText, service } = fakes();

    const result = await service.deliver();

    expect(db.linkedBotAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: { in: [id(1)] }, contactVerifiedAt: { not: null } },
      }),
    );
    expect(bots.primaryFor).toHaveBeenCalledWith(TENANT, 'telegram');
    expect(bots.client).toHaveBeenCalledWith(integration(), DELIVERY_CALLER);
    expect(sendText).toHaveBeenCalledWith('9001', 'Hello <b>you</b>');
    expect(outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.sent);
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, deferred: 0, stalled: 0 });
  });

  it('never uses a chat the user linked in another tenant, and fails the row instead', async () => {
    const { outcomes, sendText, service } = fakes({
      links: [{ userId: id(1), tenantId: OTHER_TENANT, platform: 'telegram', platformUserId: '9001' }],
    });

    const result = await service.deliver();

    expect(sendText).not.toHaveBeenCalled();
    expect(outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.failed);
    expect(result.failed).toBe(1);
  });

  it('fails a row with no link on the campaign platform, and one whose tenant has no or a disabled bot', async () => {
    const bale = fakes({ channel: NotificationChannel.bale_bot });
    await bale.service.deliver();
    expect(bale.outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.failed);

    const none = fakes({ primary: vi.fn().mockResolvedValue(null) });
    await none.service.deliver();
    expect(none.outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.failed);

    const disabled = fakes({ primary: vi.fn().mockResolvedValue(integration({ status: 'disabled' })) });
    await disabled.service.deliver();
    expect(disabled.bots.client).not.toHaveBeenCalled();
    expect(disabled.outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.failed);
  });

  it('fails a row the platform refuses for good — a blocked bot, a chat that is gone', async () => {
    const { outcomes, service } = fakes({
      sendText: vi.fn().mockResolvedValue({ ok: false, permanent: true, retryAfterSec: null, description: 'Forbidden: bot was blocked by the user' }),
    });

    const result = await service.deliver();

    expect(outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.failed);
    expect(result.failed).toBe(1);
  });

  it('leaves rate-limited rows queued until retry_after, and stops sending as that bot for the run', async () => {
    const rows = [
      { id: id(101), campaignId: CAMPAIGN, userId: id(1) },
      { id: id(102), campaignId: CAMPAIGN, userId: id(2) },
    ];
    const sendText = vi.fn().mockResolvedValue({ ok: false, permanent: false, retryAfterSec: 30, description: 'Too Many Requests' });
    const { db, outcomes, service } = fakes({
      rows,
      users: [{ id: id(1), tenantId: TENANT }, { id: id(2), tenantId: TENANT }],
      links: [
        { userId: id(1), tenantId: TENANT, platform: 'telegram', platformUserId: '9001' },
        { userId: id(2), tenantId: TENANT, platform: 'telegram', platformUserId: '9002' },
      ],
      sendText,
    });

    const result = await service.deliver();

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(outcomes.recordOutcome).not.toHaveBeenCalled();
    expect(db.notificationCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [id(101), id(102)] }, deliveryStatus: DeliveryStatus.queued },
      data: { claimedUntil: new Date(NOW.getTime() + 30_000) },
    });
    expect(result).toEqual({ claimed: 2, sent: 0, failed: 0, deferred: 2, stalled: 0 });
  });

  it('leaves rows queued and releases them when the bot cannot be reached or its token not read', async () => {
    const outage = fakes({ primary: vi.fn().mockRejectedValue(new Error('auth-api answered 502')) });
    const down = await outage.service.deliver();
    expect(outage.outcomes.recordOutcome).not.toHaveBeenCalled();
    expect(outage.db.notificationCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [id(101)] }, deliveryStatus: DeliveryStatus.queued },
      data: { claimedUntil: null },
    });
    expect(down).toEqual({ claimed: 1, sent: 0, failed: 0, deferred: 0, stalled: 1 });

    const noToken = fakes({ client: false });
    expect((await noToken.service.deliver()).stalled).toBe(1);
    expect(noToken.outcomes.recordOutcome).not.toHaveBeenCalled();
  });

  it('asks for each bot once per run, whatever the number of rows', async () => {
    const rows = [
      { id: id(101), campaignId: CAMPAIGN, userId: id(1) },
      { id: id(102), campaignId: CAMPAIGN, userId: id(2) },
    ];
    const { bots, outcomes, service } = fakes({
      rows,
      users: [{ id: id(1), tenantId: TENANT }, { id: id(2), tenantId: TENANT }],
      links: [
        { userId: id(1), tenantId: TENANT, platform: 'telegram', platformUserId: '9001' },
        { userId: id(2), tenantId: TENANT, platform: 'telegram', platformUserId: '9002' },
      ],
    });

    const result = await service.deliver();

    expect(bots.primaryFor).toHaveBeenCalledTimes(1);
    expect(bots.client).toHaveBeenCalledTimes(1);
    expect(outcomes.recordOutcome).toHaveBeenCalledTimes(2);
    expect(result.sent).toBe(2);
  });

  it('claims nothing more and reads nothing when no row is due', async () => {
    const { db, service } = fakes({ rows: [] });

    expect(await service.deliver()).toEqual({ claimed: 0, sent: 0, failed: 0, deferred: 0, stalled: 0 });
    expect(db.notificationCampaign.findMany).not.toHaveBeenCalled();
  });
});

describe('CampaignDeliveryService.deliver — SMS (F-035-f, D-38)', () => {
  const PHONE = '+989121112233';
  const ownUser = (overrides: Record<string, unknown> = {}) => ({
    id: id(1),
    tenantId: OWNER_TENANT,
    phoneNumber: PHONE,
    phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
  const smsFakes = (overrides: Parameters<typeof fakes>[0] = {}) =>
    fakes({ channel: NotificationChannel.sms, campaignTenant: OWNER_TENANT, users: [ownUser()] as never, links: [], ...overrides });

  it("sends the platform owner's own campaign to its user's verified phone, on the platform line (invariant 10)", async () => {
    const { outcomes, smsSend, sendText, service } = smsFakes();

    const result = await service.deliver();

    expect(smsSend).toHaveBeenCalledWith(PHONE, 'Hello <b>you</b>');
    expect(sendText).not.toHaveBeenCalled();
    expect(outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.sent);
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, deferred: 0, stalled: 0 });
  });

  it.each([
    ["a reseller's campaign", { campaignTenant: TENANT, users: [ownUser({ tenantId: TENANT })] }],
    ['a platform-wide campaign', { campaignTenant: null }],
    ["a reseller's user, even in the owner's campaign", { users: [ownUser({ tenantId: TENANT })] }],
    ['a phone never verified', { users: [ownUser({ phoneVerifiedAt: null })] }],
    ['no phone at all', { users: [ownUser({ phoneNumber: null })] }],
    ['no platform owner on record', { owner: null }],
  ])('fails, and sends nothing for, %s', async (_why, overrides) => {
    const { outcomes, smsSend, service } = smsFakes(overrides as never);

    const result = await service.deliver();

    expect(smsSend).not.toHaveBeenCalled();
    expect(outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.failed);
    expect(result.failed).toBe(1);
  });

  it('fails a number the provider refuses, and leaves a network error queued for the next run', async () => {
    const refused = smsFakes({ smsSend: vi.fn().mockResolvedValue({ status: 'refused', description: 'InvalidReceiverNumber' }) });
    expect((await refused.service.deliver()).failed).toBe(1);
    expect(refused.outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.failed);

    const flaky = smsFakes({ smsSend: vi.fn().mockResolvedValue({ status: 'retry', description: 'ETIMEDOUT' }) });
    expect(await flaky.service.deliver()).toEqual({ claimed: 1, sent: 0, failed: 0, deferred: 1, stalled: 0 });
    expect(flaky.outcomes.recordOutcome).not.toHaveBeenCalled();
    expect(flaky.db.notificationCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [id(101)] }, deliveryStatus: DeliveryStatus.queued },
      data: { claimedUntil: null },
    });
  });

  it('stalls every SMS row when the line is unset or the provider refuses the account, sending no more that run', async () => {
    const unset = smsFakes({ smsLine: false });
    expect((await unset.service.deliver()).stalled).toBe(1);
    expect(unset.outcomes.recordOutcome).not.toHaveBeenCalled();

    const smsSend = vi.fn().mockResolvedValue({ status: 'line_down', description: 'NotEnoughCredit' });
    const down = smsFakes({
      rows: [
        { id: id(101), campaignId: CAMPAIGN, userId: id(1) },
        { id: id(102), campaignId: CAMPAIGN, userId: id(2) },
      ],
      users: [ownUser(), ownUser({ id: id(2) })] as never,
      smsSend,
    });
    expect(await down.service.deliver()).toEqual({ claimed: 2, sent: 0, failed: 0, deferred: 0, stalled: 2 });
    expect(smsSend).toHaveBeenCalledTimes(1);
    expect(down.outcomes.recordOutcome).not.toHaveBeenCalled();
  });
});

describe('CampaignDeliveryService.deliver — the recipient\'s language (F-035-h)', () => {
  it("sends the text published in the user's language, and the source to anyone else — never a draft", async () => {
    const texts = [{ campaignId: CAMPAIGN, lang: 'en', subject: null, body: 'Hi in English' }];
    const english = fakes({ users: [{ id: id(1), tenantId: TENANT, languagePreference: 'en' }] as never, texts });
    await english.service.deliver();
    expect(english.sendText).toHaveBeenCalledWith('9001', 'Hi in English');
    expect(english.db.notificationCampaignText.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: { in: [CAMPAIGN] }, state: 'published' } }),
    );

    const persian = fakes({ users: [{ id: id(1), tenantId: TENANT, languagePreference: 'fa' }] as never, texts });
    await persian.service.deliver();
    expect(persian.sendText).toHaveBeenCalledWith('9001', 'Hello <b>you</b>');
  });
});

describe('CampaignDeliveryService.deliver — email (F-035-h, D-38)', () => {
  const ADDRESS = 'user@example.com';
  const ownUser = (overrides: Record<string, unknown> = {}) => ({
    id: id(1),
    tenantId: OWNER_TENANT,
    languagePreference: 'fa',
    email: ADDRESS,
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
  const mailFakes = (overrides: Parameters<typeof fakes>[0] = {}) =>
    fakes({ channel: NotificationChannel.email, campaignTenant: OWNER_TENANT, users: [ownUser()] as never, links: [], ...overrides });

  it("mails the platform owner's own campaign to its user's verified address, with the stored subject (invariant 10)", async () => {
    const { mailSend, smsSend, outcomes, service } = mailFakes({ subject: 'Sale' });

    expect(await service.deliver()).toEqual({ claimed: 1, sent: 1, failed: 0, deferred: 0, stalled: 0 });
    expect(mailSend).toHaveBeenCalledWith(ADDRESS, { subject: 'Sale', body: 'Hello <b>you</b>' });
    expect(smsSend).not.toHaveBeenCalled();
    expect(outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.sent);
  });

  it("uses the translated default subject in the language of the body it sends", async () => {
    const texts = [{ campaignId: CAMPAIGN, lang: 'en', subject: null, body: 'Hi' }];
    const { mailSend, service } = mailFakes({ subject: 'فروش ویژه', users: [ownUser({ languagePreference: 'en' })] as never, texts });
    await service.deliver();
    expect(mailSend).toHaveBeenCalledWith(ADDRESS, { subject: 'subject:en', body: 'Hi' });

    const source = mailFakes();
    await source.service.deliver();
    expect(source.mailSend).toHaveBeenCalledWith(ADDRESS, { subject: 'subject:fa', body: 'Hello <b>you</b>' });
  });

  it.each([
    ["a reseller's campaign", { campaignTenant: TENANT, users: [ownUser({ tenantId: TENANT })] }],
    ['a platform-wide campaign', { campaignTenant: null }],
    ['an address never verified', { users: [ownUser({ emailVerifiedAt: null })] }],
    ['no address at all', { users: [ownUser({ email: null })] }],
  ])('fails, and mails nothing for, %s', async (_why, overrides) => {
    const { outcomes, mailSend, service } = mailFakes(overrides as never);

    expect((await service.deliver()).failed).toBe(1);
    expect(mailSend).not.toHaveBeenCalled();
    expect(outcomes.recordOutcome).toHaveBeenCalledWith(id(101), DeliveryStatus.failed);
  });

  it('stalls every email row when the server is unset or refuses the account, and leaves a transport error queued', async () => {
    expect((await mailFakes({ mailLine: false }).service.deliver()).stalled).toBe(1);

    const mailSend = vi.fn().mockResolvedValue({ status: 'line_down', description: '535 auth' });
    const down = mailFakes({
      rows: [
        { id: id(101), campaignId: CAMPAIGN, userId: id(1) },
        { id: id(102), campaignId: CAMPAIGN, userId: id(2) },
      ],
      users: [ownUser(), ownUser({ id: id(2) })] as never,
      mailSend,
    });
    expect(await down.service.deliver()).toEqual({ claimed: 2, sent: 0, failed: 0, deferred: 0, stalled: 2 });
    expect(mailSend).toHaveBeenCalledTimes(1);

    const flaky = mailFakes({ mailSend: vi.fn().mockResolvedValue({ status: 'retry', description: 'ETIMEDOUT' }) });
    expect((await flaky.service.deliver()).deferred).toBe(1);
    expect(flaky.outcomes.recordOutcome).not.toHaveBeenCalled();
  });
});

describe('platformMailLine', () => {
  const line = (answer: unknown) => {
    const provider = { sendMail: vi.fn().mockResolvedValue(answer) };
    return { provider, line: platformMailLine(provider as never) };
  };

  it('sends the subject and the body as plain text', async () => {
    const { provider, line: mail } = line({ ok: true, msg: 'mail sent', data: true });
    expect(await mail.send('a@b.c', { subject: 'S', body: 'B' })).toEqual({ status: 'sent' });
    expect(provider.sendMail).toHaveBeenCalledWith({ to: 'a@b.c', subject: 'S', text: 'B' });
  });

  it("reads a refused mailbox as final, the account refused as the line down, and anything else as retry", async () => {
    const m = { subject: 'S', body: 'B' };
    expect(await line({ ok: false, msg: 'mail recipient refused', error: '550' }).line.send('a', m)).toMatchObject({ status: 'refused' });
    expect(await line({ ok: false, msg: 'mail account refused', error: '535' }).line.send('a', m)).toMatchObject({ status: 'line_down' });
    expect(await line({ ok: false, msg: 'mail failed to send', error: 'ECONNRESET' }).line.send('a', m)).toMatchObject({ status: 'retry' });
  });
});

describe('platformSmsLine', () => {
  const line = (answer: unknown) => {
    const provider = { sendSMS: vi.fn().mockResolvedValue(answer) };
    return { provider, line: platformSmsLine(provider as never, '3000') };
  };

  it('sends the text as is, from the configured sender', async () => {
    const { provider, line: sms } = line({ ok: true, msg: 'SMS sent Successfuly', data: true });
    expect(await sms.send('+989121112233', 'Hi {{name}}')).toEqual({ status: 'sent' });
    expect(provider.sendSMS).toHaveBeenCalledWith({ msg: 'Hi {{name}}', to: '+989121112233' }, '3000');
  });

  it('reads a bad number as final, a transport failure as retry, and any other refusal as the line being down', async () => {
    expect(await line({ ok: false, msg: 'InvalidReceiverNumber', error: null }).line.send('1', 'x')).toMatchObject({ status: 'refused' });
    expect(await line({ ok: false, msg: 'SMS failed to sent', error: new Error('ETIMEDOUT') }).line.send('1', 'x')).toMatchObject({
      status: 'retry',
    });
    expect(await line({ ok: false, msg: 'UserNameOrPasswordIsWrong', error: null }).line.send('1', 'x')).toMatchObject({
      status: 'line_down',
    });
  });
});
