/**
 * Sending a campaign (F-035-d): the fan-out that writes one recipient row per
 * user, and the outcome that moves one.
 *
 * What would break silently here, and nowhere else:
 *  - **a tenant's campaign reaches only that tenant's users** (invariant 1).
 *    The fan-out runs on the cross-tenant pool, so RLS does not stand behind
 *    it — the `tenantId` in the user query is the whole guard, and a query
 *    without it would still return plausible rows;
 *  - **a re-run writes nothing twice** (invariant 4). Delivery of a tick is
 *    at-least-once, so the batch insert skips duplicates, the cursor moves in
 *    the batch's own transaction, and an outcome only moves a `queued` row;
 *  - **the counts are the rows** (invariant 2). A counter moves in the same
 *    transaction as the one row it counts, and only when that row moved;
 *  - **the audience is the stored filter, read again, as of the send.** A user
 *    registered after `sendStartedAt` is not a recipient, and a stored filter
 *    that no longer parses sends to nobody rather than to everybody.
 */
import { CampaignStatus, DeliveryStatus, Prisma, UserStatus } from '@prisma/client';

import { CampaignFanOutService, audienceWhere } from './campaign-fan-out.service';

const TENANT = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';
const RECIPIENT = '66666666-6666-4666-8666-666666666666';
const STARTED = new Date('2026-09-17T12:00:00Z');

const userId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN,
    tenantId: TENANT,
    filterCriteria: {},
    sendStartedAt: STARTED,
    fanOutCursor: null,
    ...overrides,
  };
}

/** The cross-tenant pool, minus the database; `$transaction` runs its body on the same fakes. */
function fakes(users: string[], campaigns = [campaign()]) {
  const db = {
    notificationCampaign: {
      findMany: vi.fn().mockResolvedValue(campaigns),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    notificationCampaignRecipient: {
      createMany: vi.fn().mockImplementation(({ data }) => Promise.resolve({ count: data.length })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ campaignId: CAMPAIGN }),
      count: vi.fn().mockResolvedValue(1),
    },
    user: {
      // Keyset paging as the database does it: ids after the cursor, in order.
      findMany: vi.fn().mockImplementation(({ where, take }) => {
        const after = where.AND.find((c: { id?: { gt: string } }) => c.id)?.id.gt;
        const page = users.filter((id) => !after || id > after).slice(0, take);
        return Promise.resolve(page.map((id) => ({ id })));
      }),
    },
  } as Record<string, any>;
  db['$transaction'] = vi.fn((body: (tx: unknown) => Promise<unknown>) => body(db));
  return { db, service: new CampaignFanOutService(db as never, { batchSize: 2 }) };
}

describe('audienceWhere', () => {
  it('confines a tenant campaign to its tenant, and a platform-wide one to no tenant (invariant 1)', () => {
    const scoped = audienceWhere({ tenantId: TENANT, sendStartedAt: STARTED }, {});
    expect(scoped.AND).toContainEqual({ tenantId: TENANT });

    const platform = audienceWhere({ tenantId: null, sendStartedAt: STARTED }, {});
    expect(JSON.stringify(platform)).not.toContain('tenantId');
  });

  it('means active, undeleted users registered before the send when the filter is empty', () => {
    const where = audienceWhere({ tenantId: TENANT, sendStartedAt: STARTED }, {});
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { status: { in: [UserStatus.active] } },
        { deletedAt: null },
        { createdAt: { lte: STARTED } },
      ]),
    );
  });

  it('translates every key of the closed shape, and a missing wallet counts as 0', () => {
    const where = audienceWhere(
      { tenantId: TENANT, sendStartedAt: STARTED },
      {
        statuses: [UserStatus.suspended],
        languages: ['en'],
        registeredFrom: '2026-01-01T00:00:00Z',
        registeredTo: '2026-06-01T00:00:00Z',
        minBalance: '0',
        maxBalance: '100.50',
      },
    );
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { status: { in: [UserStatus.suspended] } },
        { languagePreference: { in: ['en'] } },
        { createdAt: { gte: new Date('2026-01-01T00:00:00Z') } },
        { createdAt: { lt: new Date('2026-06-01T00:00:00Z') } },
        { OR: [{ wallet: { is: null } }, { wallet: { is: { cachedBalance: { gte: new Prisma.Decimal('0') } } } }] },
        { OR: [{ wallet: { is: null } }, { wallet: { is: { cachedBalance: { lte: new Prisma.Decimal('100.50') } } } }] },
      ]),
    );

    // Above zero, a user with no wallet is below the minimum.
    const rich = audienceWhere({ tenantId: TENANT, sendStartedAt: STARTED }, { minBalance: '10' });
    expect(rich.AND).toContainEqual({ wallet: { is: { cachedBalance: { gte: new Prisma.Decimal('10') } } } });
  });
});

describe('CampaignFanOutService.fanOut', () => {
  it('writes one queued row per user in batches, moving the cursor with each batch, then marks the fan-out done', async () => {
    const { db, service } = fakes([userId(1), userId(2), userId(3)]);

    const result = await service.fanOut();

    expect(db.notificationCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: CampaignStatus.sending, fannedOutAt: null } }),
    );
    expect(db.notificationCampaignRecipient.createMany.mock.calls.map(([a]) => a)).toEqual([
      { data: [{ campaignId: CAMPAIGN, userId: userId(1) }, { campaignId: CAMPAIGN, userId: userId(2) }], skipDuplicates: true },
      { data: [{ campaignId: CAMPAIGN, userId: userId(3) }], skipDuplicates: true },
    ]);
    const cursors = db.notificationCampaign.updateMany.mock.calls.map(([a]) => a);
    expect(cursors[0]).toEqual({
      where: { id: CAMPAIGN, status: CampaignStatus.sending, fannedOutAt: null },
      data: { fanOutCursor: userId(2) },
    });
    expect(cursors[1]).toEqual({
      where: { id: CAMPAIGN, status: CampaignStatus.sending, fannedOutAt: null },
      data: { fanOutCursor: userId(3), fannedOutAt: expect.any(Date) },
    });
    expect(result).toEqual({ campaigns: 1, recipients: 3, finished: 1, unreadable: 0 });
  });

  it('resumes after the committed cursor, and a replayed batch inserts nothing new (invariant 4)', async () => {
    const { db, service } = fakes([userId(1), userId(2), userId(3)], [campaign({ fanOutCursor: userId(2) })]);

    await service.fanOut();

    const firstQuery = db.user.findMany.mock.calls[0][0];
    expect(firstQuery.where.AND).toContainEqual({ id: { gt: userId(2) } });
    expect(firstQuery.orderBy).toEqual({ id: 'asc' });
    expect(db.notificationCampaignRecipient.createMany).toHaveBeenCalledTimes(1);
    for (const [args] of db.notificationCampaignRecipient.createMany.mock.calls) expect(args.skipDuplicates).toBe(true);
  });

  it('stops at its budget without marking the fan-out done, so the next tick carries on', async () => {
    const { db, service } = fakes([userId(1), userId(2), userId(3), userId(4), userId(5)]);

    const result = await service.fanOut({ budget: 2 });

    expect(result).toEqual({ campaigns: 1, recipients: 2, finished: 0, unreadable: 0 });
    for (const [args] of db.notificationCampaign.updateMany.mock.calls) expect(args.data.fannedOutAt).toBeUndefined();
  });

  it('completes a campaign whose audience is empty, since nothing is left to deliver', async () => {
    const { db, service } = fakes([]);
    db.notificationCampaignRecipient.count.mockResolvedValue(0);

    await service.fanOut();

    expect(db.notificationCampaignRecipient.createMany).not.toHaveBeenCalled();
    expect(db.notificationCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN, status: CampaignStatus.sending, fannedOutAt: { not: null } },
      data: { status: CampaignStatus.completed },
    });
  });

  it('sends a stored filter that no longer parses to nobody, and says so', async () => {
    const { db, service } = fakes([userId(1)], [campaign({ filterCriteria: { lastConfigDays: { gt: 30 } } })]);

    const result = await service.fanOut();

    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.notificationCampaignRecipient.createMany).not.toHaveBeenCalled();
    expect(result.unreadable).toBe(1);
  });
});

describe('CampaignFanOutService.recordOutcome', () => {
  it('moves a queued row and its counter in one transaction (invariants 2 and 4)', async () => {
    const { db, service } = fakes([]);

    await expect(service.recordOutcome(RECIPIENT, DeliveryStatus.sent)).resolves.toEqual({ changed: true });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.notificationCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: RECIPIENT, deliveryStatus: DeliveryStatus.queued },
      data: { deliveryStatus: DeliveryStatus.sent },
    });
    expect(db.notificationCampaign.update).toHaveBeenCalledWith({
      where: { id: CAMPAIGN },
      data: { sentCount: { increment: 1 } },
    });
  });

  it('counts nothing for a row that already moved, so a redelivered outcome is not counted twice', async () => {
    const { db, service } = fakes([]);
    db.notificationCampaignRecipient.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.recordOutcome(RECIPIENT, DeliveryStatus.failed)).resolves.toEqual({ changed: false });

    expect(db.notificationCampaign.update).not.toHaveBeenCalled();
  });

  it('refuses to put a row back to queued', async () => {
    const { service } = fakes([]);
    await expect(service.recordOutcome(RECIPIENT, DeliveryStatus.queued as never)).rejects.toThrow(/queued/);
  });

  it('completes the campaign when its last queued row moves', async () => {
    const { db, service } = fakes([]);
    db.notificationCampaignRecipient.count.mockResolvedValue(0);

    await service.recordOutcome(RECIPIENT, DeliveryStatus.failed);

    expect(db.notificationCampaign.update).toHaveBeenCalledWith({ where: { id: CAMPAIGN }, data: { failedCount: { increment: 1 } } });
    expect(db.notificationCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: CAMPAIGN, status: CampaignStatus.sending, fannedOutAt: { not: null } },
      data: { status: CampaignStatus.completed },
    });
  });

  it('answers a recipient that does not exist as not found', async () => {
    const { db, service } = fakes([]);
    db.notificationCampaignRecipient.findUnique.mockResolvedValue(null);
    await expect(service.recordOutcome(RECIPIENT, DeliveryStatus.sent)).rejects.toMatchObject({ reason: 'recipient_not_found' });
  });
});
