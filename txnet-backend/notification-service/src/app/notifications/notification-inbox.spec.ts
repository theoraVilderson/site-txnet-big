/**
 * A user's notification inbox (F-035-a).
 *
 * What would break silently here, and nowhere else:
 *  - **whose rows.** `notification` carries no `tenantId`, so Row-Level Security
 *    has nothing to bind and no policy stands behind this service. The gate's
 *    `userId` in every `where` is the whole of the isolation — a query that
 *    dropped it answers every user's inbox, and nothing else turns red;
 *  - **mark read rewrites nothing.** `readAt` is when the user first saw it. A
 *    second press, or "mark all" over a page that was half read, must leave the
 *    earlier instants alone — so the update filters on `readAt: null`, and
 *    another user's id in the list matches no row rather than an error that
 *    confirms it exists;
 *  - **the unread count is the user's, not the page's.** The badge shows it,
 *    and a count taken from the filtered page would read zero on page two.
 */
import { NotificationType } from '@prisma/client';

import { NotificationInboxService } from './notification-inbox.service';

const USER = '44444444-4444-4444-8444-444444444444';
const N1 = '66666666-6666-4666-8666-666666666666';
const N2 = '77777777-7777-4777-8777-777777777777';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: N1,
    userId: USER,
    type: NotificationType.low_balance,
    title: 'Low balance',
    body: 'Your wallet is below 1.00',
    readAt: null,
    createdAt: new Date('2026-09-17T10:00:00Z'),
    ...overrides,
  };
}

function fakePrisma() {
  const notification = {
    findMany: vi.fn().mockResolvedValue([row()]),
    count: vi.fn().mockResolvedValue(3),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    create: vi.fn().mockImplementation(({ data }) => Promise.resolve(row(data))),
  };
  return { notification, $transaction: (ops: Promise<unknown>[]) => Promise.all(ops) };
}

describe('NotificationInboxService', () => {
  it('reads only the caller\'s rows, newest first, and counts unread over the whole inbox', async () => {
    const prisma = fakePrisma();
    const inbox = new NotificationInboxService(prisma as never);

    const page = await inbox.page({ userId: USER, page: 2, pageSize: 10, unreadOnly: true });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER, readAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 10,
        take: 10,
      }),
    );
    // The badge's number: never narrowed by the page, the filter or the size.
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { userId: USER, readAt: null } });
    expect(page).toMatchObject({ page: 2, pageSize: 10, unreadCount: 3 });
    expect(page.items[0]).toEqual({
      id: N1,
      type: 'low_balance',
      title: 'Low balance',
      body: 'Your wallet is below 1.00',
      readAt: null,
      createdAt: '2026-09-17T10:00:00.000Z',
    });
    expect(page.items[0]).not.toHaveProperty('userId');
  });

  it('defaults to the first page of 20 and every row, read or not', async () => {
    const prisma = fakePrisma();
    const inbox = new NotificationInboxService(prisma as never);

    await inbox.page({ userId: USER });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER }, skip: 0, take: 20 }),
    );
  });

  it('marks named rows read only when they are the caller\'s and still unread', async () => {
    const prisma = fakePrisma();
    prisma.notification.count.mockResolvedValue(2);
    const inbox = new NotificationInboxService(prisma as never);
    const now = new Date('2026-09-17T12:00:00Z');

    const result = await inbox.markRead({ userId: USER, ids: [N1, N2] }, now);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, readAt: null, id: { in: [N1, N2] } },
      data: { readAt: now },
    });
    expect(result).toEqual({ marked: 1, unreadCount: 2 });
  });

  it('marks the whole inbox read when no ids are named — still without rewriting a read row', async () => {
    const prisma = fakePrisma();
    const inbox = new NotificationInboxService(prisma as never);
    const now = new Date('2026-09-17T12:00:00Z');

    await inbox.markRead({ userId: USER }, now);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, readAt: null },
      data: { readAt: now },
    });
  });

  it('creates an unread row for the named user', async () => {
    const prisma = fakePrisma();
    const inbox = new NotificationInboxService(prisma as never);

    const created = await inbox.create({
      userId: USER,
      type: NotificationType.system_alert,
      title: 'Maintenance',
      body: 'Tonight 02:00–03:00',
    });

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { userId: USER, type: 'system_alert', title: 'Maintenance', body: 'Tonight 02:00–03:00' },
    });
    expect(created).toMatchObject({ type: 'system_alert', readAt: null });
  });
});
