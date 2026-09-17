import { Injectable } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * A user's in-app notifications (F-035-a): the page the panel's dropdown reads,
 * the unread count its badge shows, marking read, and the one write other
 * processes reach through the internal seam.
 *
 * **The `userId` is the isolation, and there is nothing behind it.**
 * `notification` has no `tenantId` — a row belongs to a user, and a user to a
 * tenant — so it is not a `TENANT_SCOPED_MODELS` entry and no RLS policy binds
 * it. Every read and write below is filtered by the caller's id from the gate
 * (`request/identity.middleware.ts`), never by an id from the body or query.
 *
 * **`readAt` is written once.** It is when the user first saw the row, so a
 * mark-read only ever touches rows still `null` — a repeated press, or "mark
 * all" over a half-read inbox, keeps the earlier instants.
 */

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;

export type InboxPageRequest = {
  /** From the gate's `X-User-Id`. */
  userId: string;
  page?: number;
  pageSize?: number;
  unreadOnly?: boolean;
};

export type InboxItem = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

export type InboxPage = {
  items: InboxItem[];
  page: number;
  pageSize: number;
  total: number;
  /** Over the whole inbox, whatever the page or filter — it is the badge's number. */
  unreadCount: number;
};

export type MarkReadRequest = {
  userId: string;
  /** Absent marks every unread row the user has. */
  ids?: readonly string[];
};

export type CreateNotification = {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
};

type NotificationRow = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class NotificationInboxService {
  constructor(private readonly prisma: PrismaService) {}

  async page(request: InboxPageRequest): Promise<InboxPage> {
    const page = request.page ?? DEFAULT_PAGE;
    const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.NotificationWhereInput = request.unreadOnly
      ? { userId: request.userId, readAt: null }
      : { userId: request.userId };

    const [rows, total, unreadCount] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        // `id` breaks a tie, so two rows written in the same millisecond keep
        // one order across pages instead of appearing on both or on neither.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.unread(request.userId),
    ]);

    return { items: rows.map(toItem), page, pageSize, total, unreadCount };
  }

  async markRead(request: MarkReadRequest, now: Date = new Date()): Promise<{ marked: number; unreadCount: number }> {
    const where: Prisma.NotificationWhereInput = { userId: request.userId, readAt: null };
    if (request.ids) where.id = { in: [...request.ids] };

    // Another user's id matches no row: the answer is the same `marked` as an
    // id that never existed, so the route cannot be used to probe for one.
    const { count } = await this.prisma.notification.updateMany({ where, data: { readAt: now } });
    return { marked: count, unreadCount: await this.unread(request.userId) };
  }

  async create(input: CreateNotification): Promise<InboxItem> {
    const row = await this.prisma.notification.create({
      data: { userId: input.userId, type: input.type, title: input.title, body: input.body },
    });
    return toItem(row);
  }

  private unread(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }
}

/** The wire shape: no `userId` — the caller already knows whose inbox it asked for. */
function toItem(row: NotificationRow): InboxItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
