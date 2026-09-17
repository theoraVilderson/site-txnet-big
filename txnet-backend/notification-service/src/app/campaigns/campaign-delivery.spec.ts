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
 *  - **a counter moves only through `recordOutcome`** (invariant 2).
 */
import { DeliveryStatus, NotificationChannel } from '@prisma/client';

import { CHANNEL_PLATFORM, CampaignDeliveryService, DELIVERY_CALLER } from './campaign-delivery.service';

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
} = {}) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(rows),
    notificationCampaign: {
      findMany: vi.fn().mockResolvedValue([{ id: CAMPAIGN, channel, messageBody: 'Hello <b>you</b>' }]),
    },
    user: { findMany: vi.fn().mockResolvedValue(users) },
    linkedBotAccount: { findMany: vi.fn().mockResolvedValue(links) },
    notificationCampaignRecipient: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const bots = {
    primaryFor: primary,
    client: vi.fn().mockResolvedValue(client ? { sendText } : null),
  };
  const outcomes = { recordOutcome: vi.fn().mockResolvedValue({ changed: true }) };
  const service = new CampaignDeliveryService(db as never, bots as never, outcomes as never, { now: () => NOW });
  return { db, bots, outcomes, sendText, service };
}

describe('CHANNEL_PLATFORM', () => {
  it('sends the two bot channels through messenger and leaves the rest to F-035-f', () => {
    expect(CHANNEL_PLATFORM).toEqual({ telegram_bot: 'telegram', bale_bot: 'bale', push: null, sms: null });
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
    expect(sql.values).toEqual(expect.arrayContaining(['telegram_bot', 'bale_bot']));
    expect(sql.values).not.toContain('sms');
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
